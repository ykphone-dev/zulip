from typing import Any

from zerver.actions.user_settings import do_change_user_setting
from zerver.actions.user_topics import do_set_user_topic_visibility_policy
from zerver.lib.test_classes import ZulipTestCase
from zerver.models import UserProfile, UserTopic
from zerver.models.streams import get_stream

NEVER = UserProfile.AUTOMATICALLY_CHANGE_VISIBILITY_POLICY_NEVER


class ThreadFollowTest(ZulipTestCase):
    def use_fork_defaults(self, *users: UserProfile) -> None:
        for user in users:
            do_change_user_setting(
                user, "automatically_follow_topics_policy", NEVER, acting_user=None
            )
            do_change_user_setting(
                user, "automatically_follow_topics_where_mentioned", False, acting_user=None
            )

    def followed(self, user: UserProfile) -> list[str]:
        return sorted(
            UserTopic.objects.filter(
                user_profile=user, visibility_policy=UserTopic.VisibilityPolicy.FOLLOWED
            ).values_list("topic_name", flat=True)
        )

    def start_thread(self, user: UserProfile, root_id: int) -> str:
        result: Any = self.api_post(user, "/api/v1/ykphone/threads", {"message_id": root_id})
        return self.assert_json_success(result)["topic_name"]

    def test_threads_are_the_followed_topics(self) -> None:
        hamlet = self.example_user("hamlet")
        othello = self.example_user("othello")
        cordelia = self.example_user("cordelia")
        self.use_fork_defaults(hamlet, othello, cordelia)
        for user in (hamlet, othello, cordelia):
            self.subscribe(user, "Verona")

        # Posting in general chat, and being mentioned there, follows nothing.
        root_id = self.send_stream_message(
            othello, "Verona", "the plan @**Cordelia, Lear's daughter**", ""
        )
        self.assertEqual(self.followed(othello), [])
        self.assertEqual(self.followed(cordelia), [])

        # Starting a thread follows it for the starter and the root's author.
        topic_name = self.start_thread(hamlet, root_id)
        self.assertEqual(self.followed(hamlet), [topic_name])
        self.assertEqual(self.followed(othello), [topic_name])
        self.assertEqual(self.followed(cordelia), [])

        # Replying follows it; a topic that is not a thread does not.
        self.send_stream_message(cordelia, "Verona", "count me in", topic_name)
        self.send_stream_message(cordelia, "Verona", "plain topic", "not a thread")
        self.assertEqual(self.followed(cordelia), [topic_name])

    def test_choices_are_kept(self) -> None:
        hamlet = self.example_user("hamlet")
        othello = self.example_user("othello")
        self.use_fork_defaults(hamlet, othello)
        root_id = self.send_stream_message(othello, "Verona", "root", "")
        # Othello muted the thread beforehand: it stays muted.
        topic_name = self.start_thread(hamlet, root_id)
        do_set_user_topic_visibility_policy(
            othello,
            get_stream("Verona", othello.realm),
            topic_name,
            visibility_policy=UserTopic.VisibilityPolicy.MUTED,
        )
        self.send_stream_message(othello, "Verona", "reply", topic_name)
        self.assertEqual(
            UserTopic.objects.get(user_profile=othello, topic_name=topic_name).visibility_policy,
            UserTopic.VisibilityPolicy.MUTED,
        )

    def test_zulip_defaults_are_left_to_zulip(self) -> None:
        # Users whose automatic following is Zulip's are followed by Zulip.
        hamlet = self.example_user("hamlet")
        othello = self.example_user("othello")
        for user in (hamlet, othello):
            do_change_user_setting(
                user,
                "automatically_follow_topics_policy",
                UserProfile.AUTOMATICALLY_CHANGE_VISIBILITY_POLICY_ON_INITIATION,
                acting_user=None,
            )
        root_id = self.send_stream_message(othello, "Verona", "root", "")
        before = self.followed(othello)
        topic_name = self.start_thread(hamlet, root_id)
        self.assertEqual(self.followed(othello), before)
        self.assertNotIn(topic_name, self.followed(hamlet))
