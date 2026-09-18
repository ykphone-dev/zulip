from datetime import datetime, timedelta
from io import StringIO
from typing import Any
from unittest import mock
from zoneinfo import ZoneInfo

import orjson
import responses
import time_machine
from django.core.management import call_command
from django.db import ProgrammingError, connection
from django.test import override_settings
from django.utils.timezone import now as timezone_now

from ykphone.lib.notification_pause import (
    announce_paused_flips,
    get_pause,
    is_paused,
    pause_dict,
    skip_paused_notification,
)
from ykphone.models import NotificationPause
from zerver.actions.user_settings import do_change_user_setting
from zerver.lib.email_notifications import MissedMessageData, handle_missedmessage_emails
from zerver.lib.events import apply_events
from zerver.lib.push_notifications import handle_push_notification, handle_remove_push_notification
from zerver.lib.test_classes import PushNotificationTestCase, ZulipTestCase
from zerver.lib.test_helpers import activate_push_notification_service
from zerver.lib.timestamp import datetime_to_timestamp
from zerver.models import Recipient, ScheduledMessageNotificationEmail, UserMessage, UserProfile
from zerver.models.scheduled_jobs import NotificationTriggers
from zerver.worker.missedmessage_emails import MissedMessageWorker

UTC = ZoneInfo("UTC")
SEOUL = ZoneInfo("Asia/Seoul")
NEW_YORK = ZoneInfo("America/New_York")

WEEKDAYS_9_TO_18 = {"enabled": True, "days": [0, 1, 2, 3, 4], "start": "09:00", "end": "18:00"}


def pause_with(
    schedule: dict[str, Any] | None = None, paused_until: datetime | None = None
) -> NotificationPause:
    return NotificationPause(paused_until=paused_until, schedule=schedule or {})


def at(tz: ZoneInfo, year: int, month: int, day: int, hour: int, minute: int) -> datetime:
    """A wall-clock time in the zone, as the aware instant it is."""
    return datetime(year, month, day, hour, minute, tzinfo=tz)


