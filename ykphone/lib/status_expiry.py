"""A status's "Clear after" for the 옆커폰 fork (Slack's status
expiry).

The web app saves the status through Zulip's own endpoint and then the
time it is to be cleared through the fork's. Zulip's
do_update_user_status forgets the time whenever the status text or
emoji changes (``forget_status_expiry``), so a status set or cleared by
hand, from any client, is never cleared later by an expiry meant for
the one before. The management command ykphone_clear_expired_statuses
(run every minute from cron) clears expired statuses through
do_update_user_status, so every client hears of it as usual.

Everyone who can see the user is told the time (``ykphone_status_expiry``
events), which the web app shows next to the status as "until …".
"""

from datetime import datetime

from django.db import transaction
from django.utils.timezone import now as timezone_now
from django.utils.translation import gettext as _

from ykphone.lib.saved import MAX_DUE_TIMESTAMP
from ykphone.models import StatusExpiry
from zerver.lib.exceptions import JsonableError
from zerver.lib.timestamp import datetime_to_timestamp, timestamp_to_datetime
from zerver.lib.users import (
    check_user_can_access_all_users,
    get_accessible_user_ids,
    get_user_ids_who_can_access_user,
)
from zerver.models import UserProfile, UserStatus
from zerver.tornado.django_api import send_event_on_commit


def check_clear_at(clear_at: int, now: datetime) -> datetime:
    if clear_at < 0 or clear_at > MAX_DUE_TIMESTAMP:
        raise JsonableError(_("Invalid time: it must be a time in seconds."))
    when = timestamp_to_datetime(clear_at)
    if when <= now:
        raise JsonableError(_("The time to clear the status must be in the future."))
    return when


def status_expiry_event(user_profile: UserProfile, clear_at: datetime | None) -> dict[str, object]:
    return {
        "type": "ykphone_status_expiry",
        "user_id": user_profile.id,
        "clear_at": None if clear_at is None else datetime_to_timestamp(clear_at),
    }


def send_status_expiry_event(user_profile: UserProfile, clear_at: datetime | None) -> None:
    send_event_on_commit(
        user_profile.realm,
        status_expiry_event(user_profile, clear_at),
        get_user_ids_who_can_access_user(user_profile),
    )


def current_status(user_profile: UserProfile) -> tuple[str, str, str] | None:
    """The user's status text, emoji name and emoji code; None without one."""
    return (
        UserStatus.objects.filter(user_profile=user_profile)
        .exclude(status_text="", emoji_name="")
        .values_list("status_text", "emoji_name", "emoji_code")
        .first()
    )


def do_set_status_expiry(user_profile: UserProfile, clear_at: int | None) -> None:
    """Sets (or with None, removes) the time the user's current status
    is cleared. A time needs a status to clear."""
    with transaction.atomic(durable=True):
        if clear_at is None:
            deleted, _rows = StatusExpiry.objects.filter(user=user_profile).delete()
            if deleted:
                send_status_expiry_event(user_profile, None)
            return
        when = check_clear_at(clear_at, timezone_now())
        status = current_status(user_profile)
        if status is None:
            raise JsonableError(_("You have no status to clear."))
        status_text, emoji_name, emoji_code = status
        StatusExpiry.objects.update_or_create(
            user=user_profile,
            defaults={
                "clear_at": when,
                "status_text": status_text,
                "emoji_name": emoji_name,
                "emoji_code": emoji_code,
            },
        )
        send_status_expiry_event(user_profile, when)


def forget_status_expiry(
    user_profile: UserProfile, status_text: str | None, emoji_name: str | None
) -> None:
    """Called by Zulip's do_update_user_status (inside its transaction):
    a change of the status text or emoji drops the expiry of the status
    before it. The fork's web app saves a new expiry right after."""
    if status_text is None and emoji_name is None:
        # Only the deprecated "away" flag changed.
        return
    deleted, _rows = StatusExpiry.objects.filter(user=user_profile).delete()
    if deleted:
        send_status_expiry_event(user_profile, None)


def status_expiries(user_profile: UserProfile) -> dict[str, int]:
    """The expiry times of the statuses the user can see, by user id."""
    expiries = StatusExpiry.objects.filter(
        user__realm_id=user_profile.realm_id, user__is_active=True
    )
    if not check_user_can_access_all_users(user_profile):
        expiries = expiries.filter(
            user_id__in=get_accessible_user_ids(user_profile.realm, user_profile)
        )
    return {
        str(user_id): datetime_to_timestamp(clear_at)
        for user_id, clear_at in expiries.values_list("user_id", "clear_at")
    }
