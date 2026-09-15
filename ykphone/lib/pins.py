from typing import TypedDict

from django.db import transaction
from django.utils.translation import gettext as _

from ykphone.lib.threads import readable_messages
from ykphone.models import PinnedMessage
from zerver.lib.exceptions import JsonableError
from zerver.lib.message import access_message
from zerver.lib.stream_subscription import get_active_subscriptions_for_stream_id
from zerver.lib.streams import access_stream_by_id
from zerver.lib.timestamp import datetime_to_timestamp
from zerver.models import Message, Stream, UserMessage, UserProfile
from zerver.models.streams import get_stream_by_id_in_realm
from zerver.tornado.django_api import send_event_on_commit

# Slack shows a channel's pins in one list; more than this many is a
# sign the channel uses pins as an archive, and the panel need not
# carry every one of them.
MAX_PINS_LISTED = 100


class PinDict(TypedDict):
    message_id: int
    stream_id: int
    # The message's topic, so a client can link to the message without
    # having it loaded.
    topic_name: str
    pinned_by_user_id: int | None
    date_pinned: int
    sender_id: int
    sender_full_name: str
    timestamp: int
    content: str


def current_stream(message: Message) -> Stream:
    """The channel the message is in now. Messages can be moved, so the
    channel recorded on the pin (the channel at pin time) is never used
    for access or routing; only the message's recipient is."""
    return get_stream_by_id_in_realm(message.recipient.type_id, message.realm)


def pin_dict(pin: PinnedMessage) -> PinDict:
    message = pin.message
    return PinDict(
        message_id=message.id,
        stream_id=message.recipient.type_id,
        topic_name=message.topic_name(),
        pinned_by_user_id=pin.pinned_by_id,
        date_pinned=datetime_to_timestamp(pin.date_pinned),
        sender_id=message.sender_id,
        sender_full_name=message.sender.full_name,
        timestamp=datetime_to_timestamp(message.date_sent),
        content=message.rendered_content or "",
    )


def pin_event_user_ids(stream: Stream, message: Message) -> list[int]:
    """Subscribers of the message's channel who may learn about the pin.
    The event carries the message content, so in a channel whose
    history is not public to subscribers only those who received the
    message get it."""
    subscriber_ids = get_active_subscriptions_for_stream_id(
        stream.id, include_deactivated_users=False
    ).values_list("user_profile_id", flat=True)
    if stream.is_history_public_to_subscribers():
        return list(subscriber_ids)
    return list(
        UserMessage.objects.filter(
            message_id=message.id, user_profile_id__in=subscriber_ids
        ).values_list("user_profile_id", flat=True)
    )


def pin_message(user_profile: UserProfile, message_id: int) -> PinnedMessage:
    """Anyone who can read the message and its channel may pin it (in a
    public channel that includes non-subscribers, as with reading)."""
    with transaction.atomic(durable=True):
        # Lock the message row so that two people pinning at once do
        # not race past the existence check into the one-to-one
        # constraint, and so that a concurrent deletion waits.
        message = access_message(
            user_profile, message_id, lock_message=True, is_modifying_message=False
        )
        if not message.is_channel_message:
            raise JsonableError(_("Only channel messages can be pinned."))
        stream, _sub = access_stream_by_id(user_profile, message.recipient.type_id)

        pin = PinnedMessage.objects.filter(message=message).first()
        if pin is not None:
            # access_message already fetched the sender and recipient.
            pin.message = message
            return pin
        pin = PinnedMessage.objects.create(
            realm=stream.realm, stream=stream, message=message, pinned_by=user_profile
        )
        send_event_on_commit(
            stream.realm,
            {"type": "ykphone_pin", "op": "add", "pin": pin_dict(pin)},
            pin_event_user_ids(stream, message),
        )
        return pin


def unpin_message(user_profile: UserProfile, message_id: int) -> None:
    """Anyone who can read the message may unpin it, as in Slack (so an
    archived channel's pins can still be cleared). Unpinning a message
    that is not pinned is not an error."""
    with transaction.atomic(durable=True):
        message = access_message(
            user_profile, message_id, lock_message=True, is_modifying_message=False
        )
        pin = PinnedMessage.objects.filter(message=message).first()
        if pin is None:
            return
        stream = current_stream(message)
        pin.delete()
        send_event_on_commit(
            stream.realm,
            {
                "type": "ykphone_pin",
                "op": "remove",
                "stream_id": stream.id,
                "message_id": message.id,
            },
            pin_event_user_ids(stream, message),
        )


def pins_for_stream(user_profile: UserProfile, stream_id: int) -> list[PinDict]:
    """Newest pin first, limited to messages the user may read. Pins are
    found through the messages' current recipient, so a moved message
    is listed with its new channel and never with the old one."""
    stream, _sub = access_stream_by_id(user_profile, stream_id)
    assert stream.recipient_id is not None
    pins = PinnedMessage.objects.filter(
        message__recipient_id=stream.recipient_id, message__is_channel_message=True
    )
    if not stream.is_history_public_to_subscribers():
        pins = pins.filter(message_id__in=readable_messages(user_profile, stream).values("id"))
    pins = pins.select_related("message", "message__sender", "message__recipient").order_by(
        "-date_pinned", "-id"
    )
    return [pin_dict(pin) for pin in pins[:MAX_PINS_LISTED]]
