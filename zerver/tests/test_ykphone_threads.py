from typing import Any
from unittest import mock

import orjson

from ykphone.lib.threads import get_or_create_thread, thread_topic_snippet
from ykphone.models import MessageThread
from zerver.actions.streams import do_deactivate_stream, do_set_stream_property
from zerver.lib.message import access_message
from zerver.lib.test_classes import ZulipTestCase
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


class ThreadActivityTest(ZulipTestCase):
    def activity(self, user_name: str) -> list[dict[str, Any]]:
        result = self.api_get(self.example_user(user_name), "/api/v1/ykphone/threads/activity")
        return self.assert_json_success(result)["messages"]

    def start_thread(self, user_name: str, root_id: int) -> str:
        result = self.api_post(
            self.example_user(user_name), "/api/v1/ykphone/threads", {"message_id": root_id}
        )
        return self.assert_json_success(result)["topic_name"]

    def test_replies_in_my_threads(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
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

        # The root's author is not involved unless they start or join
        # the thread; nor is anyone else.
        other_root = self.send_stream_message(othello, "Verona", "Lunch?", "")
        other_topic = self.start_thread("cordelia", other_root)
        noodles = self.send_stream_message(hamlet, "Verona", "Noodles", other_topic)
        self.assertEqual([message["id"] for message in self.activity("othello")], [mine, one])
        self.assertEqual(self.activity("iago"), [])

        # A thread reply by the user counts as joining it; replies that
        # had already been sent before joining are included.
        self.send_stream_message(othello, "Verona", "Count me in", other_topic)
        self.assertEqual(
            [message["id"] for message in self.activity("othello")], [noodles, mine, one]
        )

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

        # Hamlet, who received everything, sees nothing here: he neither
        # started the thread nor replied to anyone else.
        self.assertEqual(self.activity("hamlet"), [])

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
        # replies, their UserMessage flags and messages_for_ids; no
        # per-channel or per-thread queries.
        with self.assert_database_query_count(16):
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
