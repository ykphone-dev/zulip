from io import StringIO

from django.core.management import call_command
from django.core.management.base import CommandError
from typing_extensions import override

from zerver.actions.realm_settings import do_set_realm_property, do_set_realm_user_default_setting
from zerver.actions.user_settings import do_change_avatar_fields, do_change_user_setting
from zerver.actions.users import do_deactivate_user
from zerver.lib.test_classes import ZulipTestCase
from zerver.models import Realm, RealmUserDefault, UserProfile
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
        do_set_realm_user_default_setting(
            RealmUserDefault.objects.get(realm=realm),
            "display_emoji_reaction_users",
            True,
            acting_user=None,
        )
        for user in UserProfile.objects.filter(display_emoji_reaction_users=False):
            do_change_user_setting(user, "display_emoji_reaction_users", True, acting_user=None)
        do_set_realm_property(
            realm, "default_avatar_source", UserProfile.AVATAR_FROM_JDENTICON, acting_user=None
        )
        for name in ["hamlet", "othello"]:
            do_change_avatar_fields(
                self.example_user(name), UserProfile.AVATAR_FROM_JDENTICON, acting_user=None
            )

    def run_command(self, *args: str) -> str:
        output = StringIO()
        call_command("apply_slack_defaults", *args, stdout=output)
        return output.getvalue()

    def realm_default(self) -> bool:
        return RealmUserDefault.objects.get(realm=get_realm("zulip")).enter_sends

    def realm_default_font_size(self) -> int:
        return RealmUserDefault.objects.get(realm=get_realm("zulip")).web_font_size_px

    def realm_default_reaction_users(self) -> bool:
        return RealmUserDefault.objects.get(realm=get_realm("zulip")).display_emoji_reaction_users

    def realm_default_icon_count(self) -> int:
        return RealmUserDefault.objects.get(realm=get_realm("zulip")).desktop_icon_count_display

    def realm_default_avatar_source(self) -> str:
        return Realm.objects.get(string_id="zulip").default_avatar_source

    def test_realm_default(self) -> None:
        hamlet = self.example_user("hamlet")
        self.assertFalse(self.realm_default())
        self.assertEqual(self.realm_default_font_size(), 16)
        self.assertTrue(self.realm_default_reaction_users())
        self.assertEqual(
            self.realm_default_icon_count(), UserProfile.DESKTOP_ICON_COUNT_DISPLAY_MESSAGES
        )
        self.assertEqual(self.realm_default_avatar_source(), UserProfile.AVATAR_FROM_JDENTICON)
        self.assertFalse(hamlet.enter_sends)

        output = self.run_command("--realm=zulip")
        self.assertIn("for new users of zulip", output)
        self.assertTrue(self.realm_default())
        self.assertEqual(self.realm_default_font_size(), 14)
        self.assertFalse(self.realm_default_reaction_users())
        self.assertEqual(
            self.realm_default_icon_count(), UserProfile.DESKTOP_ICON_COUNT_DISPLAY_DM_MENTION
        )
        self.assertEqual(self.realm_default_avatar_source(), UserProfile.AVATAR_FROM_GRAVATAR)
        # Existing users are untouched without --existing-users.
        hamlet.refresh_from_db()
        self.assertFalse(hamlet.enter_sends)
        self.assertEqual(
            hamlet.desktop_icon_count_display, UserProfile.DESKTOP_ICON_COUNT_DISPLAY_MESSAGES
        )
        self.assertEqual(hamlet.web_font_size_px, 16)
        self.assertTrue(hamlet.display_emoji_reaction_users)
        self.assertEqual(hamlet.avatar_source, UserProfile.AVATAR_FROM_JDENTICON)

        # Running it again is harmless.
        self.run_command("--realm=zulip")
        self.assertTrue(self.realm_default())

    def test_existing_users(self) -> None:
        hamlet = self.example_user("hamlet")
        othello = self.example_user("othello")
        do_deactivate_user(othello, acting_user=None)
        bot = self.example_user("default_bot")
        king = self.lear_user("king")

        # A user who already chose their own picture keeps it.
        cordelia = self.example_user("cordelia")
        do_change_avatar_fields(cordelia, UserProfile.AVATAR_FROM_USER, acting_user=None)
        hamlet_avatar_version = hamlet.avatar_version
        patterned_users = UserProfile.objects.filter(
            realm=get_realm("zulip"),
            is_active=True,
            is_bot=False,
            avatar_source=UserProfile.AVATAR_FROM_JDENTICON,
        )
        patterned_count = patterned_users.count()
        self.assertGreater(patterned_count, 1)

        output = self.run_command("--realm=zulip", "--existing-users")
        self.assertIn("existing users", output)
        self.assertIn(f"replaced {patterned_count} generated profile pictures", output)
        self.assertFalse(patterned_users.exists())

        self.assertTrue(self.realm_default())
        for user in [hamlet, self.example_user("iago"), cordelia]:
            user.refresh_from_db()
            self.assertTrue(user.enter_sends)
            self.assertEqual(user.web_font_size_px, 14)
            self.assertFalse(user.display_emoji_reaction_users)
            self.assertEqual(
                user.desktop_icon_count_display, UserProfile.DESKTOP_ICON_COUNT_DISPLAY_DM_MENTION
            )
        self.assertEqual(hamlet.avatar_source, UserProfile.AVATAR_FROM_GRAVATAR)
        self.assertEqual(hamlet.avatar_version, hamlet_avatar_version + 1)
        self.assertEqual(cordelia.avatar_source, UserProfile.AVATAR_FROM_USER)
        # Deactivated users, bots and other organizations are left alone.
        for user in [othello, bot, king]:
            user.refresh_from_db()
            self.assertFalse(user.enter_sends)
            self.assertEqual(user.web_font_size_px, 16)
            self.assertTrue(user.display_emoji_reaction_users)
            self.assertEqual(
                user.desktop_icon_count_display, UserProfile.DESKTOP_ICON_COUNT_DISPLAY_MESSAGES
            )
        self.assertEqual(othello.avatar_source, UserProfile.AVATAR_FROM_JDENTICON)

    def test_unknown_realm(self) -> None:
        with self.assertRaisesRegex(CommandError, "There is no realm with id 'nope'"):
            self.run_command("--realm=nope")
