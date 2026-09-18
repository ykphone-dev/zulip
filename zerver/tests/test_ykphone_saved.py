from typing import Any
from unittest import mock

from django.db import connection
from django.test.utils import CaptureQueriesContext

from ykphone.models import SavedItem
from zerver.actions.message_delete import do_delete_messages
from zerver.actions.message_flags import do_update_message_flags
from zerver.lib.events import apply_events
from zerver.lib.test_classes import ZulipTestCase
from zerver.lib.timestamp import datetime_to_timestamp
from zerver.models import Message, UserMessage, UserProfile


class SavedItemTest(ZulipTestCase):
    def save(self, user: UserProfile, message_id: int, **extra: Any) -> Any:
        return self.api_post(user, "/api/v1/ykphone/saved", {"message_id": message_id, **extra})

    def patch(self, user: UserProfile, message_id: int, **params: Any) -> Any:
        return self.api_patch(user, f"/api/v1/ykphone/saved/{message_id}", params)

    def remove(self, user: UserProfile, message_id: int) -> Any:
        return self.api_delete(user, f"/api/v1/ykphone/saved/{message_id}")

    def listed(self, user: UserProfile) -> list[dict[str, Any]]:
        return self.assert_json_success(self.api_get(user, "/api/v1/ykphone/saved"))["items"]

    def star(self, user: UserProfile, message_id: int, op: str = "add") -> None:
        self.assert_json_success(
            self.api_post(
                user,
                "/api/v1/messages/flags",
                {"messages": f"[{message_id}]", "op": op, "flag": "starred"},
            )
        )

    def is_starred(self, user: UserProfile, message_id: int) -> bool:
        return UserMessage.objects.get(
            user_profile=user, message_id=message_id
        ).flags.starred.is_set

    def state_of(self, user: UserProfile, message_id: int) -> str | None:
        item = SavedItem.objects.filter(user=user, message_id=message_id).first()
        return None if item is None else item.state

    def test_star_flag_keeps_items_in_step(self) -> None:
        hamlet = self.example_user("hamlet")
        message_id = self.send_stream_message(self.example_user("iago"), "Verona", "later", "")

        # Starring through Zulip's own API adds an item in progress;
        # Zulip's own flag event is the only event (the web app applies
        # the same rule to it).
        with self.capture_send_event_calls(expected_num_events=1) as events:
            self.star(hamlet, message_id)
        self.assertEqual(events[0]["event"]["type"], "update_message_flags")
        self.assertEqual(self.state_of(hamlet, message_id), "in_progress")

        # Starring again changes nothing.
        with self.capture_send_event_calls(expected_num_events=1):
            self.star(hamlet, message_id)
        self.assertEqual(SavedItem.objects.filter(user=hamlet).count(), 1)

        # Unstarring removes it.
        with self.capture_send_event_calls(expected_num_events=1):
            self.star(hamlet, message_id, "remove")
        self.assertIsNone(self.state_of(hamlet, message_id))

    def test_api_events(self) -> None:
        hamlet = self.example_user("hamlet")
        message_id = self.send_stream_message(self.example_user("iago"), "Verona", "later", "")
        # Saving stars (Zulip's event); the item itself is announced
        # only when the star did not create it.
        with self.capture_send_event_calls(expected_num_events=2) as events:
            self.assert_json_success(self.save(hamlet, message_id, due=1_900_000_000))
        self.assertEqual(events[0]["event"]["type"], "update_message_flags")
        self.assertEqual(events[1]["event"]["type"], "ykphone_saved")
        self.assertEqual(events[1]["event"]["op"], "update")
        self.assertEqual(events[1]["event"]["item"]["due"], 1_900_000_000)
        self.assertEqual(events[1]["users"], [hamlet.id])

        with self.capture_send_event_calls(expected_num_events=1) as events:
            self.assert_json_success(self.patch(hamlet, message_id, state="completed"))
        self.assertEqual(
            events[0]["event"]["item"],
            {
                "message_id": message_id,
                "state": "completed",
                "due": 1_900_000_000,
                "date_created": datetime_to_timestamp(
                    SavedItem.objects.get(user=hamlet).date_created
                ),
            },
        )

        # A star from before the table existed: saving announces the
        # item it creates.
        SavedItem.objects.filter(user=hamlet).delete()
        with self.capture_send_event_calls(expected_num_events=2) as events:
            self.assert_json_success(self.save(hamlet, message_id))
        self.assertEqual(events[1]["event"]["op"], "add")
        self.assertEqual(events[1]["event"]["item"]["state"], "in_progress")

        with self.capture_send_event_calls(expected_num_events=2) as events:
            self.assert_json_success(self.remove(hamlet, message_id))
        self.assertEqual(
            events[1]["event"], {"type": "ykphone_saved", "op": "remove", "message_id": message_id}
        )

    def test_save_complete_archive_restore_remove(self) -> None:
        hamlet = self.example_user("hamlet")
        message_id = self.send_stream_message(self.example_user("iago"), "Verona", "later", "")

        item = self.assert_json_success(self.save(hamlet, message_id, due=1_900_000_000))
        self.assertEqual(item["state"], "in_progress")
        self.assertEqual(item["due"], 1_900_000_000)
        self.assertTrue(self.is_starred(hamlet, message_id))
        self.assertEqual(
            [(row["message_id"], row["state"], row["due"]) for row in self.listed(hamlet)],
            [(message_id, "in_progress", 1_900_000_000)],
        )

        # Completing keeps the star and the due date.
        item = self.assert_json_success(self.patch(hamlet, message_id, state="completed"))
        self.assertEqual((item["state"], item["due"]), ("completed", 1_900_000_000))
        self.assertTrue(self.is_starred(hamlet, message_id))

        # Clearing the due date.
        item = self.assert_json_success(self.patch(hamlet, message_id, clear_due="true"))
        self.assertIsNone(item["due"])

        # Archiving unstars and keeps the item.
        self.assert_json_success(self.patch(hamlet, message_id, state="archived"))
        self.assertEqual(self.state_of(hamlet, message_id), "archived")
        self.assertFalse(self.is_starred(hamlet, message_id))

        # Out of the archive (as completed) stars it again.
        item = self.assert_json_success(self.patch(hamlet, message_id, state="completed"))
        self.assertEqual(item["state"], "completed")
        self.assertEqual(self.state_of(hamlet, message_id), "completed")
        self.assertTrue(self.is_starred(hamlet, message_id))

        # Unstarring a completed item removes it.
        self.star(hamlet, message_id, "remove")
        self.assertIsNone(self.state_of(hamlet, message_id))

        # Starring an archived item's message brings it back in progress.
        self.assert_json_success(self.save(hamlet, message_id))
        self.assert_json_success(self.patch(hamlet, message_id, state="archived"))
        self.star(hamlet, message_id)
        self.assertEqual(self.state_of(hamlet, message_id), "in_progress")

        # Removing an item in any state unstars the message.
        self.assert_json_success(self.patch(hamlet, message_id, state="archived"))
        with self.capture_send_event_calls(expected_num_events=2) as events:
            self.assert_json_success(self.remove(hamlet, message_id))
        self.assertEqual(events[1]["event"]["op"], "remove")
        self.assertIsNone(self.state_of(hamlet, message_id))
        self.assertFalse(self.is_starred(hamlet, message_id))
        self.assert_json_success(self.save(hamlet, message_id))
        self.assert_json_success(self.remove(hamlet, message_id))
        self.assertFalse(self.is_starred(hamlet, message_id))
        # Removing what is not saved is not an error.
        self.assert_json_success(self.remove(hamlet, message_id))

    def test_invalid_requests(self) -> None:
        hamlet = self.example_user("hamlet")
        message_id = self.send_stream_message(self.example_user("iago"), "Verona", "later", "")
        self.assert_json_error(
            self.patch(hamlet, message_id, state="completed"), "This message is not saved."
        )
        self.assert_json_success(self.save(hamlet, message_id))
        self.assert_json_error(self.patch(hamlet, message_id, state="done"), "Invalid state: done")
        invalid_due = "Invalid due date: it must be a time in seconds."
        self.assert_json_error(self.patch(hamlet, message_id, due=-5), invalid_due)
        # Milliseconds sent by mistake, and a time no date can hold, are
        # refused rather than a server error.
        self.assert_json_error(self.patch(hamlet, message_id, due=1_900_000_000_000), invalid_due)
        self.assert_json_error(self.patch(hamlet, message_id, due=10**18), invalid_due)
        self.assert_json_error(self.save(hamlet, message_id, due=10**12), invalid_due)
        self.assert_json_success(self.patch(hamlet, message_id, due=253402300799))
        self.assert_json_error(
            self.patch(hamlet, message_id, due=1_900_000_000, clear_due="true"),
            "Set a due date or clear it, not both.",
        )
        self.assert_json_error(self.save(hamlet, 999999), "Invalid message(s)")

    def test_access_control(self) -> None:
        hamlet = self.example_user("hamlet")
        othello = self.example_user("othello")
        cordelia = self.example_user("cordelia")

        # Another user's direct message cannot be saved or changed.
        dm_id = self.send_personal_message(othello, cordelia, "private")
        self.assert_json_error(self.save(hamlet, dm_id), "Invalid message(s)")
        self.assert_json_success(self.save(cordelia, dm_id))
        self.assert_json_error(self.patch(hamlet, dm_id, state="completed"), "Invalid message(s)")
        self.assert_json_error(self.remove(hamlet, dm_id), "Invalid message(s)")
        # Nobody else's list shows cordelia's item.
        self.assertEqual(self.listed(hamlet), [])
        self.assertEqual([row["message_id"] for row in self.listed(cordelia)], [dm_id])

        # A private channel with protected history that hamlet left: what
        # was sent after he left is not his to save.
        self.make_stream("secret", invite_only=True, history_public_to_subscribers=False)
        self.subscribe(hamlet, "secret")
        self.subscribe(othello, "secret")
        received_id = self.send_stream_message(othello, "secret", "before", "")
        self.assert_json_success(self.save(hamlet, received_id))
        self.unsubscribe(hamlet, "secret")
        after_id = self.send_stream_message(othello, "secret", "after", "")
        self.assert_json_error(self.save(hamlet, after_id), "Invalid message(s)")
        # Having left the private channel, he can no longer read even
        # the message he received (Zulip's rule): it is not listed and
        # cannot be changed.
        self.assertEqual(self.listed(hamlet), [])
        self.assert_json_error(
            self.patch(hamlet, received_id, state="completed"), "Invalid message(s)"
        )
        # Reading the list dropped the item; the star (the UserMessage
        # row stays when one leaves) brings it back with access.
        self.assertFalse(SavedItem.objects.filter(user=hamlet).exists())
        self.subscribe(hamlet, "secret")
        self.assertEqual([row["message_id"] for row in self.listed(hamlet)], [received_id])

    def test_remove_after_access_is_lost(self) -> None:
        hamlet = self.example_user("hamlet")
        othello = self.example_user("othello")
        self.make_stream("secret", invite_only=True, history_public_to_subscribers=False)
        self.subscribe(hamlet, "secret")
        self.subscribe(othello, "secret")
        message_id = self.send_stream_message(othello, "secret", "before", "")
        self.assert_json_success(self.save(hamlet, message_id))
        self.unsubscribe(hamlet, "secret")
        # The item is the user's own: it can be removed, and the star
        # with it, though the message can no longer be read.
        self.assert_json_success(self.remove(hamlet, message_id))
        self.assertFalse(SavedItem.objects.filter(user=hamlet).exists())
        self.assertFalse(self.is_starred(hamlet, message_id))
        self.subscribe(hamlet, "secret")
        self.assertEqual(self.listed(hamlet), [])

    def test_caps_and_count(self) -> None:
        hamlet = self.example_user("hamlet")
        iago = self.example_user("iago")
        older_in_progress = self.send_stream_message(iago, "Verona", "older", "")
        self.assert_json_success(self.save(hamlet, older_in_progress))
        archived = [self.send_stream_message(iago, "Verona", f"a{i}", "") for i in range(4)]
        for message_id in archived:
            self.assert_json_success(self.save(hamlet, message_id))
            self.assert_json_success(self.patch(hamlet, message_id, state="archived"))
        # An item whose message is gone from the user's reach does not
        # take a place (a DM between two others, as if it had moved).
        lost_id = self.send_personal_message(iago, self.example_user("cordelia"), "not his")
        SavedItem.objects.create(user=hamlet, message_id=lost_id)
        with mock.patch("ykphone.lib.saved.MAX_SAVED_ITEMS_LISTED", 3):
            result = self.assert_json_success(self.api_get(hamlet, "/api/v1/ykphone/saved"))
        states = [(row["message_id"], row["state"]) for row in result["items"]]
        # Three archived (the newest), and the older item in progress
        # all the same.
        self.assertEqual(
            states,
            [(older_in_progress, "in_progress")]
            + [(message_id, "archived") for message_id in reversed(archived[1:])],
        )
        self.assertEqual(result["in_progress_count"], 1)
        self.assertFalse(SavedItem.objects.filter(message_id=lost_id).exists())

    def test_star_sync_query_count(self) -> None:
        hamlet = self.example_user("hamlet")
        iago = self.example_user("iago")
        ids = [self.send_stream_message(iago, "Verona", f"m{i}", "") for i in range(12)]

        def flag_queries(op: str, message_ids: list[int]) -> int:
            with CaptureQueriesContext(connection) as queries:
                do_update_message_flags(hamlet, op, "starred", message_ids)
            return len(queries)

        one_star = flag_queries("add", ids[:1])
        many_star = flag_queries("add", ids[1:])
        one_unstar = flag_queries("remove", ids[:1])
        many_unstar = flag_queries("remove", ids[1:])
        # The same number of queries for one message as for eleven.
        self.assertEqual(one_star, many_star)
        self.assertEqual(one_unstar, many_unstar)
        self.assertFalse(SavedItem.objects.filter(user=hamlet).exists())

    def test_backfill_and_cascade(self) -> None:
        hamlet = self.example_user("hamlet")
        message_id = self.send_stream_message(self.example_user("iago"), "Verona", "old", "")
        # A star from before the table existed.
        self.star(hamlet, message_id)
        SavedItem.objects.filter(user=hamlet).delete()
        self.assertEqual(
            [(row["message_id"], row["state"]) for row in self.listed(hamlet)],
            [(message_id, "in_progress")],
        )
        # Saving such a message again creates no second item.
        SavedItem.objects.filter(user=hamlet).delete()
        self.assert_json_success(self.save(hamlet, message_id))
        self.assertEqual(SavedItem.objects.filter(user=hamlet).count(), 1)

        # Deleting the message deletes the item.
        do_delete_messages(hamlet.realm, [Message.objects.get(id=message_id)], acting_user=None)
        self.assertFalse(SavedItem.objects.filter(user=hamlet).exists())

    def test_list_order(self) -> None:
        hamlet = self.example_user("hamlet")
        first = self.send_stream_message(hamlet, "Verona", "one", "")
        second = self.send_stream_message(hamlet, "Verona", "two", "")
        self.assert_json_success(self.save(hamlet, first))
        self.assert_json_success(self.save(hamlet, second))
        self.assertEqual([row["message_id"] for row in self.listed(hamlet)], [second, first])

    def test_login_required(self) -> None:
        result = self.client_get("/json/ykphone/saved")
        self.assert_json_error(
            result, "Not logged in: API authentication or user session required", 401
        )

    def test_apply_events_ignores_saved_events(self) -> None:
        hamlet = self.example_user("hamlet")
        state = {"zulip_version": "test"}
        apply_events(
            hamlet,
            state=state,
            events=[
                {"type": "ykphone_saved", "op": "add", "item": {"message_id": 1}},
                {"type": "ykphone_saved", "op": "remove", "message_id": 1},
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