class IsPausedTest(ZulipTestCase):
    def test_nothing_set(self) -> None:
        now = at(UTC, 2026, 9, 14, 12, 0)
        self.assertFalse(is_paused(None, now, UTC))
        self.assertFalse(is_paused(pause_with(), now, UTC))
        # A schedule that is off never pauses, whatever it says.
        off = {**WEEKDAYS_9_TO_18, "enabled": False}
        self.assertFalse(is_paused(pause_with(off), at(UTC, 2026, 9, 13, 3, 0), UTC))

    def test_paused_until(self) -> None:
        now = at(UTC, 2026, 9, 14, 12, 0)
        self.assertTrue(is_paused(pause_with(paused_until=now + timedelta(minutes=30)), now, UTC))
        # The end is not included, and an end in the past is no pause.
        self.assertFalse(is_paused(pause_with(paused_until=now), now, UTC))
        self.assertFalse(is_paused(pause_with(paused_until=now - timedelta(minutes=1)), now, UTC))
        # A pause wins over the schedule's hours.
        self.assertTrue(
            is_paused(pause_with(WEEKDAYS_9_TO_18, paused_until=now + timedelta(hours=1)), now, UTC)
        )

    def test_day_window(self) -> None:
        pause = pause_with(WEEKDAYS_9_TO_18)
        # 2026-09-14 is a Monday.
        self.assertTrue(is_paused(pause, at(UTC, 2026, 9, 14, 8, 59), UTC))
        self.assertFalse(is_paused(pause, at(UTC, 2026, 9, 14, 9, 0), UTC))
        self.assertFalse(is_paused(pause, at(UTC, 2026, 9, 14, 17, 59), UTC))
        self.assertTrue(is_paused(pause, at(UTC, 2026, 9, 14, 18, 0), UTC))
        # Friday is in, the weekend is out all day.
        self.assertFalse(is_paused(pause, at(UTC, 2026, 9, 18, 12, 0), UTC))
        self.assertTrue(is_paused(pause, at(UTC, 2026, 9, 19, 12, 0), UTC))
        self.assertTrue(is_paused(pause, at(UTC, 2026, 9, 20, 12, 0), UTC))

    def test_user_time_zone(self) -> None:
        pause = pause_with(WEEKDAYS_9_TO_18)
        # Monday 01:00 UTC is Monday 10:00 in Seoul: inside the hours
        # there, outside them in UTC.
        now = at(UTC, 2026, 9, 14, 1, 0)
        self.assertFalse(is_paused(pause, now, SEOUL))
        self.assertTrue(is_paused(pause, now, UTC))
        # Sunday 20:00 UTC is already Monday 05:00 in Seoul: before the
        # hours, so paused in both.
        self.assertTrue(is_paused(pause, at(UTC, 2026, 9, 13, 20, 0), SEOUL))

    def test_overnight_window(self) -> None:
        # Night shifts, Monday and Tuesday nights, 22:00 to 06:00.
        pause = pause_with({"enabled": True, "days": [0, 1], "start": "22:00", "end": "06:00"})
        self.assertTrue(is_paused(pause, at(UTC, 2026, 9, 14, 21, 59), UTC))
        self.assertFalse(is_paused(pause, at(UTC, 2026, 9, 14, 22, 0), UTC))
        # After midnight the window still belongs to Monday night.
        self.assertFalse(is_paused(pause, at(UTC, 2026, 9, 15, 5, 59), UTC))
        self.assertTrue(is_paused(pause, at(UTC, 2026, 9, 15, 6, 0), UTC))
        # Tuesday night runs into Wednesday; Wednesday night is not in.
        self.assertFalse(is_paused(pause, at(UTC, 2026, 9, 16, 3, 0), UTC))
        self.assertTrue(is_paused(pause, at(UTC, 2026, 9, 16, 23, 0), UTC))
        # Monday before 06:00 would be Sunday night's window: not in.
        self.assertTrue(is_paused(pause, at(UTC, 2026, 9, 14, 3, 0), UTC))

    def test_start_equals_end_is_a_whole_day(self) -> None:
        pause = pause_with({"enabled": True, "days": [0], "start": "00:00", "end": "00:00"})
        self.assertFalse(is_paused(pause, at(UTC, 2026, 9, 14, 0, 0), UTC))
        self.assertFalse(is_paused(pause, at(UTC, 2026, 9, 14, 23, 59), UTC))
        self.assertTrue(is_paused(pause, at(UTC, 2026, 9, 15, 0, 0), UTC))
        self.assertTrue(is_paused(pause, at(UTC, 2026, 9, 13, 23, 59), UTC))

    def test_empty_days(self) -> None:
        # A schedule that is on with no days allows nothing: always paused.
        pause = pause_with({"enabled": True, "days": [], "start": "09:00", "end": "18:00"})
        for day in range(14, 21):
            self.assertTrue(is_paused(pause, at(UTC, 2026, 9, day, 12, 0), UTC))

    def test_no_time_zone(self) -> None:
        # Without a zone the schedule's hours mean nothing: not applied.
        # A timed pause still is.
        now = at(UTC, 2026, 9, 14, 3, 0)
        self.assertTrue(is_paused(pause_with(WEEKDAYS_9_TO_18), now, UTC))
        self.assertFalse(is_paused(pause_with(WEEKDAYS_9_TO_18), now, None))
        self.assertTrue(is_paused(pause_with(paused_until=now + timedelta(minutes=1)), now, None))
        # A stored schedule that no longer reads counts as off.
        self.assertFalse(is_paused(pause_with({"enabled": True}), now, UTC))

    def test_daylight_saving_time(self) -> None:
        pause = pause_with({"enabled": True, "days": [6], "start": "09:00", "end": "18:00"})
        # 2026-03-08 (a Sunday): New York moves from UTC-5 to UTC-4 at
        # 02:00. The hours stay 09:00-18:00 on the wall clock.
        self.assertFalse(is_paused(pause, at(UTC, 2026, 3, 8, 13, 0), NEW_YORK))  # 09:00 EDT
        self.assertTrue(is_paused(pause, at(UTC, 2026, 3, 8, 12, 59), NEW_YORK))  # 08:59 EDT
        self.assertTrue(is_paused(pause, at(UTC, 2026, 3, 8, 22, 0), NEW_YORK))  # 18:00 EDT
        # The Sunday before, still EST: 09:00 is 14:00 UTC.
        self.assertTrue(is_paused(pause, at(UTC, 2026, 3, 1, 13, 30), NEW_YORK))  # 08:30 EST
        self.assertFalse(is_paused(pause, at(UTC, 2026, 3, 1, 14, 0), NEW_YORK))  # 09:00 EST
        # On the day clocks go back (2026-11-01), 01:30 happens twice;
        # a 01:00-02:00 window holds both.
        night = pause_with({"enabled": True, "days": [6], "start": "01:00", "end": "02:00"})
        self.assertFalse(is_paused(night, at(UTC, 2026, 11, 1, 5, 30), NEW_YORK))  # 01:30 EDT
        self.assertFalse(is_paused(night, at(UTC, 2026, 11, 1, 6, 30), NEW_YORK))  # 01:30 EST
        self.assertTrue(is_paused(night, at(UTC, 2026, 11, 1, 7, 30), NEW_YORK))  # 02:30 EST


