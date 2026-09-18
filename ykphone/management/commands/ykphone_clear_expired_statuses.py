from datetime import datetime
from typing import Any

from django.utils.timezone import now as timezone_now
from typing_extensions import override

from ykphone.lib.notification_pause import announce_paused_flips
from ykphone.lib.status_expiry import current_status
from ykphone.models import StatusExpiry
from zerver.actions.user_status import do_update_user_status
from zerver.lib.management import ZulipBaseCommand
from zerver.models import UserStatus
from zerver.models.clients import get_client


def clear_expired_statuses(now: datetime | None = None) -> list[int]:
    """Clears every status whose time has come, if it is still the status
    the time was set for, and removes the rows. Idempotent; returns the
    ids of the users whose status was cleared."""
    if now is None:
        now = timezone_now()
    client = get_client("ykphone_status_expiry")
    cleared = []
    for expiry in StatusExpiry.objects.filter(clear_at__lte=now).select_related("user"):
        user_profile = expiry.user
        still_expired = StatusExpiry.objects.filter(id=expiry.id, clear_at__lte=now).exists()
        status = current_status(user_profile)
        # A status changed by hand dropped the row (and maybe saved a new
        # one); a status changed without that hook (or in the moment
        # before this check) no longer matches. Either way it stays.
        # do_update_user_status runs its own durable transaction, so a
        # change landing between this check and the clear itself (a few
        # milliseconds) is the one case left.
        if (
            still_expired
            and user_profile.is_active
            and status == (expiry.status_text, expiry.emoji_name, expiry.emoji_code)
        ):
            # Clears the text and the emoji the way Zulip's own "Clear
            # status" does; do_update_user_status also deletes the row.
            do_update_user_status(
                user_profile,
                away=None,
                status_text="",
                client_id=client.id,
                emoji_name="",
                emoji_code="",
                reaction_type=UserStatus.UNICODE_EMOJI,
            )
            cleared.append(user_profile.id)
        StatusExpiry.objects.filter(id=expiry.id, clear_at__lte=now).delete()
    return cleared


class Command(ZulipBaseCommand):
    help = """Runs every minute from cron for the 옆커폰 fork: clears the statuses
whose "Clear after" time has passed, and tells everyone when a user's
paused notifications started or ended by themselves (a pause that ran
out, a notification schedule's hours, a time zone change). Safe to run
again."""

    @override
    def handle(self, *args: Any, **options: Any) -> None:
        cleared = clear_expired_statuses()
        if cleared:
            self.stdout.write(f"Expired statuses cleared: {len(cleared)}\n")
        flipped = announce_paused_flips()
        if flipped:
            self.stdout.write(f"Paused state announced: {len(flipped)}\n")
