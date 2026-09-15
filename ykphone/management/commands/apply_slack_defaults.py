from argparse import ArgumentParser
from typing import Any

from typing_extensions import override

from zerver.actions.realm_settings import do_set_realm_property, do_set_realm_user_default_setting
from zerver.actions.user_settings import bulk_change_user_setting, set_avatar_to_default
from zerver.lib.management import ZulipBaseCommand
from zerver.models import RealmUserDefault, UserProfile

# The base size the theme scales everything from; a step below Slack's
# 15px, which read as too large.
SLACK_FONT_SIZE_PX = 14


class Command(ZulipBaseCommand):
    help = """Apply the Slack-like defaults of the 옆커폰 fork to an organization.

Sets the organization's defaults so that new users send with Enter
(Shift+Enter inserts a newline), read at a compact font size, see a
count rather than a list of names on an emoji reaction, and get the
neutral default profile picture instead of a generated pattern.
With --existing-users the settings are also applied to every active
human user of the organization, and the generated pattern pictures
those users still have are replaced by the default one."""

    @override
    def add_arguments(self, parser: ArgumentParser) -> None:
        self.add_realm_args(parser, required=True)
        parser.add_argument(
            "--existing-users",
            action="store_true",
            help="Also apply the defaults to all active human users.",
        )

    @override
    def handle(self, *args: Any, **options: Any) -> None:
        realm = self.get_realm(options)
        assert realm is not None

        realm_user_default = RealmUserDefault.objects.get(realm=realm)
        do_set_realm_user_default_setting(realm_user_default, "enter_sends", True, acting_user=None)
        do_set_realm_user_default_setting(
            realm_user_default, "web_font_size_px", SLACK_FONT_SIZE_PX, acting_user=None
        )
        # Slack's reaction chips always read as a count ("2"); Zulip
        # names the reactors instead, which is too wide for the chip.
        do_set_realm_user_default_setting(
            realm_user_default, "display_emoji_reaction_users", False, acting_user=None
        )
        do_set_realm_property(
            realm, "default_avatar_source", UserProfile.AVATAR_FROM_GRAVATAR, acting_user=None
        )
        self.stdout.write(f"Applied the Slack defaults for new users of {realm.string_id}.")

        if options["existing_users"]:
            users = list(
                UserProfile.objects.filter(
                    realm=realm, is_active=True, is_bot=False
                ).select_related("realm")
            )
            bulk_change_user_setting(realm, users, "enter_sends", True, acting_user=None)
            bulk_change_user_setting(
                realm, users, "web_font_size_px", SLACK_FONT_SIZE_PX, acting_user=None
            )
            bulk_change_user_setting(
                realm, users, "display_emoji_reaction_users", False, acting_user=None
            )
            patterned = [
                user for user in users if user.avatar_source == UserProfile.AVATAR_FROM_JDENTICON
            ]
            for user in patterned:
                set_avatar_to_default(user, acting_user=None)
            self.stdout.write(
                f"Applied the Slack defaults to {len(users)} existing users and replaced "
                f"{len(patterned)} generated profile pictures."
            )
