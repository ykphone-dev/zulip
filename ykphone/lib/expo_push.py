"""Push notifications for the 옆커폰 chat app through Expo.

The app (ykphone-dev/ykphone-chat-app) is a WebView around this web
app, so Zulip's own mobile push, which speaks to the official apps
through APNs/FCM or the push bouncer, cannot reach it. The app instead
registers an Expo push token from the logged-in page, and every message
is pushed through Expo's push service to all its recipients but the
sender.

Unlike Zulip's push this does not look at the recipient's notification
settings or whether they are online: the chat app is internal and is
meant to ring for every message. What it does respect is the fork's own
"pause notifications" and the settings page's mobile notifications
switch (ykphone.lib.notification_pause).

The notification names the sender and the channel only, never the
message: Expo's service is a third party the content would otherwise
pass through.
"""

import logging
import re
from typing import Any

from django.utils.timezone import now as timezone_now

from ykphone.lib.notification_pause import get_pause, skip_paused_notification
from ykphone.models import ExpoPushToken
from zerver.lib.exceptions import JsonableError
from zerver.lib.outgoing_http import OutgoingSession
from zerver.lib.url_encoding import message_link_url
from zerver.models import Realm, UserProfile

logger = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
# Expo accepts at most 100 messages in one request.
EXPO_BATCH_SIZE = 100
EXPO_TOKEN_RE = re.compile(r"^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$")

QUEUE_EVENT_TYPE = "ykphone_expo_push"


def check_expo_token(token: str) -> str:
    if not EXPO_TOKEN_RE.match(token):
        raise JsonableError("Invalid Expo push token.")
    return token


def register_expo_push_token(user_profile: UserProfile, token: str) -> None:
    """Registers the token for the user; a token registered by someone
    else before (a phone that changed hands) moves to this user."""
    ExpoPushToken.objects.update_or_create(
        token=token,
        defaults={"user": user_profile, "last_registered": timezone_now()},
    )


def unregister_expo_push_token(user_profile: UserProfile, token: str) -> None:
    ExpoPushToken.objects.filter(user=user_profile, token=token).delete()


def expo_push_event(
    realm: Realm, message_dict: dict[str, Any], recipient_ids: set[int], sender_id: int
) -> dict[str, Any] | None:
    """The deferred_work event for a sent message, or None when nobody
    but the sender receives it. Called by Zulip's do_send_messages;
    everything the notification shows is taken from the message now, so
    the worker does not read the message again."""
    user_ids = sorted(recipient_ids - {sender_id})
    if not user_ids:
        return None
    if message_dict["type"] == "stream":
        body = f"#{message_dict['display_recipient']}에 새 메시지"
    elif len(message_dict["display_recipient"]) > 2:
        body = "그룹 메시지"
    else:
        body = "새 메시지"
    return {
        "type": QUEUE_EVENT_TYPE,
        "user_ids": user_ids,
        "message_id": message_dict["id"],
        "title": message_dict["sender_full_name"],
        "body": body,
        "url": message_link_url(realm, message_dict, conversation_link=True),
    }


def wants_expo_push(user_profile: UserProfile) -> bool:
    pause = get_pause(user_profile)
    if pause is not None and pause.mobile_notifications is False:
        return False
    return not skip_paused_notification(user_profile, "expo push")


def send_expo_push(event: dict[str, Any]) -> None:
    """Consumes an expo_push_event on the deferred_work queue."""
    users = UserProfile.objects.filter(id__in=event["user_ids"], is_active=True, is_bot=False)
    user_ids = [user.id for user in users if wants_expo_push(user)]
    tokens = list(
        ExpoPushToken.objects.filter(user_id__in=user_ids).values_list("token", flat=True)
    )
    if not tokens:
        return

    messages = [
        {
            "to": token,
            "title": event["title"],
            "body": event["body"],
            "data": {"url": event["url"], "message_id": event["message_id"]},
            "sound": "default",
            "priority": "high",
        }
        for token in tokens
    ]
    session = OutgoingSession(role="ykphone_expo_push", timeout=15)
    for start in range(0, len(messages), EXPO_BATCH_SIZE):
        batch = messages[start : start + EXPO_BATCH_SIZE]
        try:
            response = session.post(EXPO_PUSH_URL, json=batch)
            response.raise_for_status()
            tickets = response.json()["data"]
        except Exception:
            # A notification is only worth sending now; the next message
            # sends another, so a failure is logged and not retried.
            logger.exception(
                "ykphone: expo push failed for message %s (%s tokens)",
                event["message_id"],
                len(batch),
            )
            continue
        forget_unregistered_tokens(batch, tickets, event["message_id"])


def forget_unregistered_tokens(
    batch: list[dict[str, Any]], tickets: list[dict[str, Any]], message_id: int
) -> None:
    """Expo answers with one ticket per message, in order. A token whose
    app was uninstalled comes back as DeviceNotRegistered and is dropped;
    other errors are logged."""
    unregistered = []
    for message, ticket in zip(batch, tickets, strict=False):
        if ticket.get("status") != "error":
            continue
        error = ticket.get("details", {}).get("error")
        if error == "DeviceNotRegistered":
            unregistered.append(message["to"])
        else:
            logger.warning("ykphone: expo push ticket error %s for message %s", error, message_id)
    if unregistered:
        ExpoPushToken.objects.filter(token__in=unregistered).delete()
        logger.info("ykphone: dropped %s unregistered expo tokens", len(unregistered))
