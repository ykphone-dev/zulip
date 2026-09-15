from typing import Any
from unittest import mock

import orjson

from ykphone.lib.threads import get_or_create_thread, thread_topic_snippet
from ykphone.models import MessageThread
from zerver.actions.streams import do_set_stream_property
from zerver.lib.message import access_message
from zerver.lib.test_classes import ZulipTestCase
from zerver.models import Message
from zerver.models.streams import StreamTopicsPolicyEnum, get_stream


class ThreadTopicSnippetTest(ZulipTestCase):
    def test_snippet(self) -> None:
        self.assertEqual(thread_topic_snippet("Hello **world**"), "Hello world")
        self.assertEqual(thread_topic_snippet("> quoted\nreal line"), "real line")
        self.assertEqual(thread_topic_snippet("```\ncode\n```"), "code")
        self.assertEqual(
            thread_topic_snippet("@_**김선진|146** [말함](https://x.test) :white_check_mark:"),
            "김선진 말함 :white_check_mark:",
        )
        self.assertEqual(thread_topic_snippet("   \n  "), "Thread")
        long = "가" * 80
        snippet = thread_topic_snippet(long)
        self.assert_length(snippet, 50)
        self.assertTrue(snippet.endswith("…"))


class ThreadAPITest(ZulipTestCase):
    def create(self, user_name: str, message_id: int) -> Any:
        return self.api_post(
            self.example_user(user_name),
            "/api/v1/ykphone/threads",
            {"message_id": message_id},
        )

    def list_threads(self, user_name: str, stream_id: int) -> Any:
        return self.api_get(
            self.example_user(user_name),
            "/api/v1/ykphone/threads",
            {"stream_id": stream_id},
        )

    def test_create_and_list(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        verona = get_stream("Verona", hamlet.realm)
        root_id = self.send_stream_message(hamlet, "Verona", "Shall we ship on Friday?", "")

        result = self.create("cordelia", root_id)
        data = self.assert_json_success(result)
        self.assertEqual(data["root_message_id"], root_id)
        self.assertEqual(data["stream_id"], verona.id)
        self.assertEqual(data["topic_name"], "Shall we ship on Friday?")
        self.assertEqual(data["reply_count"], 0)
        self.assertIsNone(data["last_reply_timestamp"])
        self.assertEqual(data["participant_user_ids"], [])

        # Opening the thread again is idempotent.
        again = self.assert_json_success(self.create("hamlet", root_id))
        self.assertEqual(again["topic_name"], data["topic_name"])
        self.assertEqual(MessageThread.objects.filter(root_message_id=root_id).count(), 1)

        reply_id = self.send_stream_message(cordelia, "Verona", "Yes", data["topic_name"])
        self.send_stream_message(hamlet, "Verona", "Great", data["topic_name"])
        reply = Message.objects.get(id=reply_id)

        listed = self.assert_json_success(self.list_threads("hamlet", verona.id))["threads"]
        self.assert_length(listed, 1)
        self.assertEqual(listed[0]["root_message_id"], root_id)
        self.assertEqual(listed[0]["reply_count"], 2)
        self.assertGreaterEqual(listed[0]["last_reply_timestamp"], int(reply.date_sent.timestamp()))
        # Newest reply's sender first, each sender once.
        self.assertEqual(listed[0]["participant_user_ids"], [hamlet.id, cordelia.id])
        self.send_stream_message(cordelia, "Verona", "Again", data["topic_name"])
        self.send_stream_message(self.example_user("iago"), "Verona", "Ok", data["topic_name"])
        self.send_stream_message(self.example_user("othello"), "Verona", "!", data["topic_name"])
        listed = self.assert_json_success(self.list_threads("hamlet", verona.id))["threads"]
        self.assertEqual(
            listed[0]["participant_user_ids"],
            [self.example_user("othello").id, self.example_user("iago").id, cordelia.id],
        )
        again = self.assert_json_success(self.create("hamlet", root_id))
        self.assertEqual(again["participant_user_ids"], listed[0]["participant_user_ids"])

        # A second root whose snippet collides gets a numbered name.
        other_root = self.send_stream_message(hamlet, "Verona", "Shall we ship on Friday?", "")
        other = self.assert_json_success(self.create("hamlet", other_root))
        self.assertEqual(other["topic_name"], "Shall we ship on Friday? (2)")

    def test_snippet_avoids_existing_topic(self) -> None:
        hamlet = self.example_user("hamlet")
        self.send_stream_message(hamlet, "Verona", "unrelated", "Friday plans")
        root_id = self.send_stream_message(hamlet, "Verona", "Friday plans", "")
        data = self.assert_json_success(self.create("hamlet", root_id))
        self.assertEqual(data["topic_name"], "Friday plans (2)")

    def test_root_must_be_a_general_chat_channel_message(self) -> None:
        hamlet = self.example_user("hamlet")
        in_topic = self.send_stream_message(hamlet, "Verona", "hi", "some topic")
        self.assert_json_error(
            self.create("hamlet", in_topic), "This message is already part of a thread."
        )

        dm_id = self.send_personal_message(hamlet, self.example_user("cordelia"), "psst")
        self.assert_json_error(
            self.create("hamlet", dm_id), "Threads can only be started on channel messages."
        )

    def test_channel_without_topics(self) -> None:
        hamlet = self.example_user("hamlet")
        verona = get_stream("Verona", hamlet.realm)
        root_id = self.send_stream_message(hamlet, "Verona", "hi", "")
        do_set_stream_property(
            verona, "topics_policy", StreamTopicsPolicyEnum.empty_topic_only.value, hamlet
        )
        self.assert_json_error(
            self.create("hamlet", root_id), "This channel does not allow threads."
        )

    def test_access_checks(self) -> None:
        hamlet = self.example_user("hamlet")
        # Iago is not subscribed to this fresh private channel, so the
        # state is explicit.
        private = self.make_stream("secret-lab", invite_only=True)
        self.subscribe(hamlet, private.name)
        root_id = self.send_stream_message(hamlet, private.name, "hidden", "")

        self.assert_json_error(self.create("iago", root_id), "Invalid message(s)")
        self.assert_json_error(self.list_threads("iago", private.id), "Invalid channel ID")

        polonius = self.example_user("polonius")
        self.assert_json_error(self.list_threads("polonius", 999999), "Invalid channel ID")
        self.assertEqual(
            orjson.loads(self.list_threads("hamlet", private.id).content)["threads"], []
        )
        assert polonius is not None

    def test_protected_history(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        private = self.make_stream(
            "protected-lab", invite_only=True, history_public_to_subscribers=False
        )
        self.subscribe(hamlet, private.name)
        old_root = self.send_stream_message(hamlet, private.name, "Salary bands for 2026", "")
        old_thread = self.assert_json_success(self.create("hamlet", old_root))
        self.send_stream_message(hamlet, private.name, "first", old_thread["topic_name"])
        self.send_stream_message(hamlet, private.name, "second", old_thread["topic_name"])

        # Cordelia joins later and cannot read the older messages, so the
        # thread name (a snippet of the root) and its count stay hidden.
        self.subscribe(cordelia, private.name)
        self.assertEqual(
            self.assert_json_success(self.list_threads("cordelia", private.id))["threads"], []
        )
        self.assert_json_error(self.create("cordelia", old_root), "Invalid message(s)")

        new_root = self.send_stream_message(hamlet, private.name, "Welcome, Cordelia", "")
        new_thread = self.assert_json_success(self.create("cordelia", new_root))
        self.assertEqual(new_thread["reply_count"], 0)
        listed = self.assert_json_success(self.list_threads("cordelia", private.id))["threads"]
        self.assert_length(listed, 1)
        self.assertEqual(listed[0]["root_message_id"], new_root)

        self.send_stream_message(hamlet, private.name, "hi", new_thread["topic_name"])
        listed = self.assert_json_success(self.list_threads("cordelia", private.id))["threads"]
        self.assertEqual(listed[0]["reply_count"], 1)
        self.assertEqual(
            self.assert_json_success(self.create("cordelia", new_root))["reply_count"], 1
        )

        # Hamlet, who received everything, still sees both threads.
        listed = self.assert_json_success(self.list_threads("hamlet", private.id))["threads"]
        self.assertEqual(
            [(thread["root_message_id"], thread["reply_count"]) for thread in listed],
            [(old_root, 2), (new_root, 1)],
        )

    def test_concurrent_creation(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        verona = get_stream("Verona", hamlet.realm)
        root_id = self.send_stream_message(hamlet, "Verona", "race me", "")

        def access_then_lose_race(*args: Any, **kwargs: Any) -> Message:
            # Another request created the thread while this one was
            # waiting for the row lock.
            message = access_message(*args, **kwargs)
            MessageThread.objects.create(
                realm=verona.realm,
                stream=verona,
                root_message=message,
                topic_name="race me",
                creator=cordelia,
            )
            return message

        with mock.patch("ykphone.lib.threads.access_message", side_effect=access_then_lose_race):
            thread = get_or_create_thread(hamlet, root_id)
        self.assertEqual(thread.creator, cordelia)
        self.assertEqual(MessageThread.objects.filter(root_message_id=root_id).count(), 1)
