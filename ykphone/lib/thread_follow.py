"""Following threads for the 옆커폰 fork.

"Notify me about replies in threads I follow" is Zulip's followed-topic
notifications, since a thread is a topic. For that to mean threads only,
the fork's defaults (apply_slack_defaults) turn Zulip's automatic
following off — it would follow a channel's general chat, which is a
topic too, whenever the user posts there first or is mentioned there —
and the fork follows a thread's topic itself, through Zulip's topic
visibility API, when the user starts the thread, wrote its root message
or replies in it. So "followed topics" is "threads I take part in".

Users whose automatic following is not "never" (Zulip's own default)
are left to Zulip, which follows the topics they post in already.
"""

from ykphone.models import MessageThread
from zerver.actions.user_topics import do_set_user_topic_visibility_policy
from zerver.models import Message, Stream, UserProfile, UserTopic


def follows_threads_itself(user_profile: UserProfile) -> bool:
    return (
        not user_profile.is_bot
        and user_profile.is_active
        and user_profile.automatically_follow_topics_policy
        == UserProfile.AUTOMATICALLY_CHANGE_VISIBILITY_POLICY_NEVER
    )


def follow_thread(user_profile: UserProfile, stream: Stream, topic_name: str) -> None:
    """Follows the thread's topic, unless the user chose a visibility for
    it already (muted, unmuted or followed)."""
    if not follows_threads_itself(user_profile):
        return
    if UserTopic.objects.filter(
        user_profile=user_profile, stream_id=stream.id, topic_name__iexact=topic_name
    ).exists():
        return
    do_set_user_topic_visibility_policy(
        user_profile,
        stream,
        topic_name,
        visibility_policy=UserTopic.VisibilityPolicy.FOLLOWED,
    )


def follow_new_thread(thread: MessageThread, creator: UserProfile) -> None:
    """A thread was started: its starter and the root's author follow it."""
    follow_thread(creator, thread.stream, thread.topic_name)
    root_sender = thread.root_message.sender
    if root_sender.id != creator.id:
        follow_thread(root_sender, thread.stream, thread.topic_name)


def follow_thread_on_send(sender: UserProfile, stream: Stream, message: Message) -> None:
    """Called by Zulip's do_send_messages for each channel message: a
    reply in a thread follows the thread for its sender. General chat
    (the empty topic) never is."""
    if not follows_threads_itself(sender):
        return
    topic_name = message.topic_name()
    if (
        topic_name == ""
        or not MessageThread.objects.filter(
            stream_id=stream.id, topic_name__iexact=topic_name
        ).exists()
    ):
        return
    follow_thread(sender, stream, topic_name)
