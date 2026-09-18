"""Pausing notifications (Slack's "Pause notifications" and
notification schedule) for the 옆커폰 fork.

A user is paused while ``NotificationPause.paused_until`` lies ahead,
or while their notification schedule is on and the time (in the user's
own Zulip time zone) is outside the hours it allows. While paused:

* mobile push and missed-message email notifications are skipped when
  they are about to be delivered (``skip_paused_notification``, called
  from Zulip's push and email delivery); nothing held back is sent
  when the pause ends, and removals of push notifications for messages
  that were read still go through;
* the web app plays no sound and shows no desktop notification (it
  decides by itself, from the state this module sends it);
* other users see that the user's notifications are paused, but not
  until when: ``ykphone_paused_users`` events carry only the flag, and
  are sent when a change of the user's settings flips it (a pause that
  runs out or a schedule's hours starting are picked up when the page
  loads next).
"""

import logging
import re
from datetime import datetime
from typing import TypedDict
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.db import transaction
from django.db.models import Q
from django.utils.timezone import now as timezone_now
from django.utils.translation import gettext as _

from ykphone.lib.saved import MAX_DUE_TIMESTAMP
from ykphone.models import NotificationPause
from zerver.lib.exceptions import JsonableError
from zerver.lib.timestamp import datetime_to_timestamp, timestamp_to_datetime
from zerver.lib.users import (
    check_user_can_access_all_users,
    get_accessible_user_ids,
    get_user_ids_who_can_access_user,
)
from zerver.models import UserProfile
from zerver.tornado.django_api import send_event_on_commit


class NotificationSchedule(TypedDict):
    enabled: bool
    # Monday is 0, as in Python's datetime.weekday().
    days: list[int]
    start: str
    end: str


# A new user's schedule, off: Slack's default of weekdays, 9 to 18.
DEFAULT_SCHEDULE = NotificationSchedule(
    enabled=False, days=[0, 1, 2, 3, 4], start="09:00", end="18:00"
)

TIME_RE = re.compile(r"^([01][0-9]|2[0-3]):[0-5][0-9]$")


def minutes_of(time: str) -> int:
    hours, minutes = time.split(":")
    return int(hours) * 60 + int(minutes)


def check_schedule(schedule: object) -> NotificationSchedule:
    """A schedule sent by a client; an enabled one needs a day, since
    with none it would pause every notification for good."""
    parsed = parse_schedule(schedule)
    if parsed["enabled"] and not parsed["days"]:
        raise JsonableError(_("Choose at least one day."))
    return parsed


def parse_schedule(schedule: object) -> NotificationSchedule:
    if not isinstance(schedule, dict) or set(schedule) != {"enabled", "days", "start", "end"}:
        raise JsonableError(_("Invalid notification schedule."))
    enabled = schedule["enabled"]
    days = schedule["days"]
    start = schedule["start"]
    end = schedule["end"]
    if not isinstance(enabled, bool):
        raise JsonableError(_("Invalid notification schedule."))
    if (
        not isinstance(days, list)
        or any(type(day) is not int or not 0 <= day <= 6 for day in days)
        or len(set(days)) != len(days)
    ):
        raise JsonableError(_("Invalid notification schedule: days must be numbers from 0 to 6."))
    if not isinstance(start, str) or not isinstance(end, str):
        raise JsonableError(_("Invalid notification schedule: times must look like 09:00."))
    if TIME_RE.match(start) is None or TIME_RE.match(end) is None:
        raise JsonableError(_("Invalid notification schedule: times must look like 09:00."))
    return NotificationSchedule(enabled=enabled, days=sorted(days), start=start, end=end)


def check_until(until: int | None, now: datetime) -> datetime | None:
    """A time the pause ends, in seconds. A time already past means no
    pause (the menu's "resume" sends null)."""
    if until is None:
        return None
    if until < 0 or until > MAX_DUE_TIMESTAMP:
        raise JsonableError(_("Invalid pause end: it must be a time in seconds."))
    paused_until = timestamp_to_datetime(until)
    if paused_until <= now:
        return None
    return paused_until


