from typing import Any
from unittest import mock

import orjson
from typing_extensions import override

from ykphone.lib.threads import get_or_create_thread, thread_topic_snippet
from ykphone.models import MessageThread
from zerver.actions.streams import do_deactivate_stream, do_set_stream_property
from zerver.lib.message import access_message
from zerver.lib.test_classes import ZulipTestCase
from zerver.lib.timestamp import datetime_to_timestamp
from zerver.lib.topic import TOPIC_NAME
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
        # Cordelia started the thread.
        self.assertTrue(data["user_participated"])

        # Opening the thread again is idempotent. Hamlet has neither
        # started the thread nor replied in it, but wrote its root, which
        # counts, as Slack follows a thread for the parent's author.
        again = self.assert_json_success(self.create("hamlet", root_id))
        self.assertEqual(again["topic_name"], data["topic_name"])
        self.assertTrue(again["user_participated"])
        listed = self.assert_json_success(self.list_threads("hamlet", verona.id))["threads"]
        self.assertTrue(listed[0]["user_participated"])
        # Aaron has done none of these.
        self.assertFalse(
            self.assert_json_success(self.create("aaron", root_id))["user_participated"]
        )
        self.assertFalse(
            self.assert_json_success(self.list_threads("aaron", verona.id))["threads"][0][
                "user_participated"
            ]
        )
        self.assertEqual(MessageThread.objects.filter(root_message_id=root_id).count(), 1)

        reply_id = self.send_stream_message(cordelia, "Verona", "Yes", data["topic_name"])
        self.send_stream_message(self.example_user("aaron"), "Verona", "Sure", data["topic_name"])
        self.send_stream_message(hamlet, "Verona", "Great", data["topic_name"])
        reply = Message.objects.get(id=reply_id)

        listed = self.assert_json_success(self.list_threads("hamlet", verona.id))["threads"]
        self.assert_length(listed, 1)
        self.assertEqual(listed[0]["root_message_id"], root_id)
        self.assertEqual(listed[0]["reply_count"], 3)
        self.assertGreaterEqual(listed[0]["last_reply_timestamp"], int(reply.date_sent.timestamp()))
        # Newest reply's sender first, each sender once.
        self.assertEqual(
            listed[0]["participant_user_ids"],
            [hamlet.id, self.example_user("aaron").id, cordelia.id],
        )
        # Replying counts as taking part; Othello has done nothing yet.
        self.assertTrue(
            self.assert_json_success(self.create("aaron", root_id))["user_participated"]
        )
        self.assertTrue(
            self.assert_json_success(self.list_threads("cordelia", verona.id))["threads"][0][
                "user_participated"
            ]
        )
        self.assertFalse(
            self.assert_json_success(self.list_threads("othello", verona.id))["threads"][0][
                "user_participated"
            ]
        )
        self.send_stream_message(cordelia, "Verona", "Again", data["topic_name"])
        self.send_stream_message(self.example_user("iago"), "Verona", "Ok", data["topic_name"])
        self.send_stream_message(self.example_user("othello"), "Verona", "!", data["topic_name"])
        listed = self.assert_json_success(self.list_threads("aaron", verona.id))["threads"]
        self.assertEqual(
            listed[0]["participant_user_ids"],
            [self.example_user("othello").id, self.example_user("iago").id, cordelia.id],
        )
        # Aaron's reply is older than the newest three senders' but
        # still counts.
        self.assertTrue(listed[0]["user_participated"])
        again = self.assert_json_success(self.create("hamlet", root_id))
        self.assertEqual(again["participant_user_ids"], listed[0]["participant_user_ids"])

        # A second root whose snippet collides gets a numbered name.
        other_root = self.send_stream_message(hamlet, "Verona", "Shall we ship on Friday?", "")
        other = self.assert_json_success(self.create("hamlet", other_root))
        self.assertEqual(other["topic_name"], "Shall we ship on Friday? (2)")

    def test_participated_topics(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        # A new channel, so the sample conversations stay out of it.
        verona = self.make_stream("ykphone-lab")
        for user in [hamlet, cordelia, self.example_user("othello")]:
            self.subscribe(user, verona.name)
        # Hamlet posts in a topic another client created, is mentioned in
        # a second one, and neither in a third; general chat and threads
        # are not listed, and each topic is listed once, newest first.
        self.send_stream_message(cordelia, verona.name, "hi", "Mobile topic")
        self.send_stream_message(hamlet, verona.name, "me too", "mobile TOPIC")
        self.send_stream_message(hamlet, verona.name, "again", "Mobile topic")
        self.send_stream_message(cordelia, verona.name, "@**King Hamlet** look", "Mentioned here")
        self.send_stream_message(cordelia, verona.name, "not for hamlet", "Someone else's")
        self.send_stream_message(hamlet, verona.name, "general chat", "")
        root_id = self.send_stream_message(hamlet, verona.name, "Root", "")
        topic = self.assert_json_success(self.create("hamlet", root_id))["topic_name"]
        self.send_stream_message(hamlet, verona.name, "in my thread", topic)

        result = self.assert_json_success(self.list_threads("hamlet", verona.id))
        self.assertEqual(result["participated_topics"], ["Mentioned here", "Mobile topic"])
        self.assertEqual(
            self.assert_json_success(self.list_threads("othello", verona.id))[
                "participated_topics"
            ],
            [],
        )
        with mock.patch("ykphone.lib.threads.MAX_PARTICIPATION_MESSAGES", 1):
            # Only the newest own message (in the thread, left out) and
            # the newest mention are searched.
            self.assertEqual(
                self.assert_json_success(self.list_threads("hamlet", verona.id))[
                    "participated_topics"
                ],
                ["Mentioned here"],
            )

    def test_thread_follows_its_topic(self) -> None:
        iago = self.example_user("iago")
        hamlet = self.example_user("hamlet")
        verona = get_stream("Verona", hamlet.realm)
        denmark = get_stream("Denmark", hamlet.realm)
        root_id = self.send_stream_message(hamlet, "Verona", "Ship it", "")
        topic = self.assert_json_success(self.create("hamlet", root_id))["topic_name"]
        first = self.send_stream_message(hamlet, "Verona", "one", topic)
        second = self.send_stream_message(iago, "Verona", "two", topic)

        def thread() -> MessageThread:
            return MessageThread.objects.get(root_message_id=root_id)

        def move(message_id: int, **params: str) -> None:
            self.assert_json_success(
                self.api_patch(
                    iago,
                    f"/api/v1/messages/{message_id}",
                    {
                        "propagate_mode": "change_all",
                        "send_notification_to_old_thread": "false",
                        "send_notification_to_new_thread": "false",
                        **params,
                    },
                )
            )

        # Resolving and unresolving are renames with a prefix.
        self.assert_json_success(self.resolve_topic_containing_message(iago, first))
        self.assertEqual(thread().topic_name, "✔ " + topic)
        move(first, topic=topic)
        self.assertEqual(thread().topic_name, topic)

        move(first, topic="R9 shipping plan")
        self.assertEqual((thread().stream_id, thread().topic_name), (verona.id, "R9 shipping plan"))
        listed = self.assert_json_success(self.list_threads("hamlet", verona.id))["threads"]
        # The replies, plus Notification Bot's resolved/unresolved notices.
        self.assertEqual(
            [(t["topic_name"], t["reply_count"]) for t in listed], [("R9 shipping plan", 4)]
        )

        move(first, stream_id=str(denmark.id))
        self.assertEqual(
            (thread().stream_id, thread().topic_name), (denmark.id, "R9 shipping plan")
        )

        # Moving only some of the replies leaves the thread with the rest.
        move(first, topic="R9 split off", propagate_mode="change_one")
        self.assertEqual(
            (thread().stream_id, thread().topic_name), (denmark.id, "R9 shipping plan")
        )

        # Moving the replies into another thread's topic merges them into
        # that thread; this root is a plain message again.
        other_root = self.send_stream_message(hamlet, "Denmark", "Other root", "")
        other_topic = self.assert_json_success(self.create("hamlet", other_root))["topic_name"]
        self.send_stream_message(hamlet, "Denmark", "other reply", other_topic)
        move(second, topic=other_topic)
        self.assertFalse(MessageThread.objects.filter(root_message_id=root_id).exists())
        self.assertEqual(
            MessageThread.objects.get(root_message_id=other_root).topic_name, other_topic
        )

        # Moving a topic that is not a thread changes no thread.
        plain = self.send_stream_message(hamlet, "Denmark", "plain", "R9 plain topic")
        move(plain, topic="R9 plain renamed")
        self.assertEqual(MessageThread.objects.filter(realm=hamlet.realm).count(), 1)

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


class ThreadActivityTest(ZulipTestCase):
    @override
    def setUp(self) -> None:
        super().setUp()
        # The test database's sample conversations include topics the
        # example users posted or were mentioned in; only what a test
        # sends itself is looked at.
        self.first_test_message_id = Message.objects.order_by("-id")[0].id + 1

    def activity(self, user_name: str) -> list[dict[str, Any]]:
        result = self.api_get(self.example_user(user_name), "/api/v1/ykphone/threads/activity")
        return [
            message
            for message in self.assert_json_success(result)["messages"]
            if message["id"] >= self.first_test_message_id
        ]

    def start_thread(self, user_name: str, root_id: int) -> str:
        result = self.api_post(
            self.example_user(user_name), "/api/v1/ykphone/threads", {"message_id": root_id}
        )
        return self.assert_json_success(result)["topic_name"]

    def test_replies_in_my_threads(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        iago = self.example_user("iago")
        verona = get_stream("Verona", hamlet.realm)
        root_id = self.send_stream_message(hamlet, "Verona", "Shall we ship on Friday?", "")
        topic = self.start_thread("hamlet", root_id)
        one = self.send_stream_message(cordelia, "Verona", "Yes **please**", topic)
        two = self.send_stream_message(othello, "Verona", "Works for me", topic)
        mine = self.send_stream_message(hamlet, "Verona", "Great", topic)

        # The creator sees the others' replies, newest first, never
        # the root or their own replies.
        messages = self.activity("hamlet")
        self.assertEqual([message["id"] for message in messages], [two, one])
        newest = messages[0]
        self.assertEqual(newest["sender_id"], othello.id)
        self.assertEqual(newest["sender_full_name"], othello.full_name)
        self.assertEqual(newest["stream_id"], verona.id)
        self.assertEqual(newest["display_recipient"], "Verona")
        self.assertEqual(newest[TOPIC_NAME], topic)
        self.assertEqual(newest["type"], "stream")
        self.assertIn("timestamp", newest)
        self.assertEqual(messages[1]["content"], "<p>Yes <strong>please</strong></p>")
        # Received and still unread.
        self.assertEqual(newest["flags"], [])

        # Someone who replied sees the replies that came from others.
        self.assertEqual([message["id"] for message in self.activity("cordelia")], [mine, two])
        self.assertEqual([message["id"] for message in self.activity("othello")], [mine, one])

        # The root's author follows the thread without starting or
        # joining it, as in Slack; nobody else is involved.
        other_root = self.send_stream_message(othello, "Verona", "Lunch?", "")
        other_topic = self.start_thread("cordelia", other_root)
        noodles = self.send_stream_message(hamlet, "Verona", "Noodles", other_topic)
        self.assertEqual(
            [message["id"] for message in self.activity("othello")], [noodles, mine, one]
        )
        self.assertEqual(self.activity("iago"), [])

        # A thread reply by the user counts as joining it; replies that
        # had already been sent before joining are included.
        self.send_stream_message(iago, "Verona", "Count me in", other_topic)
        self.assertEqual([message["id"] for message in self.activity("iago")], [noodles])

    def test_replies_in_topics_i_take_part_in(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        # Topics another client created: Hamlet posted in one and was
        # mentioned in another; the third is someone else's.
        self.send_stream_message(hamlet, "Verona", "started here", "Mobile topic")
        posted = self.send_stream_message(cordelia, "Verona", "reply", "Mobile topic")
        mention = self.send_stream_message(othello, "Verona", "@**King Hamlet** see", "Asked")
        after_mention = self.send_stream_message(cordelia, "Verona", "and this", "Asked")
        self.send_stream_message(cordelia, "Verona", "unrelated", "Someone else's")
        self.assertEqual(
            [message["id"] for message in self.activity("hamlet")],
            [after_mention, mention, posted],
        )
        self.assertEqual(self.activity("iago"), [])

    def test_access_and_protected_history(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        private = self.make_stream(
            "protected-lab", invite_only=True, history_public_to_subscribers=False
        )
        self.subscribe(hamlet, private.name)
        self.subscribe(cordelia, private.name)
        root_id = self.send_stream_message(hamlet, private.name, "Salary bands", "")
        topic = self.start_thread("cordelia", root_id)
        before = self.send_stream_message(hamlet, private.name, "before", topic)
        self.assertEqual([message["id"] for message in self.activity("cordelia")], [before])

        # Unsubscribed: the channel is no longer accessible at all.
        self.unsubscribe(cordelia, private.name)
        self.assertEqual(self.activity("cordelia"), [])
        self.send_stream_message(hamlet, private.name, "meanwhile", topic)

        # Back later: the reply sent while she was away was never
        # received, and the channel's history is not public to
        # subscribers, so it stays out; the others are listed.
        self.subscribe(cordelia, private.name)
        after = self.send_stream_message(hamlet, private.name, "after", topic)
        self.assertEqual([message["id"] for message in self.activity("cordelia")], [after, before])

        # Hamlet wrote the root, so he follows the thread, but every reply
        # so far is his own; Cordelia's first one is listed.
        self.assertEqual(self.activity("hamlet"), [])
        hers = self.send_stream_message(cordelia, private.name, "noted", topic)
        self.assertEqual([message["id"] for message in self.activity("hamlet")], [hers])
        # Without access to the channel, writing the root no longer
        # counts.
        self.unsubscribe(hamlet, private.name)
        self.assertEqual(self.activity("hamlet"), [])
        self.subscribe(hamlet, private.name)

        # An archived channel is left out.
        do_deactivate_stream(private, acting_user=hamlet)
        self.assertEqual(self.activity("cordelia"), [])

    def test_guest_leaving_a_public_channel(self) -> None:
        hamlet = self.example_user("hamlet")
        polonius = self.example_user("polonius")
        self.subscribe(polonius, "Verona")
        root_id = self.send_stream_message(hamlet, "Verona", "Guests welcome", "")
        topic = self.start_thread("polonius", root_id)
        reply = self.send_stream_message(hamlet, "Verona", "hello", topic)
        self.assertEqual([message["id"] for message in self.activity("polonius")], [reply])
        # A guest loses a public channel's history on leaving it, unlike
        # a member.
        self.unsubscribe(polonius, "Verona")
        self.assertEqual(self.activity("polonius"), [])

    def test_topic_case(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        verona = get_stream("Verona", hamlet.realm)
        root_id = self.send_stream_message(hamlet, "Verona", "Ship it", "")
        topic = self.start_thread("hamlet", root_id)
        # Topics are case-insensitive: a client sending to the thread in
        # another case still lands in it.
        reply = self.send_stream_message(cordelia, "Verona", "yes", topic.upper())
        self.assertEqual([message["id"] for message in self.activity("hamlet")], [reply])
        listed = self.assert_json_success(
            self.api_get(hamlet, "/api/v1/ykphone/threads", {"stream_id": verona.id})
        )["threads"]
        self.assertEqual(
            [(t["reply_count"], t["participant_user_ids"]) for t in listed], [(1, [cordelia.id])]
        )

    def test_query_count(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        for stream_name in ["Verona", "Denmark", "Scotland"]:
            self.subscribe(hamlet, stream_name)
            self.subscribe(cordelia, stream_name)
            root_id = self.send_stream_message(hamlet, stream_name, f"Root in {stream_name}", "")
            topic = self.start_thread("hamlet", root_id)
            self.send_stream_message(cordelia, stream_name, "reply", topic)
        # Session/auth and realm queries, then: subscribed channel ids,
        # accessible channels, newest thread ids, involved threads, the
        # topics the user posted or was mentioned in and the threads among
        # them, the replies, their UserMessage flags and messages_for_ids;
        # no per-channel or per-thread queries.
        with self.assert_database_query_count(18):
            messages = self.activity("hamlet")
        self.assert_length(messages, 3)

    def test_cap(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        root_id = self.send_stream_message(hamlet, "Verona", "Long thread", "")
        topic = self.start_thread("hamlet", root_id)
        ids = [self.send_stream_message(cordelia, "Verona", f"reply {n}", topic) for n in range(3)]
        with mock.patch("ykphone.lib.threads.MAX_ACTIVITY_MESSAGES", 2):
            self.assertEqual([message["id"] for message in self.activity("hamlet")], ids[:0:-1])

    def test_login_required(self) -> None:
        result = self.client_get("/json/ykphone/threads/activity")
        self.assert_json_error(
            result, "Not logged in: API authentication or user session required", 401
        )


class MyThreadsTest(ZulipTestCase):
    @override
    def setUp(self) -> None:
        super().setUp()
        # The test database's sample conversations include topics the
        # example users posted or were mentioned in; only what a test
        # sends itself is looked at.
        self.first_test_message_id = Message.objects.order_by("-id")[0].id + 1

    def mine(self, user_name: str) -> list[dict[str, Any]]:
        result = self.api_get(self.example_user(user_name), "/api/v1/ykphone/threads/mine")
        return [
            row
            for row in self.assert_json_success(result)["threads"]
            if row["root_message_id"] >= self.first_test_message_id
        ]

    def start_thread(self, user_name: str, root_id: int) -> str:
        result = self.api_post(
            self.example_user(user_name), "/api/v1/ykphone/threads", {"message_id": root_id}
        )
        return self.assert_json_success(result)["topic_name"]

    def test_rows(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        verona = get_stream("Verona", hamlet.realm)
        root_id = self.send_stream_message(hamlet, "Verona", "Shall we **ship** on Friday?", "")
        topic = self.start_thread("cordelia", root_id)

        # A thread without replies: the creator and the root's author
        # follow it; nobody else does.
        rows = self.mine("cordelia")
        self.assert_length(rows, 1)
        row = rows[0]
        self.assertEqual(row["root_message_id"], root_id)
        self.assertEqual(row["stream_id"], verona.id)
        self.assertEqual(row["topic_name"], topic)
        self.assertTrue(row["is_thread"])
        self.assertEqual(row["reply_count"], 0)
        self.assertIsNone(row["last_reply_timestamp"])
        self.assertEqual(row["root_sender_id"], hamlet.id)
        self.assertEqual(row["root_sender_full_name"], hamlet.full_name)
        self.assertEqual(row["root_snippet"], "Shall we ship on Friday?")
        root = Message.objects.get(id=root_id)
        self.assertEqual(row["root_timestamp"], datetime_to_timestamp(root.date_sent))
        self.assertEqual(row["last_activity_timestamp"], row["root_timestamp"])
        self.assertEqual([r["root_message_id"] for r in self.mine("hamlet")], [root_id])
        self.assertEqual(self.mine("othello"), [])

        # Replying joins the thread; the stats count every reply.
        reply = self.send_stream_message(othello, "Verona", "Works for me", topic)
        self.send_stream_message(cordelia, "Verona", "Yes", topic.upper())
        row = self.mine("othello")[0]
        self.assertEqual(row["reply_count"], 2)
        last = Message.objects.get(id=reply + 1)
        self.assertEqual(row["last_reply_timestamp"], datetime_to_timestamp(last.date_sent))
        self.assertEqual(row["last_activity_timestamp"], row["last_reply_timestamp"])

    def test_plain_topics_and_order(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        verona = get_stream("Verona", hamlet.realm)
        # A topic another client created, which Hamlet posted in: its
        # first message stands in for the root and the rest are replies.
        first = self.send_stream_message(cordelia, "Verona", "Mobile first", "Mobile topic")
        self.send_stream_message(hamlet, "Verona", "me too", "Mobile topic")
        # A topic Hamlet was mentioned in, with no replies yet.
        mention = self.send_stream_message(othello, "Verona", "@**King Hamlet** see", "Asked")
        # Someone else's topic.
        self.send_stream_message(cordelia, "Verona", "unrelated", "Someone else's")
        # A thread of Hamlet's, older than the plain topics.
        root_id = self.send_stream_message(hamlet, "Verona", "Root", "")
        self.start_thread("hamlet", root_id)

        rows = self.mine("hamlet")
        self.assertEqual(
            [(row["root_message_id"], row["is_thread"]) for row in rows],
            [(root_id, True), (mention, False), (first, False)],
        )
        asked, mobile = rows[1], rows[2]
        self.assertEqual(asked["topic_name"], "Asked")
        self.assertEqual(asked["reply_count"], 0)
        self.assertIsNone(asked["last_reply_timestamp"])
        self.assertEqual(asked["root_sender_id"], othello.id)
        self.assertEqual(asked["root_snippet"], "King Hamlet see")
        self.assertEqual(mobile["stream_id"], verona.id)
        self.assertEqual(mobile["reply_count"], 1)
        self.assertIsNotNone(mobile["last_reply_timestamp"])
        self.assertEqual(mobile["root_sender_full_name"], cordelia.full_name)

        # A reply moves the topic to the top: newest activity first.
        self.send_stream_message(cordelia, "Verona", "again", "Mobile topic")
        self.assertEqual(
            [row["root_message_id"] for row in self.mine("hamlet")], [first, root_id, mention]
        )
        self.assertEqual(self.mine("iago"), [])

    def test_access_and_protected_history(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        private = self.make_stream(
            "protected-lab", invite_only=True, history_public_to_subscribers=False
        )
        othello = self.example_user("othello")
        self.subscribe(hamlet, private.name)
        self.subscribe(cordelia, private.name)
        root_id = self.send_stream_message(hamlet, private.name, "Salary bands", "")
        topic = self.start_thread("cordelia", root_id)
        self.assertEqual([row["root_message_id"] for row in self.mine("cordelia")], [root_id])
        # Othello joins after the root was sent and replies, which makes
        # him follow the thread, but he never received the root the row
        # would show, so the row is not listed for him.
        self.subscribe(othello, private.name)
        self.send_stream_message(othello, private.name, "joining", topic)
        self.assertEqual(self.mine("othello"), [])
        # Without access to the channel nothing is listed.
        self.unsubscribe(hamlet, private.name)
        self.assertEqual(self.mine("hamlet"), [])
        self.subscribe(hamlet, private.name)

        # Replies sent while unsubscribed are never received and stay
        # out of the counts.
        self.unsubscribe(cordelia, private.name)
        self.send_stream_message(hamlet, private.name, "meanwhile", topic)
        self.subscribe(cordelia, private.name)
        self.send_stream_message(hamlet, private.name, "after", topic)
        row = self.mine("hamlet")[0]
        self.assertEqual(row["reply_count"], 3)
        self.assertEqual(self.mine("cordelia")[0]["reply_count"], 2)
        # A plain topic Cordelia posts in counts only what she received.
        self.send_stream_message(cordelia, private.name, "mine", "Plain")
        self.unsubscribe(cordelia, private.name)
        self.send_stream_message(hamlet, private.name, "unseen", "Plain")
        self.subscribe(cordelia, private.name)
        seen = self.send_stream_message(hamlet, private.name, "seen", "Plain")
        rows = self.mine("cordelia")
        self.assertEqual(
            [(row["topic_name"], row["reply_count"]) for row in rows],
            [("Plain", 1), ("Salary bands", 2)],
        )
        self.assertEqual(
            rows[0]["last_activity_timestamp"],
            datetime_to_timestamp(Message.objects.get(id=seen).date_sent),
        )

        # An archived channel is left out.
        do_deactivate_stream(private, acting_user=hamlet)
        self.assertEqual(self.mine("cordelia"), [])
        self.assertEqual(self.mine("hamlet"), [])

    def test_guest_leaving_a_public_channel(self) -> None:
        hamlet = self.example_user("hamlet")
        polonius = self.example_user("polonius")
        self.subscribe(polonius, "Verona")
        root_id = self.send_stream_message(hamlet, "Verona", "Guests welcome", "")
        self.start_thread("polonius", root_id)
        self.assertEqual([row["root_message_id"] for row in self.mine("polonius")], [root_id])
        self.unsubscribe(polonius, "Verona")
        self.assertEqual(self.mine("polonius"), [])

    def test_query_count(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        for stream_name in ["Verona", "Denmark", "Scotland"]:
            self.subscribe(hamlet, stream_name)
            self.subscribe(cordelia, stream_name)
            root_id = self.send_stream_message(hamlet, stream_name, f"Root in {stream_name}", "")
            topic = self.start_thread("hamlet", root_id)
            self.send_stream_message(cordelia, stream_name, "reply", topic)
            self.send_stream_message(hamlet, stream_name, "plain", f"Plain in {stream_name}")
        # Session/auth and realm queries, then: subscribed channel ids,
        # accessible channels, newest thread ids, followed threads, the
        # participated topics and the threads among them, one stats
        # query and the roots; no per-channel or per-topic queries.
        with self.assert_database_query_count(12):
            rows = self.mine("hamlet")
        self.assert_length(rows, 6)
        # The same number of queries for one channel (the others
        # archived): nothing is queried per channel or per topic.
        do_deactivate_stream(get_stream("Denmark", hamlet.realm), acting_user=hamlet)
        do_deactivate_stream(get_stream("Scotland", hamlet.realm), acting_user=hamlet)
        with self.assert_database_query_count(12):
            rows = self.mine("hamlet")
        self.assert_length(rows, 2)

    def test_cap(self) -> None:
        hamlet = self.example_user("hamlet")
        roots = [self.send_stream_message(hamlet, "Verona", f"Root {n}", "") for n in range(3)]
        for root_id in roots:
            self.start_thread("hamlet", root_id)
        with mock.patch("ykphone.lib.threads.MAX_MY_THREADS", 2):
            self.assertEqual([row["root_message_id"] for row in self.mine("hamlet")], roots[:0:-1])

    def test_login_required(self) -> None:
        result = self.client_get("/json/ykphone/threads/mine")
        self.assert_json_error(
            result, "Not logged in: API authentication or user session required", 401
        )
