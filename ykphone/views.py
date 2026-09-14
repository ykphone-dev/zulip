from django.http import HttpRequest, HttpResponse
from pydantic import Json

from ykphone.lib.threads import get_or_create_thread, thread_dict, threads_for_stream
from zerver.lib.response import json_success
from zerver.lib.typed_endpoint import typed_endpoint
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
    return json_success(request, data={"threads": threads_for_stream(user_profile, stream_id)})