def user_timezone(user_profile: UserProfile) -> ZoneInfo | None:
    """The user's Zulip time zone setting, or None when it is unset or
    not a zone this server knows. The web app fills an unset one from
    the browser before a schedule is set; without a zone the schedule's
    hours mean nothing, so it is not applied (UTC would silence a Korean
    user's working day)."""
    if not user_profile.timezone:
        return None
    try:
        return ZoneInfo(user_profile.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        return None


def stored_schedule(pause: NotificationPause | None) -> NotificationSchedule:
    """The schedule as stored (checked when it was saved); the default,
    which is off, when there is none or it no longer reads."""
    if pause is None or not pause.schedule:
        return DEFAULT_SCHEDULE
    try:
        return parse_schedule(pause.schedule)
    except JsonableError:
        return DEFAULT_SCHEDULE


def schedule_allows(schedule: NotificationSchedule, local: datetime) -> bool:
    """Whether the schedule's hours include the local wall-clock time.
    A window whose end is at or before its start runs past midnight
    into the next day (start == end is a whole day from the start); it
    belongs to the day it starts on."""
    days = set(schedule["days"])
    start = minutes_of(schedule["start"])
    end = minutes_of(schedule["end"])
    minute = local.hour * 60 + local.minute
    weekday = local.weekday()
    if start < end:
        return weekday in days and start <= minute < end
    previous_day = (weekday - 1) % 7
    return (weekday in days and minute >= start) or (previous_day in days and minute < end)


def is_paused(pause: NotificationPause | None, now: datetime, tz: ZoneInfo | None) -> bool:
    if pause is None:
        return False
    if pause.paused_until is not None and now < pause.paused_until:
        return True
    schedule = stored_schedule(pause)
    if not schedule["enabled"] or tz is None:
        return False
    return not schedule_allows(schedule, now.astimezone(tz))


def get_pause(user_profile: UserProfile) -> NotificationPause | None:
    return NotificationPause.objects.filter(user=user_profile).first()


def user_is_paused(user_profile: UserProfile, now: datetime | None = None) -> bool:
    return is_paused(
        get_pause(user_profile), now or timezone_now(), user_timezone(user_profile)
    )


def skip_paused_notification(user_profile: UserProfile, kind: str) -> bool:
    """Called by Zulip's mobile push and missed-message email delivery
    just before a notification is built and sent: True (and a log line)
    when the recipient has paused notifications, so the caller drops it.

    It fails open: any error of the fork's lookup is logged and the
    notification goes out. The savepoint keeps a database error from
    aborting the caller's transaction (the email worker sends a whole
    batch of users in one)."""
    try:
        with transaction.atomic(savepoint=True):
            paused = user_is_paused(user_profile)
    except Exception:
        logging.exception("ykphone: pause lookup failed for user %s", user_profile.id)
        return False
    if not paused:
        return False
    logging.info("ykphone: %s notification skipped, user %s paused", kind, user_profile.id)
    return True


class PauseDict(TypedDict):
    until: int | None
    schedule: NotificationSchedule
    paused: bool
    mobile: bool | None
    # Whether the schedule has a time zone to run in (see user_timezone).
    has_timezone: bool


def pause_dict(pause: NotificationPause | None, user_profile: UserProfile) -> PauseDict:
    now = timezone_now()
    paused_until = None
    if pause is not None and pause.paused_until is not None and pause.paused_until > now:
        paused_until = datetime_to_timestamp(pause.paused_until)
    tz = user_timezone(user_profile)
    return PauseDict(
        until=paused_until,
        schedule=stored_schedule(pause),
        paused=is_paused(pause, now, tz),
        mobile=None if pause is None else pause.mobile_notifications,
        has_timezone=tz is not None,
    )


def paused_user_ids(user_profile: UserProfile) -> list[int]:
    """The active users of the realm, among those the user can see,
    whose notifications are paused now."""
    pauses = NotificationPause.objects.filter(
        user__realm_id=user_profile.realm_id, user__is_active=True
    ).select_related("user")
    if not check_user_can_access_all_users(user_profile):
        pauses = pauses.filter(
            user_id__in=get_accessible_user_ids(user_profile.realm, user_profile)
        )
    now = timezone_now()
    return sorted(
        pause.user_id
        for pause in pauses
        if is_paused(pause, now, user_timezone(pause.user))
    )


def do_set_notification_pause(
    user_profile: UserProfile,
    *,
    until: int | None = None,
    set_until: bool = False,
    schedule: NotificationSchedule | None = None,
    mobile: bool | None = None,
) -> NotificationPause:
    """Changes the pause's end (when ``set_until``), the schedule and/or
    the mobile preference, tells the user's clients, and tells everyone
    who can see the user when the user's paused state flipped."""
    with transaction.atomic(durable=True):
        now = timezone_now()
        tz = user_timezone(user_profile)
        pause, _created = NotificationPause.objects.select_for_update(no_key=True).get_or_create(
            user=user_profile
        )
        if set_until:
            pause.paused_until = check_until(until, now)
        if schedule is not None:
            pause.schedule = dict(schedule)
        if mobile is not None:
            pause.mobile_notifications = mobile
        paused = is_paused(pause, now, tz)
        was_announced = pause.announced_paused
        pause.announced_paused = paused
        pause.save()
        data = pause_dict(pause, user_profile)
        send_event_on_commit(
            user_profile.realm,
            {
                "type": "ykphone_notification_pause",
                "until": data["until"],
                "schedule": data["schedule"],
                "mobile": data["mobile"],
            },
            [user_profile.id],
        )
        if paused != was_announced:
            send_paused_users_event(user_profile, paused)
        return pause


def send_paused_users_event(user_profile: UserProfile, paused: bool) -> None:
    send_event_on_commit(
        user_profile.realm,
        {"type": "ykphone_paused_users", "user_id": user_profile.id, "paused": paused},
        get_user_ids_who_can_access_user(user_profile),
    )


def announce_paused_flips(now: datetime | None = None) -> list[int]:
    """Run every minute (ykphone_clear_expired_statuses): tells everyone
    who can see a user when the user's paused state changed without a
    request — a pause that ran out, a schedule's hours starting or
    ending, a change of time zone. Compares with what was last announced,
    so a missed minute is caught up at the next. Returns the users whose
    state flipped."""
    if now is None:
        now = timezone_now()
    flipped = []
    candidates = NotificationPause.objects.filter(
        Q(paused_until__isnull=False) | Q(schedule__enabled=True) | Q(announced_paused=True),
        user__is_active=True,
    ).values_list("id", flat=True)
    for pause_id in candidates:
        with transaction.atomic(durable=True):
            pause = (
                NotificationPause.objects.select_for_update(no_key=True)
                .select_related("user", "user__realm")
                .get(id=pause_id)
            )
            ran_out = pause.paused_until is not None and pause.paused_until <= now
            if ran_out:
                # Forgotten, which keeps the next run's query small.
                pause.paused_until = None
            paused = is_paused(pause, now, user_timezone(pause.user))
            if paused != pause.announced_paused:
                pause.announced_paused = paused
                send_paused_users_event(pause.user, paused)
                flipped.append(pause.user_id)
            elif not ran_out:
                continue
            pause.save(update_fields=["paused_until", "announced_paused"])
    return flipped

