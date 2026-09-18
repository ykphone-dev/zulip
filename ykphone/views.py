from django.http import HttpRequest, HttpResponse
from django.utils.translation import gettext as _
from pydantic import Json

from ykphone.lib.notification_pause import (
    check_schedule,
    do_set_notification_pause,
    get_pause,
    pause_dict,
    paused_user_ids,
)
from ykphone.lib.pins import pin_dict, pin_message, pins_for_stream, unpin_message
from ykphone.lib.preferences import check_shell_theme, do_set_shell_theme, get_shell_theme
from ykphone.lib.saved import (
    remove_saved_item,
    save_message,
    saved_dict,
    saved_items,
    update_saved_item,
)
from ykphone.lib.status_expiry import do_set_status_expiry, status_expiries
from ykphone.lib.threads import (
    get_or_create_thread,
    my_threads,
    thread_activity,
    thread_dict,
    threads_for_stream,
    unthreaded_participated_topics,
)
from zerver.decorator import human_users_only
from zerver.lib.exceptions import JsonableError
from zerver.lib.response import json_success
from zerver.lib.streams import access_stream_by_id
from zerver.lib.typed_endpoint import PathOnly, typed_endpoint, typed_endpoint_without_parameters
from zerver.models import UserProfile


@typed_endpoint
def create_thread(
    request: HttpRequest, user_profile: UserProfile, *, message_id: Json[int]
) -> HttpResponse:
    thread = get_or_create_thread(user_profile, message_id)
    return json_success(request, data=thread_dict(user_profile, thread))


@typed_endpoint
def get_threads(
    request: HttpRequest, user_profile: UserProfile, *, stream_id: Json[int]
) -> HttpResponse:
    stream, _sub = access_stream_by_id(user_profile, stream_id)
    return json_success(
        request,
        data={
            "threads": threads_for_stream(user_profile, stream),
            # Topics other than threads that the user takes part in,
            # whose unread messages the sidebar counts under Threads.
            "participated_topics": [
                topic_name
                for _stream_id, topic_name in unthreaded_participated_topics(user_profile, [stream])
            ],
        },
    )


@typed_endpoint
def get_thread_activity(
    request: HttpRequest, user_profile: UserProfile, *, client_gravatar: Json[bool] = True
) -> HttpResponse:
    return json_success(
        request,
        data={"messages": thread_activity(user_profile, client_gravatar=client_gravatar)},
    )


@typed_endpoint_without_parameters
def get_my_threads(request: HttpRequest, user_profile: UserProfile) -> HttpResponse:
    return json_success(request, data={"threads": my_threads(user_profile)})


@typed_endpoint
def get_pins(
    request: HttpRequest, user_profile: UserProfile, *, stream_id: Json[int]
) -> HttpResponse:
    return json_success(request, data={"pins": pins_for_stream(user_profile, stream_id)})


@typed_endpoint
def add_pin(
    request: HttpRequest, user_profile: UserProfile, *, message_id: Json[int]
) -> HttpResponse:
    return json_success(request, data=pin_dict(pin_message(user_profile, message_id)))


@typed_endpoint
def remove_pin(
    request: HttpRequest, user_profile: UserProfile, *, message_id: PathOnly[int]
) -> HttpResponse:
    unpin_message(user_profile, message_id)
    return json_success(request)


@typed_endpoint_without_parameters
def get_preferences(request: HttpRequest, user_profile: UserProfile) -> HttpResponse:
    return json_success(request, data={"shell_theme": get_shell_theme(user_profile)})


@typed_endpoint
def update_preferences(
    request: HttpRequest, user_profile: UserProfile, *, shell_theme: str
) -> HttpResponse:
    do_set_shell_theme(user_profile, check_shell_theme(shell_theme))
    return json_success(request)


@typed_endpoint_without_parameters
def get_saved_items(request: HttpRequest, user_profile: UserProfile) -> HttpResponse:
    return json_success(request, data=dict(saved_items(user_profile)))


@typed_endpoint
def add_saved_item(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    message_id: Json[int],
    due: Json[int] | None = None,
) -> HttpResponse:
    return json_success(request, data=saved_dict(save_message(user_profile, message_id, due)))


@typed_endpoint
def patch_saved_item(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    message_id: PathOnly[int],
    state: str | None = None,
    due: Json[int] | None = None,
    clear_due: Json[bool] = False,
) -> HttpResponse:
    item = update_saved_item(user_profile, message_id, state=state, due=due, clear_due=clear_due)
    return json_success(request, data=saved_dict(item))


@typed_endpoint
def delete_saved_item(
    request: HttpRequest, user_profile: UserProfile, *, message_id: PathOnly[int]
) -> HttpResponse:
    remove_saved_item(user_profile, message_id)
    return json_success(request)


@human_users_only
@typed_endpoint_without_parameters
def get_notification_pause(request: HttpRequest, user_profile: UserProfile) -> HttpResponse:
    return json_success(
        request,
        data={
            **pause_dict(get_pause(user_profile), user_profile),
            "paused_user_ids": paused_user_ids(user_profile),
        },
    )


@human_users_only
@typed_endpoint
def update_notification_pause(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    until: Json[int | None] = None,
    clear_until: Json[bool] = False,
    schedule: Json[dict[str, object]] | None = None,
    mobile: Json[bool] | None = None,
) -> HttpResponse:
    """``until`` (seconds) pauses until then; ``clear_until`` resumes;
    ``schedule`` replaces the notification schedule; ``mobile`` is the
    settings page's mobile notifications choice."""
    if until is not None and clear_until:
        raise JsonableError(_("Pass either until or clear_until, not both."))
    if until is None and not clear_until and schedule is None and mobile is None:
        raise JsonableError(_("Nothing to change."))
    pause = do_set_notification_pause(
        user_profile,
        until=until,
        set_until=until is not None or clear_until,
        schedule=None if schedule is None else check_schedule(schedule),
        mobile=mobile,
    )
    return json_success(request, data=dict(pause_dict(pause, user_profile)))


@human_users_only
@typed_endpoint_without_parameters
def get_status_expiries(request: HttpRequest, user_profile: UserProfile) -> HttpResponse:
    return json_success(request, data={"expiries": status_expiries(user_profile)})


@human_users_only
@typed_endpoint
def set_status_expiry(
    request: HttpRequest, user_profile: UserProfile, *, clear_at: Json[int | None]
) -> HttpResponse:
    do_set_status_expiry(user_profile, clear_at)
    return json_success(request)