class NotificationPauseAPITest(ZulipTestCase):
    def patch(self, user: UserProfile, **params: Any) -> Any:
        return self.api_patch(
            user,
            "/api/v1/ykphone/notification_pause",
            {key: orjson.dumps(value).decode() for key, value in params.items()},
        )

    def get_state(self, user: UserProfile) -> dict[str, Any]:
        return self.assert_json_success(self.api_get(user, "/api/v1/ykphone/notification_pause"))

    def test_pause_and_resume(self) -> None:
        hamlet = self.example_user("hamlet")
        othello = self.example_user("othello")
        state = self.get_state(hamlet)
        self.assertEqual(state["until"], None)
        self.assertEqual(state["paused"], False)
        self.assertEqual(state["schedule"]["enabled"], False)
        self.assertEqual(state["paused_user_ids"], [])
        self.assertEqual(state["mobile"], None)

        until = datetime_to_timestamp(timezone_now() + timedelta(minutes=30))
        with self.capture_send_event_calls(expected_num_events=2) as events:
            result = self.patch(hamlet, until=until)
        self.assertEqual(self.assert_json_success(result)["until"], until)
        self.assertEqual(
            events[0]["event"],
            {
                "type": "ykphone_notification_pause",
                "until": until,
                "schedule": state["schedule"],
                "mobile": None,
            },
        )
        self.assertEqual(events[0]["users"], [hamlet.id])
        # Everyone hears the flag, not the end time.
        self.assertEqual(
            events[1]["event"],
            {"type": "ykphone_paused_users", "user_id": hamlet.id, "paused": True},
        )
        self.assertIn(othello.id, events[1]["users"])
        self.assertEqual(self.get_state(othello)["paused_user_ids"], [hamlet.id])
        self.assertTrue(self.get_state(hamlet)["paused"])

        # Pausing longer changes the end, not the flag: only the user hears.
        with self.capture_send_event_calls(expected_num_events=1):
            self.assert_json_success(self.patch(hamlet, until=until + 3600))

        with self.capture_send_event_calls(expected_num_events=2) as events:
            self.assert_json_success(self.patch(hamlet, clear_until=True))
        self.assertEqual(events[0]["event"]["until"], None)
        self.assertEqual(events[1]["event"]["paused"], False)
        self.assertEqual(self.get_state(othello)["paused_user_ids"], [])

        # A pause that has run out is no pause.
        with time_machine.travel(timezone_now() + timedelta(hours=1), tick=False):
            self.assert_json_success(self.patch(hamlet, until=until))
            self.assertEqual(self.get_state(hamlet)["until"], None)
            self.assertEqual(self.get_state(othello)["paused_user_ids"], [])

    def test_schedule(self) -> None:
        hamlet = self.example_user("hamlet")
        do_change_user_setting(hamlet, "timezone", "Asia/Seoul", acting_user=hamlet)
        # A Monday, 10:00 in Seoul.
        monday_ten = at(SEOUL, 2026, 9, 14, 10, 0)
        with time_machine.travel(monday_ten, tick=False):
            with self.capture_send_event_calls(expected_num_events=1):
                result = self.patch(hamlet, schedule=WEEKDAYS_9_TO_18)
            self.assertEqual(self.assert_json_success(result)["schedule"], WEEKDAYS_9_TO_18)
            self.assertFalse(self.get_state(hamlet)["paused"])
            # Shrinking the hours to the afternoon pauses now.
            afternoon = {**WEEKDAYS_9_TO_18, "start": "13:00", "days": [4, 0]}
            with self.capture_send_event_calls(expected_num_events=2) as events:
                self.assert_json_success(self.patch(hamlet, schedule=afternoon))
            self.assertEqual(events[0]["event"]["schedule"]["days"], [0, 4])
            self.assertEqual(events[1]["event"]["paused"], True)
            self.assertEqual(
                self.get_state(self.example_user("iago"))["paused_user_ids"], [hamlet.id]
            )
        # The clock moves into the hours: nothing is sent, but the page
        # load's list follows.
        with time_machine.travel(monday_ten + timedelta(hours=4), tick=False):
            self.assertFalse(self.get_state(hamlet)["paused"])
            self.assertEqual(self.get_state(self.example_user("iago"))["paused_user_ids"], [])

    def test_invalid_requests(self) -> None:
        hamlet = self.example_user("hamlet")
        self.assert_json_error(self.patch(hamlet), "Nothing to change.")
        self.assert_json_error(
            self.patch(hamlet, until=1, clear_until=True),
            "Pass either until or clear_until, not both.",
        )
        for until in (-5, 1_900_000_000_000):
            self.assert_json_error(
                self.patch(hamlet, until=until), "Invalid pause end: it must be a time in seconds."
            )
        for schedule in (
            {"enabled": True},
            {**WEEKDAYS_9_TO_18, "extra": 1},
            {**WEEKDAYS_9_TO_18, "enabled": "yes"},
        ):
            self.assert_json_error(
                self.patch(hamlet, schedule=schedule), "Invalid notification schedule."
            )
        for days in ([7], [-1], [1, 1], "0,1", [True]):
            self.assert_json_error(
                self.patch(hamlet, schedule={**WEEKDAYS_9_TO_18, "days": days}),
                "Invalid notification schedule: days must be numbers from 0 to 6.",
            )
        # An enabled schedule needs a day (with none it would pause for good).
        self.assert_json_error(
            self.patch(hamlet, schedule={**WEEKDAYS_9_TO_18, "days": []}),
            "Choose at least one day.",
        )
        for time in ("9:00", "24:00", "09:60", 900):
            self.assert_json_error(
                self.patch(hamlet, schedule={**WEEKDAYS_9_TO_18, "start": time}),
                "Invalid notification schedule: times must look like 09:00.",
            )
        self.assertFalse(NotificationPause.objects.filter(user=hamlet).exists())
        # Logged out: no access.
        result = self.client_get("/json/ykphone/notification_pause")
        self.assert_json_error(
            result, "Not logged in: API authentication or user session required", 401
        )

    def test_empty_time_zone(self) -> None:
        # Users created other than by the signup form have no zone; for a
        # Korean user UTC hours would pause the working day, so the
        # schedule is not applied until the web app has set the zone.
        hamlet = self.example_user("hamlet")
        do_change_user_setting(hamlet, "timezone", "", acting_user=hamlet)
        with time_machine.travel(at(UTC, 2026, 9, 14, 3, 0), tick=False):
            result = self.assert_json_success(self.patch(hamlet, schedule=WEEKDAYS_9_TO_18))
            self.assertFalse(result["paused"])
            self.assertFalse(result["has_timezone"])
            self.assertFalse(skip_paused_notification(hamlet, "email"))
            for zone, paused in [
                # 03:00 UTC is 12:00 in Seoul: inside the hours.
                ("Asia/Seoul", False),
                # 23:00 on Sunday in New York: outside them.
                ("America/New_York", True),
            ]:
                do_change_user_setting(hamlet, "timezone", zone, acting_user=hamlet)
                user = self.example_user("hamlet")
                state = pause_dict(get_pause(user), user)
                self.assertTrue(state["has_timezone"])
                self.assertEqual(state["paused"], paused)

    def test_mobile_preference(self) -> None:
        hamlet = self.example_user("hamlet")
        with self.capture_send_event_calls(expected_num_events=1) as events:
            result = self.assert_json_success(self.patch(hamlet, mobile=False))
        self.assertEqual(result["mobile"], False)
        self.assertEqual(events[0]["event"]["mobile"], False)
        self.assertEqual(self.get_state(hamlet)["mobile"], False)
        self.assert_json_success(self.patch(hamlet, mobile=True))
        self.assertEqual(self.get_state(hamlet)["mobile"], True)

    def test_bots_cannot_use_it(self) -> None:
        bot = self.example_user("default_bot")
        self.assert_json_error(
            self.api_get(bot, "/api/v1/ykphone/notification_pause"),
            "This endpoint does not accept bot requests.",
        )

    def test_announce_paused_flips(self) -> None:
        hamlet = self.example_user("hamlet")
        othello = self.example_user("othello")
        do_change_user_setting(hamlet, "timezone", "Asia/Seoul", acting_user=hamlet)
        monday_17_59 = at(SEOUL, 2026, 9, 14, 17, 59)
        with time_machine.travel(monday_17_59, tick=False):
            self.assert_json_success(self.patch(hamlet, schedule=WEEKDAYS_9_TO_18))
            self.assert_json_success(self.patch(othello, until=int(monday_17_59.timestamp()) + 90))
            # Nothing changed by itself yet.
            with self.capture_send_event_calls(expected_num_events=0):
                self.assertEqual(announce_paused_flips(), [])
        # 18:01: hamlet's hours ended and othello's pause ran out.
        with (
            time_machine.travel(monday_17_59 + timedelta(minutes=2), tick=False),
            self.capture_send_event_calls(expected_num_events=2) as events,
        ):
            self.assertEqual(sorted(announce_paused_flips()), sorted([hamlet.id, othello.id]))
        self.assertEqual(
            sorted((event["event"]["user_id"], event["event"]["paused"]) for event in events),
            sorted([(hamlet.id, True), (othello.id, False)]),
        )
        self.assertIn(othello.id, events[0]["users"])
        self.assertIsNone(NotificationPause.objects.get(user=othello).paused_until)
        # The next minute: nothing new; a missed minute is caught up.
        with (
            time_machine.travel(monday_17_59 + timedelta(minutes=3), tick=False),
            self.capture_send_event_calls(expected_num_events=0),
        ):
            self.assertEqual(announce_paused_flips(), [])
        # A change of time zone moves hamlet into his hours (18:03 in
        # Seoul is 09:03 in UTC).
        do_change_user_setting(hamlet, "timezone", "UTC", acting_user=hamlet)
        with (
            time_machine.travel(monday_17_59 + timedelta(minutes=4), tick=False),
            self.capture_send_event_calls(expected_num_events=1) as events,
        ):
            self.assertEqual(announce_paused_flips(), [hamlet.id])
        self.assertEqual(events[0]["event"]["paused"], False)
        # The command runs it every minute.
        with time_machine.travel(monday_17_59 + timedelta(minutes=5), tick=False):
            output = StringIO()
            call_command("ykphone_clear_expired_statuses", stdout=output)
            self.assertEqual(output.getvalue(), "")

    def test_limited_user_access(self) -> None:
        hamlet = self.example_user("hamlet")
        polonius = self.example_user("polonius")
        self.set_up_db_for_testing_user_access()
        until = datetime_to_timestamp(timezone_now() + timedelta(hours=1))
        for name in ("hamlet", "othello"):
            self.assert_json_success(self.patch(self.example_user(name), until=until))
        # The guest can see hamlet (they share a channel) but not othello.
        self.assertEqual(self.get_state(polonius)["paused_user_ids"], [hamlet.id])
        self.assertEqual(
            self.get_state(hamlet)["paused_user_ids"],
            sorted([hamlet.id, self.example_user("othello").id]),
        )

    def test_apply_events_ignores_fork_events(self) -> None:
        hamlet = self.example_user("hamlet")
        state = {"zulip_version": "test"}
        apply_events(
            hamlet,
            state=state,
            events=[
                {"type": "ykphone_notification_pause", "until": None, "schedule": {}},
                {"type": "ykphone_paused_users", "user_id": hamlet.id, "paused": True},
                {"type": "ykphone_status_expiry", "user_id": hamlet.id, "clear_at": None},
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


class PausedEmailNotificationTest(ZulipTestCase):
    def test_missed_message_email(self) -> None:
        hamlet = self.example_user("hamlet")
        message_id = self.send_personal_message(self.example_user("othello"), hamlet, "hi")
        missed = {message_id: MissedMessageData(trigger=NotificationTriggers.DIRECT_MESSAGE)}
        NotificationPause.objects.create(
            user=hamlet, paused_until=timezone_now() + timedelta(minutes=30)
        )
        with (
            mock.patch(
                "zerver.lib.email_notifications.do_send_missedmessage_events_reply_in_zulip"
            ) as send,
            self.assertLogs(level="INFO") as logs,
        ):
            handle_missedmessage_emails(hamlet.id, missed)
        send.assert_not_called()
        self.assertEqual(
            logs.output, [f"INFO:root:ykphone: email notification skipped, user {hamlet.id} paused"]
        )

        # Once the pause is over, the next email goes out; the one held
        # back was dropped, not kept for later (the worker already
        # handed it over).
        with (
            time_machine.travel(timezone_now() + timedelta(hours=1), tick=False),
            mock.patch(
                "zerver.lib.email_notifications.do_send_missedmessage_events_reply_in_zulip"
            ) as send,
        ):
            handle_missedmessage_emails(hamlet.id, missed)
        send.assert_called_once()

    def test_skip_is_false_when_not_paused(self) -> None:
        hamlet = self.example_user("hamlet")
        do_change_user_setting(hamlet, "timezone", "UTC", acting_user=hamlet)
        self.assertFalse(skip_paused_notification(hamlet, "email"))
        # (A schedule with no days can only be stored directly.)
        NotificationPause.objects.create(user=hamlet, schedule={**WEEKDAYS_9_TO_18, "days": []})
        with self.assertLogs(level="INFO"):
            self.assertTrue(skip_paused_notification(hamlet, "push"))

    def test_lookup_failure_fails_open_in_the_batch(self) -> None:
        """A failing pause lookup (say, the table is missing because the
        code went live before the migration) must not cost anyone their
        email: the batch runs in one transaction, which the lookup's
        savepoint keeps usable."""
        hamlet = self.example_user("hamlet")
        othello = self.example_user("othello")
        cordelia = self.example_user("cordelia")
        for user in (hamlet, othello):
            message_id = self.send_personal_message(cordelia, user, "hi")
            ScheduledMessageNotificationEmail.objects.create(
                user_profile=user,
                message_id=message_id,
                trigger=NotificationTriggers.DIRECT_MESSAGE,
                scheduled_timestamp=timezone_now() - timedelta(minutes=1),
            )

        def broken_lookup(user_profile: UserProfile) -> None:
            if user_profile.id == hamlet.id:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT * FROM ykphone_no_such_table")

        with (
            mock.patch("ykphone.lib.notification_pause.get_pause", side_effect=broken_lookup),
            mock.patch(
                "zerver.lib.email_notifications.do_send_missedmessage_events_reply_in_zulip"
            ) as send,
            self.assertLogs(level="INFO") as logs,
        ):
            MissedMessageWorker().maybe_send_batched_emails()
        self.assertEqual(
            sorted(call.args[0].id for call in send.call_args_list), sorted([hamlet.id, othello.id])
        )
        # Sent once and forgotten: nothing is sent again.
        self.assertFalse(ScheduledMessageNotificationEmail.objects.exists())
        failures = [line for line in logs.output if "pause lookup failed" in line]
        self.assert_length(failures, 1)
        self.assertIn(f"user {hamlet.id}", failures[0])


class PausedPushNotificationTest(PushNotificationTestCase):
    DEFAULT_SUBDOMAIN = ""

    def send_mocks(self) -> tuple[Any, Any]:
        return (
            mock.patch(
                "zerver.lib.push_notifications.send_apple_push_notification", return_value=1
            ),
            mock.patch(
                "zerver.lib.push_notifications.send_android_push_notification", return_value=1
            ),
        )

    @activate_push_notification_service()
    @responses.activate
    @mock.patch("zerver.lib.push_notifications.push_notifications_configured", return_value=True)
    @override_settings(ZULIP_SERVICE_PUSH_NOTIFICATIONS=False, ZULIP_SERVICES=set())
    def test_push_skipped_while_paused(self, mock_configured: mock.MagicMock) -> None:
        self.setup_apns_tokens()
        self.setup_fcm_tokens()
        user_profile = self.example_user("hamlet")
        message = self.get_message(
            Recipient.DIRECT_MESSAGE_GROUP,
            type_id=self.dm_group.id,
            realm_id=self.dm_recipient_user.realm_id,
        )
        usermessage = UserMessage.objects.create(user_profile=user_profile, message=message)
        missed_message = {"message_id": message.id, "trigger": NotificationTriggers.DIRECT_MESSAGE}
        NotificationPause.objects.create(
            user=user_profile, paused_until=timezone_now() + timedelta(minutes=30)
        )

        apple, android = self.send_mocks()
        with apple as send_apple, android as send_android, self.assertLogs(level="INFO") as logs:
            handle_push_notification(user_profile.id, missed_message)
        send_apple.assert_not_called()
        send_android.assert_not_called()
        self.assertIn(f"push notification skipped, user {user_profile.id} paused", logs.output[0])
        # Nothing is marked as notified, so nothing is revoked later
        # and nothing is sent when the pause ends.
        usermessage.refresh_from_db()
        self.assertFalse(usermessage.flags.active_mobile_push_notification)

        # Not paused: the next notification is sent.
        NotificationPause.objects.filter(user=user_profile).update(paused_until=None)
        apple, android = self.send_mocks()
        with apple as send_apple, android as send_android:
            handle_push_notification(user_profile.id, missed_message)
        send_apple.assert_called_once()
        send_android.assert_called_once()
        usermessage.refresh_from_db()
        self.assertTrue(usermessage.flags.active_mobile_push_notification)

    @activate_push_notification_service()
    @responses.activate
    @mock.patch("zerver.lib.push_notifications.push_notifications_configured", return_value=True)
    @override_settings(ZULIP_SERVICE_PUSH_NOTIFICATIONS=False, ZULIP_SERVICES=set())
    def test_push_lookup_failure_fails_open(self, mock_configured: mock.MagicMock) -> None:
        self.setup_apns_tokens()
        self.setup_fcm_tokens()
        user_profile = self.example_user("hamlet")
        message = self.get_message(
            Recipient.DIRECT_MESSAGE_GROUP,
            type_id=self.dm_group.id,
            realm_id=self.dm_recipient_user.realm_id,
        )
        UserMessage.objects.create(user_profile=user_profile, message=message)
        missed_message = {"message_id": message.id, "trigger": NotificationTriggers.DIRECT_MESSAGE}
        apple, android = self.send_mocks()
        with (
            mock.patch(
                "ykphone.lib.notification_pause.get_pause", side_effect=ProgrammingError("gone")
            ),
            apple as send_apple,
            android as send_android,
            self.assertLogs(level="ERROR") as logs,
        ):
            handle_push_notification(user_profile.id, missed_message)
        send_apple.assert_called_once()
        send_android.assert_called_once()
        self.assertIn(f"pause lookup failed for user {user_profile.id}", logs.output[0])

    @activate_push_notification_service()
    @responses.activate
    @mock.patch("zerver.lib.push_notifications.push_notifications_configured", return_value=True)
    @override_settings(ZULIP_SERVICE_PUSH_NOTIFICATIONS=False, ZULIP_SERVICES=set())
    def test_removals_go_through_while_paused(self, mock_configured: mock.MagicMock) -> None:
        self.setup_apns_tokens()
        self.setup_fcm_tokens()
        user_profile = self.example_user("hamlet")
        message = self.get_message(
            Recipient.DIRECT_MESSAGE_GROUP,
            type_id=self.dm_group.id,
            realm_id=self.dm_recipient_user.realm_id,
        )
        UserMessage.objects.create(
            user_profile=user_profile,
            message=message,
            flags=UserMessage.flags.active_mobile_push_notification,
        )
        # A notification sent before the pause is still taken off the
        # phone when the message is read during it.
        NotificationPause.objects.create(
            user=user_profile, paused_until=timezone_now() + timedelta(minutes=30)
        )
        apple, android = self.send_mocks()
        with apple as send_apple, android as send_android:
            handle_remove_push_notification(user_profile.id, [message.id])
        send_apple.assert_called_once()
        send_android.assert_called_once()
        self.assertFalse(
            UserMessage.objects.get(
                user_profile=user_profile, message=message
            ).flags.active_mobile_push_notification
        )
