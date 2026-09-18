import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("ykphone", "0005_notificationpause_statusexpiry"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="ExpoPushToken",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True, primary_key=True, serialize=False, verbose_name="ID"
                    ),
                ),
                ("token", models.CharField(max_length=255, unique=True)),
                ("date_created", models.DateTimeField(default=django.utils.timezone.now)),
                ("last_registered", models.DateTimeField(default=django.utils.timezone.now)),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="ykphone_expo_push_tokens",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
        ),
    ]
