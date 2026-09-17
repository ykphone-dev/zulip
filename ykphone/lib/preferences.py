from django.db import transaction
from django.utils.translation import gettext as _

from ykphone.models import RealmPreference, UserPreference
from zerver.lib.exceptions import JsonableError
from zerver.models import Realm, UserProfile
from zerver.tornado.django_api import send_event_on_commit

# The shell colour themes, in the order the picker shows them. Keep in
# sync with web/src/ykphone_shell_theme.ts and the [data-yk-theme]
# blocks of web/styles/ykphone_theme.css (a test checks all three).
SHELL_THEMES = [
    "ykphone",
    "navy",
    "graphite",
    "forest",
    "burgundy",
    "ocean",
    "sand",
    "midnight",
]
DEFAULT_SHELL_THEME = "ykphone"


def check_shell_theme(shell_theme: str) -> str:
    if shell_theme not in SHELL_THEMES:
        raise JsonableError(_("Invalid theme: {theme}").format(theme=shell_theme))
    return shell_theme


def effective_shell_theme(user_theme: str | None, realm_default: str | None) -> str:
    """The user's own choice, else the organization's default, else the
    fork's. A stored name the code no longer knows (a theme that was
    removed) falls through to the next one."""
    for theme in (user_theme, realm_default):
        if theme in SHELL_THEMES:
            assert theme is not None
            return theme
    return DEFAULT_SHELL_THEME


def realm_default_shell_theme(realm: Realm) -> str:
    realm_default = (
        RealmPreference.objects.filter(realm=realm)
        .values_list("default_shell_theme", flat=True)
        .first()
    )
    return effective_shell_theme(None, realm_default)


def get_shell_theme(user_profile: UserProfile) -> str:
    """One query, since the home page calls this on every load."""
    user_theme, realm_default = (
        UserProfile.objects.filter(id=user_profile.id)
        .values_list(
            "ykphone_preference__shell_theme", "realm__ykphone_preference__default_shell_theme"
        )
        .get()
    )
    return effective_shell_theme(user_theme, realm_default)


def shell_theme_for_page_load(user_profile: UserProfile | None, realm: Realm) -> str:
    """The theme the server writes onto the page's <html> element, so the
    shell is painted in it from the first frame. Spectators see the
    organization's default."""
    if user_profile is None:
        return realm_default_shell_theme(realm)
    return get_shell_theme(user_profile)


def shell_theme_event(shell_theme: str) -> dict[str, object]:
    return {"type": "ykphone_preference", "property": "shell_theme", "value": shell_theme}


def do_set_shell_theme(user_profile: UserProfile, shell_theme: str) -> None:
    """Stores the user's choice and tells the user's other clients, which
    switch without a reload."""
    with transaction.atomic(durable=True):
        previous = get_shell_theme(user_profile)
        UserPreference.objects.update_or_create(
            user=user_profile, defaults={"shell_theme": shell_theme}
        )
        if previous != shell_theme:
            send_event_on_commit(
                user_profile.realm, shell_theme_event(shell_theme), [user_profile.id]
            )


def do_set_realm_default_shell_theme(
    realm: Realm, shell_theme: str, *, apply_to_existing_users: bool = False
) -> list[int]:
    """Sets the organization's default. Users who have not chosen a theme
    (or whose choice names a theme that no longer exists) follow it. With
    ``apply_to_existing_users`` the active humans' own choices are
    removed, so that everyone follows the default from then on, including
    later changes of it. Returns the ids of the users whose theme changed,
    who are sent the event."""
    with transaction.atomic(durable=True):
        previous_default = realm_default_shell_theme(realm)
        RealmPreference.objects.update_or_create(
            realm=realm, defaults={"default_shell_theme": shell_theme}
        )
        users = UserProfile.objects.filter(realm=realm, is_active=True, is_bot=False)
        choices = dict(
            UserPreference.objects.filter(user__in=users).values_list("user_id", "shell_theme")
        )
        user_ids = []
        for user_id in users.order_by("id").values_list("id", flat=True):
            theme_before = effective_shell_theme(choices.get(user_id), previous_default)
            choice_after = None if apply_to_existing_users else choices.get(user_id)
            if effective_shell_theme(choice_after, shell_theme) != theme_before:
                user_ids.append(user_id)
        if apply_to_existing_users:
            UserPreference.objects.filter(user__in=users).delete()
        if user_ids:
            send_event_on_commit(realm, shell_theme_event(shell_theme), user_ids)
        return user_ids
