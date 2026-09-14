from io import StringIO

from django.core.management import call_command
from django.core.management.base import CommandError
from typing_extensions import override

from zerver.actions.realm_settings import do_set_realm_user_default_setting
from zerver.actions.user_settings import do_change_user_setting
from zerver.actions.users import do_deactivate_user
from zerver.lib.test_classes import ZulipTestCase
from zerver.models import RealmUserDefault, UserProfile
from zerver.models.realms import get_realm


class ApplySlackDefaultsTest(ZulipTestCase):
    @override
    def setUp(self) -> None:
        super().setUp()
        # The test fixtures already enable Enter-to-send in places;
        # start from it being off everywhere that matters here.
        realm = get_realm("zulip")
        do_set_realm_user_default_setting(
            RealmUserDefault.objects.get(realm=realm), "enter_sends", False, acting_user=None
        )
        for user in UserProfile.objects.filter(enter_sends=True):
            do_change_user_setting(user, "enter_sends", False, acting_user=None)

    def run_command(self, *args: str) -> str:
        output = StringIO()
        call_command("apply_slack_defaults", *args, stdout=output)
        return output.getvalue()

    def realm_default(self) -> bool:
        return RealmUserDefault.objects.get(realm=get_realm("zulip")).enter_sends

    def test_realm_default(self) -> None:
        hamlet = self.example_user("hamlet")
        self.assertFalse(self.realm_default())
        self.assertFalse(hamlet.enter_sends)

        output = self.run_command("--realm=zulip")
        self.assertIn("for new users of zulip", output)
        self.assertTrue(self.realm_default())
        # Existing users are untouched without --existing-users.
        hamlet.refresh_from_db()
        self.assertFalse(hamlet.enter_sends)

        # Running it again is harmless.
        self.run_command("--realm=zulip")
        self.assertTrue(self.realm_default())

    def test_existing_users(self) -> None:
        hamlet = self.example_user("hamlet")
        othello = self.example_user("othello")
        do_deactivate_user(othello, acting_user=None)
        bot = self.example_user("default_bot")
        king = self.lear_user("king")

        output = self.run_command("--realm=zulip", "--existing-users")
        self.assertIn("existing users", output)

        self.assertTrue(self.realm_default())
        for user in [hamlet, self.example_user("iago"), self.example_user("cordelia")]:
            user.refresh_from_db()
            self.assertTrue(user.enter_sends)
        # Deactivated users, bots and other organizations are left alone.
        for user in [othello, bot, king]:
            user.refresh_from_db()
            self.assertFalse(user.enter_sends)

    def test_unknown_realm(self) -> None:
        with self.assertRaisesRegex(CommandError, "There is no realm with id 'nope'"):
            self.run_command("--realm=nope")
