import re
from typing import Any, TypedDict

from django.db import transaction
from django.db.models import Count, Exists, Max, OuterRef, Q, QuerySet
from django.db.models.functions import Upper
from django.utils.translation import gettext as _

from ykphone.models import MessageThread
from zerver.lib.exceptions import JsonableError
from zerver.lib.message import access_message, messages_for_ids
from zerver.lib.stream_subscription import get_subscribed_stream_ids_for_user
from zerver.lib.streams import access_stream_by_id, get_stream_topics_policy
from zerver.lib.timestamp import datetime_to_timestamp
from zerver.lib.topic import messages_for_topic
from zerver.models import Message, Stream, UserMessage, UserProfile
from zerver.models.constants import MAX_TOPIC_NAME_LENGTH
from zerver.models.streams import StreamTopicsPolicyEnum

# Slack shows about this much of the root message in a thread's
# preview; it is also short enough to read in the sidebar.
THREAD_TOPIC_SNIPPET_LENGTH = 50

# Slack's thread pill shows the avatars of the last few people who
# replied.
MAX_THREAD_PARTICIPANTS = 3

# The Activity view lists the newest thread replies; the other feeds
# it merges (mentions, reactions, direct messages) fetch as many.
MAX_ACTIVITY_MESSAGES = 50
# How many of the realm's newest threads the Activity view looks at.
MAX_ACTIVITY_THREADS = 200


class ThreadDict(TypedDict):
    root_message_id: int
    stream_id: int
    topic_name: str
    reply_count: int
    last_reply_timestamp: int | None
    # Senders of the newest replies, newest first, distinct.
    participant_user_ids: list[int]


