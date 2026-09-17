from typing import Any

import orjson

from ykphone.models import PinnedMessage
from zerver.actions.message_delete import do_delete_messages
from zerver.actions.message_edit import check_update_message
from zerver.actions.streams import do_deactivate_stream
from zerver.lib.events import apply_events
from zerver.lib.stream_subscription import get_active_subscriptions_for_stream_id
from zerver.lib.test_classes import ZulipTestCase
from zerver.models import Message
from zerver.models.streams import get_stream


class PinAPITest(ZulipTestCase):
    def pin(self, user_name: str, message_id: int) -> Any:
        return self.api_post(
            self.example_user(user_name), "/api/v1/ykphone/pins", {"message_id": message_id}
        )

    def unpin(self, user_name: str, message_id: int) -> Any:
        return self.api_delete(self.example_user(user_name), f"/api/v1/ykphone/pins/{message_id}")

    def list_pins(self, user_name: str, stream_id: int) -> Any:
        return self.api_get(
            self.example_user(user_name), "/api/v1/ykphone/pins", {"stream_id": stream_id}
        )

    def test_pin_list_unpin(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        verona = get_stream("Verona", hamlet.realm)
        message_id = self.send_stream_message(hamlet, "Verona", "Keep **this** handy", "")
        message = Message.objects.get(id=message_id)

        with self.capture_send_event_calls(expected_num_events=1) as events:
            data = self.assert_json_success(self.pin("cordelia", message_id))
        self.assertEqual(data["message_id"], message_id)
        self.assertEqual(data["stream_id"], verona.id)
        self.assertEqual(data["topic_name"], "")
        self.assertEqual(data["pinned_by_user_id"], cordelia.id)
        self.assertEqual(data["sender_id"], hamlet.id)
        self.assertEqual(data["sender_full_name"], hamlet.full_name)
        self.assertEqual(data["timestamp"], int(message.date_sent.timestamp()))
        self.assertEqual(data["content"], message.rendered_content)
        self.assertIn("<strong>this</strong>", data["content"])

        # Every subscriber of the channel learns about the pin.
        pin = {key: value for key, value in data.items() if key not in ("result", "msg")}
        self.assertEqual(events[0]["event"], {"type": "ykphone_pin", "op": "add", "pin": pin})
        subscriber_ids = get_active_subscriptions_for_stream_id(
            verona.id, include_deactivated_users=False
        ).values_list("user_profile_id", flat=True)
        self.assertEqual(set(events[0]["users"]), set(subscriber_ids))
        self.assertIn(cordelia.id, events[0]["users"])

        # Pinning again changes nothing and sends nothing.
        with self.capture_send_event_calls(expected_num_events=0):
            again = self.assert_json_success(self.pin("hamlet", message_id))
        self.assertEqual(again["date_pinned"], data["date_pinned"])
        self.assertEqual(again["pinned_by_user_id"], cordelia.id)
        self.assertEqual(PinnedMessage.objects.filter(message_id=message_id).count(), 1)

        other_id = self.send_stream_message(hamlet, "Verona", "second", "")
        self.assert_json_success(self.pin("hamlet", other_id))
        listed = self.assert_json_success(self.list_pins("hamlet", verona.id))["pins"]
        # Newest pin first.
        self.assertEqual([pin["message_id"] for pin in listed], [other_id, message_id])

        # Anyone in the channel may unpin, not only the pinner.
        with self.capture_send_event_calls(expected_num_events=1) as events:
            self.assert_json_success(self.unpin("hamlet", message_id))
        self.assertEqual(
            events[0]["event"],
            {
                "type": "ykphone_pin",
                "op": "remove",
                "stream_id": verona.id,
                "message_id": message_id,
            },
        )
        listed = self.assert_json_success(self.list_pins("hamlet", verona.id))["pins"]
        self.assertEqual([pin["message_id"] for pin in listed], [other_id])

        # Unpinning a message that is not pinned is a no-op.
        with self.capture_send_event_calls(expected_num_events=0):
            self.assert_json_success(self.unpin("hamlet", message_id))

    def test_only_channel_messages(self) -> None:
        hamlet = self.example_user("hamlet")
        dm_id = self.send_personal_message(hamlet, self.example_user("cordelia"), "psst")
        self.assert_json_error(self.pin("hamlet", dm_id), "Only channel messages can be pinned.")

    def test_access_checks(self) -> None:
        hamlet = self.example_user("hamlet")
        private = self.make_stream("secret-lab", invite_only=True)
        self.subscribe(hamlet, private.name)
        message_id = self.send_stream_message(hamlet, private.name, "hidden", "")

        # Iago is not subscribed to the private channel.
        self.assert_json_error(self.pin("iago", message_id), "Invalid message(s)")
        self.assert_json_error(self.unpin("iago", message_id), "Invalid message(s)")
        self.assert_json_error(self.list_pins("iago", private.id), "Invalid channel ID")
        self.assert_json_error(self.list_pins("hamlet", 999999), "Invalid channel ID")
        self.assert_json_error(self.pin("hamlet", 999999), "Invalid message(s)")
        self.assertEqual(orjson.loads(self.list_pins("hamlet", private.id).content)["pins"], [])

    def test_protected_history(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        private = self.make_stream(
            "protected-lab", invite_only=True, history_public_to_subscribers=False
        )
        self.subscribe(hamlet, private.name)
        old_id = self.send_stream_message(hamlet, private.name, "Salary bands", "")
        self.assert_json_success(self.pin("hamlet", old_id))

        # Cordelia joins later: the old pin is invisible to her, she
        # cannot pin or unpin the message, and the event for a later
        # unpin does not reach her.
        self.subscribe(cordelia, private.name)
        self.assertEqual(
            self.assert_json_success(self.list_pins("cordelia", private.id))["pins"], []
        )
        self.assert_json_error(self.pin("cordelia", old_id), "Invalid message(s)")
        self.assert_json_error(self.unpin("cordelia", old_id), "Invalid message(s)")

        new_id = self.send_stream_message(hamlet, private.name, "Welcome, Cordelia", "")
        with self.capture_send_event_calls(expected_num_events=1) as events:
            self.assert_json_success(self.pin("cordelia", new_id))
        self.assertEqual(set(events[0]["users"]), {hamlet.id, cordelia.id})
        listed = self.assert_json_success(self.list_pins("cordelia", private.id))["pins"]
        self.assertEqual([pin["message_id"] for pin in listed], [new_id])
        listed = self.assert_json_success(self.list_pins("hamlet", private.id))["pins"]
        self.assertEqual([pin["message_id"] for pin in listed], [new_id, old_id])

        with self.capture_send_event_calls(expected_num_events=1) as events:
            self.assert_json_success(self.unpin("hamlet", old_id))
        self.assertEqual(events[0]["users"], [hamlet.id])

    def test_deleting_the_message_deletes_the_pin(self) -> None:
        hamlet = self.example_user("hamlet")
        verona = get_stream("Verona", hamlet.realm)
        message_id = self.send_stream_message(hamlet, "Verona", "gone soon", "")
        self.assert_json_success(self.pin("hamlet", message_id))
        self.assertTrue(PinnedMessage.objects.filter(message_id=message_id).exists())

        do_delete_messages(hamlet.realm, [Message.objects.get(id=message_id)], acting_user=hamlet)
        self.assertFalse(PinnedMessage.objects.filter(message_id=message_id).exists())
        self.assertEqual(self.assert_json_success(self.list_pins("hamlet", verona.id))["pins"], [])
        self.assert_json_error(self.pin("hamlet", message_id), "Invalid message(s)")

    def test_requires_login(self) -> None:
        verona = get_stream("Verona", self.example_user("hamlet").realm)
        for result in (
            self.client_get("/json/ykphone/pins", {"stream_id": verona.id}),
            self.client_post("/json/ykphone/pins", {"message_id": 1}),
            self.client_delete("/json/ykphone/pins/1"),
        ):
            self.assert_json_error(
                result, "Not logged in: API authentication or user session required", 401
            )

    def test_public_channel_readers_and_guests(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        public = self.make_stream("open-lab")
        self.subscribe(hamlet, public.name)
        message_id = self.send_stream_message(hamlet, public.name, "for everyone", "")

        # Anyone who may read a public channel may pin in it, subscribed
        # or not, as with reading.
        self.assertNotIn(public.name, self.subscribed_stream_name_list(cordelia))
        data = self.assert_json_success(self.pin("cordelia", message_id))
        self.assertEqual(data["pinned_by_user_id"], cordelia.id)
        listed = self.assert_json_success(self.list_pins("cordelia", public.id))["pins"]
        self.assertEqual([pin["message_id"] for pin in listed], [message_id])
        self.assert_json_success(self.unpin("cordelia", message_id))

        # A guest can neither read the channel nor its pins.
        polonius = self.example_user("polonius")
        self.assertTrue(polonius.is_guest)
        self.assert_json_error(self.pin("polonius", message_id), "Invalid message(s)")
        self.assert_json_error(self.list_pins("polonius", public.id), "Invalid channel ID")

    def test_archived_channel(self) -> None:
        hamlet = self.example_user("hamlet")
        iago = self.example_user("iago")
        stream = self.make_stream("old-lab")
        self.subscribe(hamlet, stream.name)
        pinned_id = self.send_stream_message(hamlet, stream.name, "keep", "")
        other_id = self.send_stream_message(hamlet, stream.name, "not kept", "")
        self.assert_json_success(self.pin("hamlet", pinned_id))
        do_deactivate_stream(stream, acting_user=iago)

        # Nothing new can be pinned in an archived channel, but its pins
        # can still be cleared.
        self.assert_json_error(self.pin("hamlet", other_id), "Invalid channel ID")
        self.assert_json_success(self.unpin("hamlet", pinned_id))
        self.assertFalse(PinnedMessage.objects.filter(message_id=pinned_id).exists())

    def test_moved_message_follows_its_channel(self) -> None:
        hamlet = self.example_user("hamlet")
        iago = self.example_user("iago")
        verona = get_stream("Verona", hamlet.realm)
        private = self.make_stream("secret-lab", invite_only=True)
        self.subscribe(iago, private.name)
        message_id = self.send_stream_message(hamlet, "Verona", "moving soon", "")
        self.assert_json_success(self.pin("hamlet", message_id))

        check_update_message(iago, message_id, stream_id=private.id, propagate_mode="change_one")

        # The old channel no longer lists the pin; the new one does, with
        # its own channel id, and only for those who may read it.
        self.assertEqual(self.assert_json_success(self.list_pins("hamlet", verona.id))["pins"], [])
        listed = self.assert_json_success(self.list_pins("iago", private.id))["pins"]
        self.assertEqual(
            [(pin["message_id"], pin["stream_id"]) for pin in listed], [(message_id, private.id)]
        )
        self.assert_json_error(self.list_pins("hamlet", private.id), "Invalid channel ID")
        self.assert_json_error(self.pin("hamlet", message_id), "Invalid message(s)")
        self.assert_json_error(self.unpin("hamlet", message_id), "Invalid message(s)")

        # Unpinning goes to the new channel's members, not the old one's.
        with self.capture_send_event_calls(expected_num_events=1) as events:
            self.assert_json_success(self.unpin("iago", message_id))
        self.assertEqual(events[0]["event"]["stream_id"], private.id)
        self.assertEqual(events[0]["users"], [iago.id])

    def test_register_time_events_are_ignored(self) -> None:
        # A pin event queued while the initial state is being fetched is
        # applied by do_events_register; the state has nothing about
        # pins, so it must be a no-op rather than an error.
        hamlet = self.example_user("hamlet")
        state = {"zulip_version": "test"}
        apply_events(
            hamlet,
            state=state,
            events=[
                {"type": "ykphone_pin", "op": "add", "pin": {"message_id": 1}},
                {"type": "ykphone_pin", "op": "remove", "stream_id": 1, "message_id": 1},
            ],
            fetch_event_types=None,
            client_gravatar=True,
            slim_presence=True,
            include_subscribers=False,
            linkifier_url_template=True,
            user_list_incomplete=True,
            include_deactivated_groups=True,
        )
        self.assertEqual(state, {"zulip_version": "test"})
