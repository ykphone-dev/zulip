from datetime import timedelta
from io import StringIO
from typing import Any

import orjson
import time_machine
from django.core.management import call_command
from django.utils.timezone import now as timezone_now

from ykphone.models import StatusExpiry
from zerver.actions.users import do_deactivate_user
from zerver.lib.test_classes import ZulipTestCase
from zerver.lib.timestamp import datetime_to_timestamp
from zerver.lib.user_status import get_user_status, update_user_status
from zerver.models import UserProfile
from zerver.models.clients import get_client


class StatusExpiryTest(ZulipTestCase):
    def set_status(self, user: UserProfile, status_text: str, emoji_name: str = "") -> None:
        params = {"status_text": status_text}
        if emoji_name:
            params["emoji_name"] = emoji_name
        self.assert_json_success(self.api_post(user, "/api/v1/users/me/status", params))

    def set_expiry(self, user: UserProfile, clear_at: int | None) -> Any:
        return self.api_put(
            user, "/api/v1/ykphone/status_expiry", {"clear_at": orjson.dumps(clear_at).decode()}
        )

    def expiries(self, user: UserProfile) -> dict[str, int]:
        return self.assert_json_success(self.api_get(user, "/api/v1/ykphone/status_expiry"))[
            "expiries"
        ]

    def clear_expired(self) -> str:
        output = StringIO()
        call_command("ykphone_clear_expired_statuses", stdout=output)
        return output.getvalue()

    def in_minutes(self, minutes: int) -> int:
        return datetime_to_timestamp(timezone_now() + timedelta(minutes=minutes))

    def test_expiry_clears_the_status(self) -> None:
        hamlet = self.example_user("hamlet")
        othello = self.example_user("othello")
        self.set_status(hamlet, "In a meeting", "calendar")
        clear_at = self.in_minutes(30)
        with self.capture_send_event_calls(expected_num_events=1) as events:
            self.assert_json_success(self.set_expiry(hamlet, clear_at))
        self.assertEqual(
            events[0]["event"],
            {"type": "ykphone_status_expiry", "user_id": hamlet.id, "clear_at": clear_at},
        )
        self.assertIn(othello.id, events[0]["users"])
        self.assertEqual(self.expiries(othello), {str(hamlet.id): clear_at})

        # Before the time, the command leaves it alone.
        self.clear_expired()
        self.assertEqual(get_user_status(hamlet)["status_text"], "In a meeting")

        with time_machine.travel(timezone_now() + timedelta(minutes=31), tick=False):
            with self.capture_send_event_calls(expected_num_events=2) as events:
                self.clear_expired()
        self.assertEqual(get_user_status(hamlet), {})
        # The expiry going away, then Zulip's own user_status event.
        self.assertEqual(events[0]["event"]["clear_at"], None)
        self.assertEqual(
            events[1]["event"],
            {
                "type": "user_status",
                "user_id": hamlet.id,
                "status_text": "",
                "emoji_name": "",
                "emoji_code": "",
                "reaction_type": "unicode_emoji",
            },
        )
        self.assertFalse(StatusExpiry.objects.filter(user=hamlet).exists())
        self.assertEqual(self.expiries(othello), {})

        # Running it again does nothing.
        with self.capture_send_event_calls(expected_num_events=0):
            self.clear_expired()

    def test_manual_changes_forget_the_expiry(self) -> None:
        hamlet = self.example_user("hamlet")
        self.set_status(hamlet, "Commuting", "bus")
        self.assert_json_success(self.set_expiry(hamlet, self.in_minutes(30)))

        # Setting another status by hand (from any client) drops it.
        with self.capture_send_event_calls(expected_num_events=2) as events:
            self.set_status(hamlet, "Working remotely", "house")
        self.assertEqual(events[0]["event"]["type"], "ykphone_status_expiry")
        self.assertEqual(events[0]["event"]["clear_at"], None)
        self.assertFalse(StatusExpiry.objects.filter(user=hamlet).exists())
        with time_machine.travel(timezone_now() + timedelta(hours=1), tick=False):
            self.clear_expired()
        self.assertEqual(get_user_status(hamlet)["status_text"], "Working remotely")

        # So does clearing it by hand.
        self.assert_json_success(self.set_expiry(hamlet, self.in_minutes(60)))
        self.set_status(hamlet, "")
        self.assert_json_success(
            self.api_post(hamlet, "/api/v1/users/me/status", {"emoji_name": ""})
        )
        self.assertFalse(StatusExpiry.objects.filter(user=hamlet).exists())

        # Changing only the deprecated "away" flag keeps it.
        self.set_status(hamlet, "Out sick", "sick")
        self.assert_json_success(self.set_expiry(hamlet, self.in_minutes(60)))
        self.assert_json_success(
            self.api_post(hamlet, "/api/v1/users/me/status", {"away": "true"})
        )
        self.assertTrue(StatusExpiry.objects.filter(user=hamlet).exists())

        # "Don't clear" removes it.
        with self.capture_send_event_calls(expected_num_events=1):
            self.assert_json_success(self.set_expiry(hamlet, None))
        self.assertFalse(StatusExpiry.objects.filter(user=hamlet).exists())
        with self.capture_send_event_calls(expected_num_events=0):
            self.assert_json_success(self.set_expiry(hamlet, None))

    def test_new_expiry_replaces_the_old(self) -> None:
        hamlet = self.example_user("hamlet")
        self.set_status(hamlet, "Vacationing", "palm_tree")
        self.assert_json_success(self.set_expiry(hamlet, self.in_minutes(30)))
        later = self.in_minutes(240)
        self.assert_json_success(self.set_expiry(hamlet, later))
        self.assertEqual(self.expiries(hamlet), {str(hamlet.id): later})
        with time_machine.travel(timezone_now() + timedelta(minutes=31), tick=False):
            self.clear_expired()
        self.assertEqual(get_user_status(hamlet)["status_text"], "Vacationing")

    def test_only_the_status_it_was_set_for_is_cleared(self) -> None:
        """The race: a new status saved after the job read the expiry but
        before it cleared (here, saved without going through
        do_update_user_status, whose hook would drop the row) stays."""
        hamlet = self.example_user("hamlet")
        self.set_status(hamlet, "In a meeting", "calendar")
        self.assert_json_success(self.set_expiry(hamlet, self.in_minutes(30)))
        expiry = StatusExpiry.objects.get(user=hamlet)
        self.assertEqual(
            (expiry.status_text, expiry.emoji_name, expiry.emoji_code),
            ("In a meeting", "calendar", "1f4c5"),
        )
        update_user_status(
            user_profile_id=hamlet.id,
            status_text="Lunch",
            client_id=get_client("website").id,
            emoji_name=None,
            emoji_code=None,
            reaction_type=None,
        )
        with (
            time_machine.travel(timezone_now() + timedelta(minutes=31), tick=False),
            self.capture_send_event_calls(expected_num_events=0),
        ):
            self.assertEqual(self.clear_expired(), "")
        self.assertEqual(get_user_status(hamlet)["status_text"], "Lunch")
        self.assertFalse(StatusExpiry.objects.exists())

    def test_invalid_requests(self) -> None:
        hamlet = self.example_user("hamlet")
        self.assert_json_error(
            self.set_expiry(hamlet, self.in_minutes(30)), "You have no status to clear."
        )
        self.set_status(hamlet, "Busy")
        for clear_at in (-1, 1_900_000_000_000):
            self.assert_json_error(
                self.set_expiry(hamlet, clear_at), "Invalid time: it must be a time in seconds."
            )
        self.assert_json_error(
            self.set_expiry(hamlet, self.in_minutes(-1)),
            "The time to clear the status must be in the future.",
        )
        self.assertFalse(StatusExpiry.objects.exists())
        result = self.client_get("/json/ykphone/status_expiry")
        self.assert_json_error(
            result, "Not logged in: API authentication or user session required", 401
        )

    def test_deactivated_user(self) -> None:
        hamlet = self.example_user("hamlet")
        self.set_status(hamlet, "Busy")
        self.assert_json_success(self.set_expiry(hamlet, self.in_minutes(30)))
        self.assertIn(str(hamlet.id), self.expiries(self.example_user("iago")))
        do_deactivate_user(hamlet, acting_user=None)
        self.assertEqual(self.expiries(self.example_user("iago")), {})
        with time_machine.travel(timezone_now() + timedelta(hours=1), tick=False):
            self.assertEqual(self.clear_expired(), "")
        self.assertFalse(StatusExpiry.objects.exists())
        # The status itself is left as it was.
        self.assertEqual(get_user_status(hamlet)["status_text"], "Busy")

    def test_limited_user_access(self) -> None:
        self.set_up_db_for_testing_user_access()
        polonius = self.example_user("polonius")
        for name in ("hamlet", "othello"):
            user = self.example_user(name)
            self.set_status(user, "Busy")
            self.assert_json_success(self.set_expiry(user, self.in_minutes(30)))
        # The guest can see hamlet (they share a channel) but not othello.
        self.assertEqual(list(self.expiries(polonius)), [str(self.example_user("hamlet").id)])

    def test_command_output(self) -> None:
        hamlet = self.example_user("hamlet")
        self.set_status(hamlet, "Busy")
        self.assert_json_success(self.set_expiry(hamlet, self.in_minutes(30)))
        with time_machine.travel(timezone_now() + timedelta(hours=1), tick=False):
            self.assertEqual(self.clear_expired(), "Expired statuses cleared: 1\n")
