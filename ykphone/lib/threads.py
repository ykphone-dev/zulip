import re
from datetime import datetime
from typing import Any, TypedDict

from django.db import transaction
from django.db.models import Count, Exists, F, Max, Min, OuterRef, Q, QuerySet
from django.db.models.functions import Upper
from django.utils.translation import gettext as _

from ykphone.models import MessageThread
from zerver.lib.exceptions import JsonableError
from zerver.lib.message import access_message, messages_for_ids
from zerver.lib.stream_subscription import get_subscribed_stream_ids_for_user
from zerver.lib.streams import access_stream_by_id, get_stream_topics_policy
from zerver.lib.timestamp import datetime_to_timestamp
from zerver.lib.topic import messages_for_topic
from zerver.lib.types import StreamMessageEditRequest
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
# How far back the user's own messages and mentions are searched for
# the topics (other than threads) they take part in.
MAX_PARTICIPATION_MESSAGES = 1000
# The Threads page lists this many of the user's conversations.
MAX_MY_THREADS = 100
# A row of the Threads page shows about this much of the root message.
THREAD_ROW_SNIPPET_LENGTH = 200


class ThreadDict(TypedDict):
    root_message_id: int
    stream_id: int
    topic_name: str
    reply_count: int
    last_reply_timestamp: int | None
    # Senders of the newest replies, newest first, distinct.
    participant_user_ids: list[int]
    # Whether the requesting user wrote the root, started the thread or
    # replied in it, as Slack follows a thread: the threads whose
    # replies the Activity view lists (thread_activity) and the sidebar
    # counts as unread.
    user_participated: bool


class ThreadRowDict(TypedDict):
    """A row of the Threads page: a thread the user follows, or a topic
    other than general chat that the user took part in, with its first
    message standing in for the root."""

    root_message_id: int
    stream_id: int
    topic_name: str
    is_thread: bool
    reply_count: int
    last_reply_timestamp: int | None
    root_sender_id: int
    root_sender_full_name: str
    root_snippet: str
    root_timestamp: int
    # The newest of the root and the last reply, which orders the page.
    last_activity_timestamp: int


def thread_topic_snippet(content: str, max_length: int = THREAD_TOPIC_SNIPPET_LENGTH) -> str:
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
    if len(text) > max_length:
        text = text[: max_length - 1].rstrip() + "…"
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


def threads_for_stream(user_profile: UserProfile, stream: Stream) -> list[ThreadDict]:
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
    # The same rows hold the user's own replies, if any.
    replied_topics = {
        upper_subject
        for upper_subject, sender_rows in senders_by_topic.items()
        if any(sender_id == user_profile.id for sender_id, _message_id in sender_rows)
    }
    authored_root_thread_ids = set(
        thread_rows.filter(root_message__sender_id=user_profile.id).values_list("id", flat=True)
    )

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
                user_participated=(
                    thread.creator_id == user_profile.id
                    or thread.id in authored_root_thread_ids
                    or key in replied_topics
                ),
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
        user_participated=(
            thread.creator_id == user_profile.id
            or any(sender_id == user_profile.id for sender_id, _message_id in sender_rows)
            or Message.objects.filter(id=thread.root_message_id, sender_id=user_profile.id).exists()
        ),
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


def participated_topics(user_profile: UserProfile, streams: list[Stream]) -> list[tuple[int, str]]:
    """(channel id, topic name) of the channel topics other than general
    chat that the user sent a message to or was mentioned in (directly
    or through a group), newest first, each once, as far back as the
    user's newest MAX_PARTICIPATION_MESSAGES of each. Slack follows a
    thread for exactly these people; the web app counts unread messages
    in these topics, when they are not threads, under Threads."""
    stream_ids_by_recipient_id = {stream.recipient_id: stream.id for stream in streams}
    own = (
        Message.objects.filter(
            realm_id=user_profile.realm_id,
            is_channel_message=True,
            recipient_id__in=stream_ids_by_recipient_id,
            sender_id=user_profile.id,
        )
        .exclude(subject="")
        .order_by("-id")
        .values("id")[:MAX_PARTICIPATION_MESSAGES]
    )
    mentioned = (
        UserMessage.objects.filter(
            user_profile_id=user_profile.id,
            message__is_channel_message=True,
            message__recipient_id__in=stream_ids_by_recipient_id,
        )
        .exclude(message__subject="")
        .annotate(mention_flag=F("flags").bitand(UserMessage.flags.mentioned.mask))
        .filter(mention_flag__gt=0)
        .order_by("-message_id")
        .values("message_id")[:MAX_PARTICIPATION_MESSAGES]
    )
    topics: list[tuple[int, str]] = []
    seen: set[tuple[int, str]] = set()
    for recipient_id, topic_name in (
        Message.objects.filter(realm_id=user_profile.realm_id)
        .filter(Q(id__in=own) | Q(id__in=mentioned))
        .order_by("-id")
        .values_list("recipient_id", "subject")
    ):
        key = (recipient_id, topic_name.upper())
        if key not in seen:
            seen.add(key)
            topics.append((stream_ids_by_recipient_id[recipient_id], topic_name))
    return topics


