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
