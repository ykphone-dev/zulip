from argparse import ArgumentParser
from typing import Any

from typing_extensions import override

from ykphone.lib.preferences import SHELL_THEMES, do_set_realm_default_shell_theme
from zerver.actions.realm_settings import do_set_realm_property, do_set_realm_user_default_setting
from zerver.actions.user_settings import bulk_change_user_setting, set_avatar_to_default
from zerver.actions.user_topics import do_set_user_topic_visibility_policy
from zerver.lib.management import ZulipBaseCommand
from zerver.models import RealmUserDefault, UserProfile, UserTopic

# The base size the theme scales everything from; a step below Slack's
# 15px, which read as too large.
SLACK_FONT_SIZE_PX = 14

AUTO_FOLLOW_OFF: dict[str, int | bool] = {
    "automatically_follow_topics_policy": UserProfile.AUTOMATICALLY_CHANGE_VISIBILITY_POLICY_NEVER,
    "automatically_follow_topics_where_mentioned": False,
}


def unfollow_general_chats(users: list[UserProfile]) -> int:
    """Stops following the general chats (the empty topic) that Zulip
    followed for the users automatically; they cannot be told apart from
    ones followed by hand, which the fork's UI does not offer. Returns
    how many were unfollowed."""
    followed = UserTopic.objects.filter(
        user_profile__in=users,
        topic_name="",
        visibility_policy=UserTopic.VisibilityPolicy.FOLLOWED,
    ).select_related("user_profile", "stream")
    count = 0
    for user_topic in followed:
        do_set_user_topic_visibility_policy(
            user_topic.user_profile,
            user_topic.stream,
            "",
            visibility_policy=UserTopic.VisibilityPolicy.INHERIT,
        )
        count += 1
    return count


class Command(ZulipBaseCommand):
    help = """Apply the Slack-like defaults of the 옆커폰 fork to an organization.

Sets the organization's defaults so that new users send with Enter
(Shift+Enter inserts a newline), read at a compact font size, see a
count rather than a list of names on an emoji reaction, see only
direct messages and mentions in the unread count of the browser tab
and app icon, follow threads rather than every topic they post in
(so that followed-topic notifications are thread replies, not a
channel's general chat), get the neutral default profile picture instead of a
generated pattern, and see a preview card under links, as in Slack.
Messages can be edited and deleted at any time after sending, as in
Slack (who may delete still follows the organization's permissions).
With --shell-theme the organization's default colour theme of the
shell (rail, sidebar and navbar) is set too; users who have not
picked a theme see it. With --existing-users the settings are also
applied to every active human user of the organization, and the
generated pattern pictures those users still have are replaced by the
default one; for --shell-theme that means their own theme choices are
removed, so that they follow the organization's default from then on.
Existing users also stop following the channels' general chats that
Zulip followed for them."""

    @override
    def add_arguments(self, parser: ArgumentParser) -> None:
        self.add_realm_args(parser, required=True)
        parser.add_argument(
            "--existing-users",
            action="store_true",
            help="Also apply the defaults to all active human users.",
        )
        parser.add_argument(
            "--shell-theme",
            choices=SHELL_THEMES,
            help="The organization's default theme for the rail, sidebar and navbar; "
            "with --existing-users, users' own theme choices are removed.",
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
        # The tab title and app icon count what the sidebar and rail count
        # in numbers: direct messages and mentions (Slack's red badge).
        # The option with followed topics would also count every general
        # chat the user has posted in, since Zulip follows the topics one
        # sends to and general chat is a topic; the sidebar shows those
        # channels in bold, without a number.
        do_set_realm_user_default_setting(
            realm_user_default,
            "desktop_icon_count_display",
            UserProfile.DESKTOP_ICON_COUNT_DISPLAY_DM_MENTION,
            acting_user=None,
        )
        # Followed topics are the fork's threads: Zulip's automatic
        # following would also follow a channel's general chat (a topic)
        # whenever the user posts there first or is mentioned there, and
        # "replies in threads I follow" would then ring for all of it.
        # The fork follows threads itself (ykphone.lib.thread_follow).
        for setting_name, value in AUTO_FOLLOW_OFF.items():
            do_set_realm_user_default_setting(
                realm_user_default, setting_name, value, acting_user=None
            )
        do_set_realm_property(
            realm, "default_avatar_source", UserProfile.AVATAR_FROM_GRAVATAR, acting_user=None
        )
        # Zulip's organizations start with link previews off; Slack shows
        # them for every link.
        do_set_realm_property(realm, "inline_url_embed_preview", True, acting_user=None)
        # Zulip's organizations lock a message 10 minutes after it is
        # sent; Slack has no such limit. None means no limit.
        do_set_realm_property(realm, "message_content_edit_limit_seconds", None, acting_user=None)
        do_set_realm_property(realm, "message_content_delete_limit_seconds", None, acting_user=None)
        self.stdout.write(f"Applied the Slack defaults for new users of {realm.string_id}.")

        if options["shell_theme"] is not None:
            changed_user_ids = do_set_realm_default_shell_theme(
                realm,
                options["shell_theme"],
                apply_to_existing_users=options["existing_users"],
            )
            self.stdout.write(
                f"Set the default theme to {options['shell_theme']}; "
                f"{len(changed_user_ids)} users see a new theme."
            )

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
            bulk_change_user_setting(
                realm,
                users,
                "desktop_icon_count_display",
                UserProfile.DESKTOP_ICON_COUNT_DISPLAY_DM_MENTION,
                acting_user=None,
            )
            for setting_name, value in AUTO_FOLLOW_OFF.items():
                bulk_change_user_setting(realm, users, setting_name, value, acting_user=None)
            unfollowed = unfollow_general_chats(users)
            patterned = [
                user for user in users if user.avatar_source == UserProfile.AVATAR_FROM_JDENTICON
            ]
            for user in patterned:
                set_avatar_to_default(user, acting_user=None)
            self.stdout.write(
                f"Applied the Slack defaults to {len(users)} existing users, replaced "
                f"{len(patterned)} generated profile pictures and unfollowed "
                f"{unfollowed} general chats."
            )
