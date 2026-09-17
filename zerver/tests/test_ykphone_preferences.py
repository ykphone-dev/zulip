import re
from pathlib import Path
from typing import Any
from unittest.mock import patch

from django.conf import settings

from ykphone.lib.preferences import (
    SHELL_THEMES,
    do_set_realm_default_shell_theme,
    do_set_shell_theme,
    get_shell_theme,
)
from ykphone.models import RealmPreference, UserPreference
from zerver.actions.realm_settings import do_set_realm_property
from zerver.actions.users import do_deactivate_user
from zerver.lib.events import apply_events
from zerver.lib.test_classes import ZulipTestCase
from zerver.models import UserProfile
from zerver.models.realms import get_realm
from zerver.tornado.django_api import EventQueueData


def theme_event(theme: str) -> dict[str, object]:
    return {"type": "ykphone_preference", "property": "shell_theme", "value": theme}


class ShellThemeAPITest(ZulipTestCase):
    def get_theme(self, user: UserProfile) -> str:
        result = self.api_get(user, "/api/v1/ykphone/preferences")
        return self.assert_json_success(result)["shell_theme"]

    def set_theme(self, user: UserProfile, theme: str) -> Any:
        return self.api_patch(user, "/api/v1/ykphone/preferences", {"shell_theme": theme})

    def test_get_and_update(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        self.assertEqual(self.get_theme(hamlet), "ykphone")

        # The user's other clients learn about the change; nobody else does.
        with self.capture_send_event_calls(expected_num_events=1) as events:
            self.assert_json_success(self.set_theme(hamlet, "navy"))
        self.assertEqual(events[0]["event"], theme_event("navy"))
        self.assertEqual(events[0]["users"], [hamlet.id])
        self.assertEqual(self.get_theme(hamlet), "navy")
        self.assertEqual(UserPreference.objects.get(user=hamlet).shell_theme, "navy")
        self.assertEqual(self.get_theme(cordelia), "ykphone")

        # Choosing the same theme again stores nothing new and sends nothing.
        with self.capture_send_event_calls(expected_num_events=0):
            self.assert_json_success(self.set_theme(hamlet, "navy"))
        self.assertEqual(UserPreference.objects.filter(user=hamlet).count(), 1)

        self.assert_json_error(self.set_theme(hamlet, "pink"), "Invalid theme: pink")
        self.assert_json_error(
            self.api_patch(hamlet, "/api/v1/ykphone/preferences", {}),
            "Missing 'shell_theme' argument",
        )
        self.assertEqual(self.get_theme(hamlet), "navy")

    def test_organization_default(self) -> None:
        realm = get_realm("zulip")
        hamlet = self.example_user("hamlet")
        iago = self.example_user("iago")
        othello = self.example_user("othello")
        do_deactivate_user(othello, acting_user=None)
        bot = self.example_user("default_bot")
        king = self.lear_user("king")
        humans = set(
            UserProfile.objects.filter(realm=realm, is_active=True, is_bot=False).values_list(
                "id", flat=True
            )
        )
        do_set_shell_theme(iago, "forest")

        # Users who never chose follow the new default; iago keeps his.
        with self.capture_send_event_calls(expected_num_events=1) as events:
            changed = do_set_realm_default_shell_theme(realm, "sand")
        self.assertEqual(set(changed), humans - {iago.id})
        self.assertEqual(events[0]["event"], theme_event("sand"))
        self.assertEqual(set(events[0]["users"]), humans - {iago.id})
        self.assertEqual(get_shell_theme(hamlet), "sand")
        self.assertEqual(get_shell_theme(iago), "forest")
        self.assertEqual(get_shell_theme(king), "ykphone")

        # The same default again changes nobody.
        with self.capture_send_event_calls(expected_num_events=0):
            self.assertEqual(do_set_realm_default_shell_theme(realm, "sand"), [])

        # A user's choice equal to the default still pins it.
        do_set_shell_theme(hamlet, "sand")
        with self.capture_send_event_calls(expected_num_events=1) as events:
            changed = do_set_realm_default_shell_theme(realm, "ocean")
        self.assertEqual(set(changed), humans - {iago.id, hamlet.id})
        self.assertEqual(get_shell_theme(hamlet), "sand")

        # Applied to existing users, it removes their own choices, so that
        # they follow the default from then on; only active humans of the
        # organization are affected.
        UserPreference.objects.create(user=othello, shell_theme="navy")
        with self.capture_send_event_calls(expected_num_events=1) as events:
            changed = do_set_realm_default_shell_theme(
                realm, "ocean", apply_to_existing_users=True
            )
        self.assertEqual(set(changed), {iago.id, hamlet.id})
        self.assertEqual(set(events[0]["users"]), {iago.id, hamlet.id})
        self.assertEqual(get_shell_theme(iago), "ocean")
        self.assertEqual(get_shell_theme(hamlet), "ocean")
        self.assertFalse(UserPreference.objects.filter(user__in=[hamlet, iago]).exists())
        self.assertEqual(UserPreference.objects.get(user=othello).shell_theme, "navy")

        # So a later default without it reaches everyone, including a user
        # whose stored choice names a theme that no longer exists.
        UserPreference.objects.create(user=self.example_user("cordelia"), shell_theme="retired")
        with self.capture_send_event_calls(expected_num_events=1) as events:
            changed = do_set_realm_default_shell_theme(realm, "midnight")
        self.assertEqual(set(changed), humans)
        self.assertEqual(get_shell_theme(hamlet), "midnight")
        self.assertEqual(get_shell_theme(iago), "midnight")

        # Nothing changes for the user with an unknown choice when it is
        # removed and the default stays the same.
        with self.capture_send_event_calls(expected_num_events=0):
            changed = do_set_realm_default_shell_theme(
                realm, "midnight", apply_to_existing_users=True
            )
        self.assertEqual(changed, [])
        self.assertEqual(RealmPreference.objects.get(realm=realm).default_shell_theme, "midnight")
        self.assertFalse(UserPreference.objects.filter(user__realm=realm, user__is_active=True).exists())

    def test_unknown_stored_theme(self) -> None:
        # A theme removed from the code falls through to the default.
        hamlet = self.example_user("hamlet")
        realm = hamlet.realm
        UserPreference.objects.create(user=hamlet, shell_theme="retired")
        self.assertEqual(get_shell_theme(hamlet), "ykphone")
        RealmPreference.objects.create(realm=realm, default_shell_theme="burgundy")
        self.assertEqual(get_shell_theme(hamlet), "burgundy")
        RealmPreference.objects.filter(realm=realm).update(default_shell_theme="retired")
        self.assertEqual(get_shell_theme(hamlet), "ykphone")

    def get_home_page(self) -> str:
        queue_data = EventQueueData(queue_id="test-queue-id", idle_queue_timeout_secs=600)
        with (
            patch("zerver.lib.events.request_event_queue", return_value=queue_data),
            patch("zerver.lib.events.get_user_events", return_value=[]),
        ):
            result = self.client_get("/")
        self.assertEqual(result.status_code, 200)
        return result.content.decode()

    def test_page_load(self) -> None:
        # The theme is on the page's root element before any script runs.
        hamlet = self.example_user("hamlet")
        self.login_user(hamlet)
        self.assertIn('data-yk-theme="ykphone"', self.get_home_page())
        do_set_shell_theme(hamlet, "graphite")
        self.assertIn('data-yk-theme="graphite"', self.get_home_page())
        self.logout()

        # Spectators see the organization's default.
        realm = get_realm("zulip")
        do_set_realm_property(realm, "enable_spectator_access", True, acting_user=None)
        self.assertIn('data-yk-theme="ykphone"', self.get_home_page())
        do_set_realm_default_shell_theme(realm, "burgundy")
        self.assertIn('data-yk-theme="burgundy"', self.get_home_page())

        # Other pages built on the same base template carry no theme.
        result = self.client_get("/login/")
        self.assertNotIn("data-yk-theme", result.content.decode())

    def test_event_is_not_register_state(self) -> None:
        # apply_events runs on events that arrive while a client's initial
        # state is fetched; preferences are not part of that state.
        state = {"zulip_version": "test"}
        apply_events(
            self.example_user("hamlet"),
            state=state,
            events=[theme_event("navy")],
            fetch_event_types=None,
            client_gravatar=True,
            slim_presence=True,
            include_subscribers=False,
            linkifier_url_template=True,
            user_list_incomplete=True,
            include_deactivated_groups=True,
        )
        self.assertEqual(state, {"zulip_version": "test"})

    def test_themes_match_web_app(self) -> None:
        # The server, the web app's registry and the stylesheet must know
        # the same themes, in the same order for the first two.
        deploy_root = Path(settings.DEPLOY_ROOT)
        registry = (deploy_root / "web/src/ykphone_shell_theme.ts").read_text()
        self.assertEqual(re.findall(r'^\s+id: "([a-z]+)",$', registry, re.MULTILINE), SHELL_THEMES)
        stylesheet = (deploy_root / "web/styles/ykphone_theme.css").read_text()
        self.assertEqual(
            sorted(set(re.findall(r'\[data-yk-theme="([a-z]+)"\]', stylesheet))),
            sorted(SHELL_THEMES),
        )

    def test_requires_login(self) -> None:
        for result in (
            self.client_get("/json/ykphone/preferences"),
            self.client_patch("/json/ykphone/preferences", {"shell_theme": "navy"}),
        ):
            self.assert_json_error(
                result, "Not logged in: API authentication or user session required", 401
            )
