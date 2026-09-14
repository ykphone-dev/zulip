from argparse import ArgumentParser
from typing import Any

from typing_extensions import override

from zerver.actions.realm_settings import do_set_realm_user_default_setting
from zerver.actions.user_settings import bulk_change_user_setting
from zerver.lib.management import ZulipBaseCommand
from zerver.models import RealmUserDefault, UserProfile


class Command(ZulipBaseCommand):
    help = """Apply the Slack-like defaults of the 옆커폰 fork to an organization.

Sets the organization's default for "Enter sends" so that new users
send with Enter and insert a newline with Shift+Enter, as in Slack.
With --existing-users the setting is also turned on for every active
human user of the organization."""

    @override
    def add_arguments(self, parser: ArgumentParser) -> None:
        self.add_realm_args(parser, required=True)
        parser.add_argument(
            "--existing-users",
            action="store_true",
            help="Also enable Enter-to-send for all active human users.",
        )

    @override
    def handle(self, *args: Any, **options: Any) -> None:
        realm = self.get_realm(options)
        assert realm is not None

        realm_user_default = RealmUserDefault.objects.get(realm=realm)
        do_set_realm_user_default_setting(
            realm_user_default, "enter_sends", True, acting_user=None
        )
        self.stdout.write(f"Enabled Enter-to-send by default for new users of {realm.string_id}.")

        if options["existing_users"]:
            users = list(UserProfile.objects.filter(realm=realm, is_active=True, is_bot=False))
            bulk_change_user_setting(realm, users, "enter_sends", True, acting_user=None)
            self.stdout.write(f"Enabled Enter-to-send for {len(users)} existing users.")