def unthreaded_participated_topics(
    user_profile: UserProfile, streams: list[Stream]
) -> list[tuple[int, str]]:
    """participated_topics without the thread topics, which follow their
    own participation rule (ThreadDict.user_participated)."""
    topics = participated_topics(user_profile, streams)
    if not topics:
        return []
    thread_topics = {
        (stream_id, topic_name.upper())
        for stream_id, topic_name in MessageThread.objects.filter(
            realm_id=user_profile.realm_id, stream_id__in={stream_id for stream_id, _ in topics}
        ).values_list("stream_id", "topic_name")
    }
    return [
        (stream_id, topic_name)
        for stream_id, topic_name in topics
        if (stream_id, topic_name.upper()) not in thread_topics
    ]


def follow_moved_thread_topic(message_edit_request: StreamMessageEditRequest) -> None:
    """Keep a thread attached to its replies when their topic is
    renamed, resolved or unresolved (a rename with a ✔ prefix) or moved
    to another channel. Called from do_update_message once the messages
    have moved, in the same transaction. A thread whose topic was only
    partly moved stays with the replies left behind."""
    if not message_edit_request.is_message_moved:
        return
    orig_stream = message_edit_request.orig_stream
    orig_topic_name = message_edit_request.orig_topic_name
    target_stream = message_edit_request.target_stream
    target_topic_name = message_edit_request.target_topic_name
    thread = (
        # The row may be deleted below, so the full lock.
        MessageThread.objects.select_for_update(no_key=False)
        .filter(stream=orig_stream, topic_name__iexact=orig_topic_name)
        .first()
    )
    if thread is None:
        return
    assert orig_stream.recipient_id is not None
    if messages_for_topic(orig_stream.realm_id, orig_stream.recipient_id, orig_topic_name).exists():
        return
    if (
        MessageThread.objects.filter(stream=target_stream, topic_name__iexact=target_topic_name)
        .exclude(id=thread.id)
        .exists()
    ):
        # The replies joined another thread's topic; that thread keeps
        # them, and this root goes back to being a plain message.
        thread.delete()
        return
    thread.stream = target_stream
    thread.topic_name = target_topic_name
    thread.save(update_fields=["stream", "topic_name"])


def followed_threads(user_profile: UserProfile, streams: dict[int, Stream]) -> list[MessageThread]:
    """The threads in these channels that the user wrote the root of,
    started or replied in (ThreadDict.user_participated), among the
    realm's newest MAX_ACTIVITY_THREADS, so the cost is bounded however
    many threads the realm has accumulated."""
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
    return list(
        MessageThread.objects.filter(id__in=newest_thread_ids).filter(
            Q(creator_id=user_profile.id)
            | Q(root_message__sender_id=user_profile.id)
            | Q(Exists(replied))
        )
    )


