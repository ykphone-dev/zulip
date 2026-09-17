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