def thread_topic_snippet(content: str) -> str:
    """Turn the raw Markdown of a message into a short, plain topic name."""
    first_line = ""
    for line in content.splitlines():
        stripped = line.strip()
        # Skip block-level noise like fenced code openers and quote
        # markers so the snippet starts with words the author wrote.
        if stripped and not stripped.startswith(("```", "~~~", ">", "|")):
            first_line = stripped
            break
    # Links keep their visible text, mentions keep the name, and the
    # remaining formatting characters are dropped.
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", first_line)
    text = re.sub(r"@_?\*\*([^*|]+)(?:\|\d+)?\*\*", r"\1", text)
    # Emoji codes like :white_check_mark: keep their underscores.
    text = re.sub(r"[*`#]+|~~", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if text == "":
        # Topic names are shared data, so the fallback is not translated
        # into whichever language the creator happens to use.
        return "Thread"
    if len(text) > THREAD_TOPIC_SNIPPET_LENGTH:
        text = text[: THREAD_TOPIC_SNIPPET_LENGTH - 1].rstrip() + "…"
    return text


def unique_thread_topic_name(stream: Stream, base_name: str) -> str:
    """Avoid colliding with an existing topic, whether or not it is a thread."""
    recipient_id = stream.recipient_id
    assert recipient_id is not None

    def taken(name: str) -> bool:
        return (
            MessageThread.objects.filter(stream=stream, topic_name__iexact=name).exists()
            or messages_for_topic(stream.realm_id, recipient_id, name).exists()
        )

    if not taken(base_name):
        return base_name
    for n in range(2, 1000):
        suffix = f" ({n})"
        candidate = base_name[: MAX_TOPIC_NAME_LENGTH - len(suffix)].rstrip() + suffix
        if not taken(candidate):
            return candidate
    raise JsonableError(_("Could not find a free name for this thread."))  # nocoverage


def get_or_create_thread(user_profile: UserProfile, message_id: int) -> MessageThread:
    with transaction.atomic(durable=True):
        # Lock the root row: two people opening a thread on the same
        # fresh message at once must not race past the existence check
        # into the one-to-one constraint.
        message = access_message(
            user_profile, message_id, lock_message=True, is_modifying_message=False
        )
        if not message.is_channel_message:
            raise JsonableError(_("Threads can only be started on channel messages."))
        if message.topic_name() != "":
            raise JsonableError(_("This message is already part of a thread."))

        stream, _sub = access_stream_by_id(user_profile, message.recipient.type_id)
        if (
            get_stream_topics_policy(stream.realm, stream)
            == StreamTopicsPolicyEnum.empty_topic_only.value
        ):
            raise JsonableError(_("This channel does not allow threads."))

        thread = MessageThread.objects.filter(root_message=message).first()
        if thread is not None:
            return thread
        topic_name = unique_thread_topic_name(stream, thread_topic_snippet(message.content))
        return MessageThread.objects.create(
            realm=stream.realm,
            stream=stream,
            root_message=message,
            topic_name=topic_name,
            creator=user_profile,
        )


def readable_messages(user_profile: UserProfile, stream: Stream) -> QuerySet[Message]:
    """Channel messages the user may read, following the same rule as
    topic history: in channels whose history is not public to
    subscribers, only messages the user received."""
    assert stream.recipient_id is not None
    messages = Message.objects.filter(
        realm_id=stream.realm_id, recipient_id=stream.recipient_id, is_channel_message=True
    )
    if not stream.is_history_public_to_subscribers():
        messages = messages.filter(usermessage__user_profile_id=user_profile.id)
    return messages


def latest_senders(sender_rows: list[tuple[int, int]]) -> list[int]:
    """The newest few distinct senders from (sender_id, latest message
    id) rows."""
    sender_rows.sort(key=lambda row: row[1], reverse=True)
    return [sender_id for sender_id, _message_id in sender_rows[:MAX_THREAD_PARTICIPANTS]]


def threads_for_stream(user_profile: UserProfile, stream_id: int) -> list[ThreadDict]:
    stream, _sub = access_stream_by_id(user_profile, stream_id)
    thread_rows = MessageThread.objects.filter(stream=stream).order_by("root_message_id")
    if not stream.is_history_public_to_subscribers():
        # A thread's name is a snippet of its root, so roots the user
        # cannot read must not be listed at all.
        thread_rows = thread_rows.filter(
            root_message_id__in=readable_messages(user_profile, stream).values("id")
        )
    threads = list(thread_rows)
    if not threads:
        return []

    replies = (
        readable_messages(user_profile, stream)
        .filter(topic_filter([thread.topic_name for thread in threads]))
        .annotate(upper_subject=Upper("subject"))
    )
    stats = {
        row["upper_subject"]: row
        for row in replies.values("upper_subject").annotate(
            reply_count=Count("id"), last_reply=Max("date_sent")
        )
    }
    # One row per (topic, sender) with that sender's newest reply, so
    # the newest senders can be picked without reading every reply.
    senders_by_topic: dict[str, list[tuple[int, int]]] = {}
    for upper_subject, sender_id, latest_id in (
        replies.order_by("upper_subject", "sender_id", "-id")
        .distinct("upper_subject", "sender_id")
        .values_list("upper_subject", "sender_id", "id")
    ):
        senders_by_topic.setdefault(upper_subject, []).append((sender_id, latest_id))

    result: list[ThreadDict] = []
    for thread in threads:
        key = thread.topic_name.upper()
        row = stats.get(key)
        result.append(
            ThreadDict(
                root_message_id=thread.root_message_id,
                stream_id=stream.id,
                topic_name=thread.topic_name,
                reply_count=row["reply_count"] if row else 0,
                last_reply_timestamp=datetime_to_timestamp(row["last_reply"]) if row else None,
                participant_user_ids=latest_senders(senders_by_topic.get(key, [])),
            )
        )
    return result


def thread_dict(user_profile: UserProfile, thread: MessageThread) -> ThreadDict:
    replies = readable_messages(user_profile, thread.stream).filter(
        subject__iexact=thread.topic_name
    )
    stats = replies.aggregate(reply_count=Count("id"), last_reply=Max("date_sent"))
    sender_rows = list(
        replies.order_by("sender_id", "-id").distinct("sender_id").values_list("sender_id", "id")
    )
    return ThreadDict(
        root_message_id=thread.root_message_id,
        stream_id=thread.stream_id,
        topic_name=thread.topic_name,
        reply_count=stats["reply_count"],
        last_reply_timestamp=(
            datetime_to_timestamp(stats["last_reply"]) if stats["last_reply"] else None
        ),
        participant_user_ids=latest_senders(sender_rows),
    )


def accessible_streams(user_profile: UserProfile) -> list[Stream]:
    """Active channels the user may read messages of: subscribed ones
    and, for members, the realm's public ones (access_stream_common's
    rule, resolved in two queries for every channel at once)."""
    channel_filter = Q(id__in=set(get_subscribed_stream_ids_for_user(user_profile)))
    if not user_profile.is_guest:
        channel_filter |= Q(invite_only=False)
    return list(
        Stream.objects.filter(realm_id=user_profile.realm_id, deactivated=False).filter(
            channel_filter
        )
    )


def topic_filter(topic_names: list[str]) -> Q:
    """Topics are matched case-insensitively, like everywhere else in
    Zulip (the UPPER(subject) index serves each term)."""
    condition = Q()
    for topic_name in topic_names:
        condition |= Q(subject__iexact=topic_name)
    return condition


def thread_activity(user_profile: UserProfile, *, client_gravatar: bool) -> list[dict[str, Any]]:
    """Other people's replies in the threads the user started or
    replied in, newest first, as message dicts in the shape of GET
    /messages so the Activity view can merge them with its other
    feeds."""
    streams = {stream.id: stream for stream in accessible_streams(user_profile)}
    if not streams:
        return []
    # Only the newest threads are considered, so the cost is bounded
    # however many threads the realm has accumulated.
    newest_thread_ids = list(
        MessageThread.objects.filter(realm_id=user_profile.realm_id, stream_id__in=streams)
        .order_by("-root_message_id")
        .values_list("id", flat=True)[:MAX_ACTIVITY_THREADS]
    )
    replied = Message.objects.filter(
        realm_id=user_profile.realm_id,
        sender_id=user_profile.id,
        is_channel_message=True,
        recipient_id=OuterRef("stream__recipient_id"),
        subject__iexact=OuterRef("topic_name"),
    )
    threads = MessageThread.objects.filter(id__in=newest_thread_ids).filter(
        Q(creator_id=user_profile.id) | Q(Exists(replied))
    )
    topic_names_by_stream_id: dict[int, list[str]] = {}
    for thread in threads:
        topic_names_by_stream_id.setdefault(thread.stream_id, []).append(thread.topic_name)

    # In a channel whose history is not public to subscribers only the
    # messages the user received count (readable_messages' rule, as a
    # single query across channels).
    open_history = Q()
    protected_history = Q()
    for stream_id, topic_names in topic_names_by_stream_id.items():
        stream = streams[stream_id]
        topics = Q(recipient_id=stream.recipient_id) & topic_filter(topic_names)
        if stream.is_history_public_to_subscribers():
            open_history |= topics
        else:
            protected_history |= topics

    replies = Message.objects.filter(
        realm_id=user_profile.realm_id, is_channel_message=True
    ).exclude(sender_id=user_profile.id)
    message_ids: set[int] = set()
    if open_history:
        message_ids.update(
            replies.filter(open_history)
            .order_by("-id")
            .values_list("id", flat=True)[:MAX_ACTIVITY_MESSAGES]
        )
    if protected_history:
        message_ids.update(
            replies.filter(protected_history, usermessage__user_profile_id=user_profile.id)
            .order_by("-id")
            .values_list("id", flat=True)[:MAX_ACTIVITY_MESSAGES]
        )
    newest_ids = sorted(message_ids, reverse=True)[:MAX_ACTIVITY_MESSAGES]
    if not newest_ids:
        return []

    user_message_flags = {
        um.message_id: um.flags_list()
        for um in UserMessage.objects.filter(user_profile=user_profile, message_id__in=newest_ids)
    }
    for message_id in newest_ids:
        # Messages received before the user joined the channel, as in
        # GET /messages with history included.
        user_message_flags.setdefault(message_id, ["read", "historical"])
    return messages_for_ids(
        message_ids=newest_ids,
        user_message_flags=user_message_flags,
        search_fields={},
        apply_markdown=True,
        client_gravatar=client_gravatar,
        allow_empty_topic_name=True,
        message_edit_history_visibility_policy=user_profile.realm.message_edit_history_visibility_policy,
        user_profile=user_profile,
        realm=user_profile.realm,
    )