def my_threads(user_profile: UserProfile) -> list[ThreadRowDict]:
    """The rows of the Threads page: the threads the user follows and
    the other topics (not general chat) the user posted in or was
    mentioned in, newest activity first, at most MAX_MY_THREADS, in a
    fixed number of queries. A topic's first message stands in for the
    root of a plain topic."""
    streams = {stream.id: stream for stream in accessible_streams(user_profile)}
    if not streams:
        return []
    recipient_ids: dict[int, int] = {}
    for stream_id, stream in streams.items():
        assert stream.recipient_id is not None
        recipient_ids[stream_id] = stream.recipient_id
    threads = followed_threads(user_profile, streams)
    protected_stream_ids = {
        stream_id
        for stream_id, stream in streams.items()
        if not stream.is_history_public_to_subscribers()
    }
    protected_root_ids = [
        thread.root_message_id for thread in threads if thread.stream_id in protected_stream_ids
    ]
    if protected_root_ids:
        # A thread's row shows its root, so roots the user never
        # received in a channel with protected history are left out.
        readable_root_ids = set(
            UserMessage.objects.filter(
                user_profile_id=user_profile.id, message_id__in=protected_root_ids
            ).values_list("message_id", flat=True)
        )
        threads = [
            thread
            for thread in threads
            if thread.stream_id not in protected_stream_ids
            or thread.root_message_id in readable_root_ids
        ]
    plain_topics = unthreaded_participated_topics(user_profile, list(streams.values()))[
        :MAX_ACTIVITY_THREADS
    ]

    topic_names_by_stream_id: dict[int, list[str]] = {}
    for thread in threads:
        topic_names_by_stream_id.setdefault(thread.stream_id, []).append(thread.topic_name)
    for stream_id, topic_name in plain_topics:
        topic_names_by_stream_id.setdefault(stream_id, []).append(topic_name)
    if not topic_names_by_stream_id:
        return []

    # Per topic: how many messages, the newest one's time and the
    # oldest one's id, in one query per history kind (readable_messages'
    # rule across channels).
    open_history = Q()
    protected_history = Q()
    for stream_id, topic_names in topic_names_by_stream_id.items():
        topics = Q(recipient_id=recipient_ids[stream_id]) & topic_filter(topic_names)
        if stream_id in protected_stream_ids:
            protected_history |= topics
        else:
            open_history |= topics
    channel_messages = Message.objects.filter(
        realm_id=user_profile.realm_id, is_channel_message=True
    )
    stats: dict[tuple[int, str], dict[str, Any]] = {}
    for history, queryset in (
        (open_history, channel_messages),
        (protected_history, channel_messages.filter(usermessage__user_profile_id=user_profile.id)),
    ):
        if not history:
            continue
        for row in (
            queryset.filter(history)
            .annotate(upper_subject=Upper("subject"))
            .values("recipient_id", "upper_subject")
            .annotate(
                message_count=Count("id"),
                last_sent=Max("date_sent"),
                first_id=Min("id"),
                last_id=Max("id"),
            )
        ):
            stats[(row["recipient_id"], row["upper_subject"])] = row

    # The roots: a thread's root message, a plain topic's first message.
    root_ids = [thread.root_message_id for thread in threads]
    plain_root_ids: dict[tuple[int, str], int] = {}
    for stream_id, topic_name in plain_topics:
        topic_stats = stats.get((recipient_ids[stream_id], topic_name.upper()))
        if topic_stats is not None:
            plain_root_ids[(stream_id, topic_name)] = topic_stats["first_id"]
            root_ids.append(topic_stats["first_id"])
    roots = {
        root_id: (sender_id, sender_full_name, content, date_sent)
        for root_id, sender_id, sender_full_name, content, date_sent in Message.objects.filter(
            id__in=root_ids
        ).values_list("id", "sender_id", "sender__full_name", "content", "date_sent")
    }

    def row_dict(
        *,
        root_id: int,
        stream_id: int,
        topic_name: str,
        is_thread: bool,
        reply_count: int,
        last_reply: datetime | None,
    ) -> ThreadRowDict:
        sender_id, sender_full_name, content, date_sent = roots[root_id]
        root_timestamp = datetime_to_timestamp(date_sent)
        last_reply_timestamp = datetime_to_timestamp(last_reply) if last_reply else None
        return ThreadRowDict(
            root_message_id=root_id,
            stream_id=stream_id,
            topic_name=topic_name,
            is_thread=is_thread,
            reply_count=reply_count,
            last_reply_timestamp=last_reply_timestamp,
            root_sender_id=sender_id,
            root_sender_full_name=sender_full_name,
            root_snippet=thread_topic_snippet(content, THREAD_ROW_SNIPPET_LENGTH),
            root_timestamp=root_timestamp,
            last_activity_timestamp=max(root_timestamp, last_reply_timestamp or 0),
        )

    # Newest activity first; the newest message's id breaks ties between
    # rows whose activity falls in the same second.
    rows: list[tuple[int, int, ThreadRowDict]] = []
    for thread in threads:
        if thread.root_message_id not in roots:
            continue
        topic_stats = stats.get((recipient_ids[thread.stream_id], thread.topic_name.upper()))
        thread_row = row_dict(
            root_id=thread.root_message_id,
            stream_id=thread.stream_id,
            topic_name=thread.topic_name,
            is_thread=True,
            reply_count=topic_stats["message_count"] if topic_stats else 0,
            last_reply=topic_stats["last_sent"] if topic_stats else None,
        )
        last_id = topic_stats["last_id"] if topic_stats else thread.root_message_id
        rows.append((thread_row["last_activity_timestamp"], last_id, thread_row))
    for (stream_id, topic_name), root_id in plain_root_ids.items():
        topic_stats = stats[(recipient_ids[stream_id], topic_name.upper())]
        # The first message is the root; a reply is any later one.
        reply_count = topic_stats["message_count"] - 1
        topic_row = row_dict(
            root_id=root_id,
            stream_id=stream_id,
            topic_name=topic_name,
            is_thread=False,
            reply_count=reply_count,
            last_reply=topic_stats["last_sent"] if reply_count > 0 else None,
        )
        rows.append((topic_row["last_activity_timestamp"], topic_stats["last_id"], topic_row))
    rows.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)
    return [thread_row for _timestamp, _last_id, thread_row in rows[:MAX_MY_THREADS]]


def thread_activity(user_profile: UserProfile, *, client_gravatar: bool) -> list[dict[str, Any]]:
    """Other people's replies in the threads the user wrote the root
    of, started or replied in, and in the other topics (not general
    chat) the user sent a message to or was mentioned in, newest first, as message dicts in the shape of GET
    /messages so the Activity view can merge them with its other
    feeds."""
    streams = {stream.id: stream for stream in accessible_streams(user_profile)}
    if not streams:
        return []
    threads = followed_threads(user_profile, streams)
    topic_names_by_stream_id: dict[int, list[str]] = {}
    for thread in threads:
        topic_names_by_stream_id.setdefault(thread.stream_id, []).append(thread.topic_name)
    for stream_id, topic_name in unthreaded_participated_topics(
        user_profile, list(streams.values())
    )[:MAX_ACTIVITY_THREADS]:
        topic_names_by_stream_id.setdefault(stream_id, []).append(topic_name)

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
