from django.db import models
from django.db.models import CASCADE
from django.utils.timezone import now as timezone_now

from zerver.models import Message, Realm, Stream, UserProfile
from zerver.models.constants import MAX_TOPIC_NAME_LENGTH


class MessageThread(models.Model):
    """A Slack-style thread hanging off one channel message.

    The thread's replies live in an ordinary Zulip topic, so every
    client (including the mobile apps) sees them without knowing about
    this table; what the table adds is the link from the root message
    to that topic, which the web app uses to show a reply count under
    the root and to open the thread from it.
    """

    realm = models.ForeignKey(Realm, on_delete=CASCADE)
    stream = models.ForeignKey(Stream, on_delete=CASCADE)
    root_message = models.OneToOneField(Message, on_delete=CASCADE, related_name="ykphone_thread")
    topic_name = models.CharField(max_length=MAX_TOPIC_NAME_LENGTH)
    creator = models.ForeignKey(UserProfile, null=True, on_delete=models.SET_NULL)
    date_created = models.DateTimeField(default=timezone_now)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["stream", "topic_name"], name="ykphone_messagethread_stream_topic"
            ),
        ]


class PinnedMessage(models.Model):
    """A channel message pinned to its channel, Slack style.

    Anyone who can read the message may pin or unpin it; the pin goes
    away with the message (the one-to-one link cascades). ``stream`` is
    the channel at pin time, kept for the record only: messages can be
    moved, so ykphone.lib.pins reads the channel from the message.
    """

    realm = models.ForeignKey(Realm, on_delete=CASCADE)
    stream = models.ForeignKey(Stream, on_delete=CASCADE)
    message = models.OneToOneField(Message, on_delete=CASCADE, related_name="ykphone_pin")
    pinned_by = models.ForeignKey(UserProfile, null=True, on_delete=models.SET_NULL)
    date_pinned = models.DateTimeField(default=timezone_now)


class UserPreference(models.Model):
    """A user's own choices for the 옆커폰 web app, synced across their
    devices. ``shell_theme`` names one of the colour themes of the
    shell (rail, sidebar and navbar) in ykphone.lib.preferences; a user
    without a row sees their organization's default."""

    user = models.OneToOneField(UserProfile, on_delete=CASCADE, related_name="ykphone_preference")
    shell_theme = models.CharField(max_length=32)


class RealmPreference(models.Model):
    """Organization-wide defaults of the 옆커폰 web app, like Zulip's
    RealmUserDefault: what a user sees until they choose for themself
    (and what spectators of the organization see)."""

    realm = models.OneToOneField(Realm, on_delete=CASCADE, related_name="ykphone_preference")
    default_shell_theme = models.CharField(max_length=32)


class SavedItem(models.Model):
    """A message in a user's Later list (Slack's saved items).

    Kept in step with Zulip's star flag by ykphone.lib.saved: starring
    a message adds an item in progress and unstarring removes it, so
    Zulip's own clients and the fork agree on what is saved. The state
    and the due date are the fork's own; archiving unstars the message
    and keeps the item under Archived.
    """

    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    ARCHIVED = "archived"
    STATES = (IN_PROGRESS, COMPLETED, ARCHIVED)

    user = models.ForeignKey(UserProfile, on_delete=CASCADE, related_name="ykphone_saved_items")
    message = models.ForeignKey(Message, on_delete=CASCADE, related_name="ykphone_saved_items")
    state = models.CharField(max_length=16, default=IN_PROGRESS)
    due = models.DateTimeField(null=True)
    date_created = models.DateTimeField(default=timezone_now)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["user", "message"], name="ykphone_saveditem_user_message"
            ),
        ]


class NotificationPause(models.Model):
    """A user's "pause notifications" state (Slack's do not disturb).

    ``paused_until`` pauses everything until that time; ``schedule`` is
    the notification schedule, the hours (in the user's own time zone)
    in which notifications are allowed: ``{"enabled": bool, "days":
    [0-6, Monday = 0], "start": "HH:MM", "end": "HH:MM"}``, where an end
    at or before the start runs past midnight. ykphone.lib.notification_pause
    decides from both whether mobile push and email notifications are
    held back; nothing is sent later for what a pause held back.
    """

    user = models.OneToOneField(
        UserProfile, on_delete=CASCADE, related_name="ykphone_notification_pause"
    )
    paused_until = models.DateTimeField(null=True)
    schedule = models.JSONField(default=dict)
    # Whether the others were last told the user is paused
    # (ykphone_paused_users); the per-minute job compares it with the
    # state now, so pauses that run out, schedule boundaries and time
    # zone changes reach them too.
    announced_paused = models.BooleanField(default=False)
    # The settings page's "send notifications to my mobile devices",
    # kept here because Zulip's push settings cannot hold it while
    # nothing is to be pushed ("Nothing"); None until first chosen.
    mobile_notifications = models.BooleanField(null=True)


class StatusExpiry(models.Model):
    """When a user's status (Zulip's UserStatus) is to be cleared, from
    the status modal's "Clear after". The management command
    ykphone_clear_expired_statuses clears it once ``clear_at`` has
    passed, if the status is still the one the time was set for;
    setting or clearing the status by hand forgets the row."""

    user = models.OneToOneField(
        UserProfile, on_delete=CASCADE, related_name="ykphone_status_expiry"
    )
    clear_at = models.DateTimeField(db_index=True)
    # The status the time was set for: only that status is cleared, so a
    # status saved in the moment before the job runs is left alone.
    status_text = models.TextField(default="")
    emoji_name = models.TextField(default="")
    emoji_code = models.TextField(default="")


class ExpoPushToken(models.Model):
    """An Expo push token of the 옆커폰 chat app (a WebView around this
    web app, ykphone-dev/ykphone-chat-app), registered by the app from
    the logged-in page. ykphone.lib.expo_push sends to it through Expo's
    push service for every message the user receives, instead of
    Zulip's own mobile push, which only reaches the official apps.

    PROTECT rather than CASCADE: Zulip deactivates users rather than
    deleting them, and a hard delete that meets a token should stop
    instead of dropping rows silently."""

    user = models.ForeignKey(
        UserProfile, on_delete=models.PROTECT, related_name="ykphone_expo_push_tokens"
    )
    # "ExponentPushToken[...]"; unique so that a phone that changes hands
    # moves its token to the new user instead of pushing to both.
    token = models.CharField(max_length=255, unique=True)
    date_created = models.DateTimeField(default=timezone_now)
    last_registered = models.DateTimeField(default=timezone_now)
