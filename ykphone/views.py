from django.http import HttpRequest, HttpResponse
from pydantic import Json

from ykphone.lib.pins import pin_dict, pin_message, pins_for_stream, unpin_message
from ykphone.lib.threads import (
    get_or_create_thread,
    thread_activity,
    thread_dict,
    threads_for_stream,
    unthreaded_participated_topics,
)
from zerver.lib.response import json_success
from zerver.lib.streams import access_stream_by_id
from zerver.lib.typed_endpoint import PathOnly, typed_endpoint
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
