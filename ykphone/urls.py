from django.urls import include, path
from django.urls.resolvers import URLPattern, URLResolver

from ykphone.views import add_pin, create_thread, get_pins, get_threads, remove_pin
from zerver.lib.rest import rest_path

# Kept off the upstream v1 pattern lists so the OpenAPI documentation
# checks, which only know about Zulip's own endpoints, leave these alone.
v1_api_and_json_patterns = [
    rest_path("ykphone/threads", GET=get_threads, POST=create_thread),
    rest_path("ykphone/pins", GET=get_pins, POST=add_pin),
    rest_path("ykphone/pins/<int:message_id>", DELETE=remove_pin),
]

i18n_urlpatterns: list[URLPattern | URLResolver] = []

urlpatterns = [
    path("api/v1/", include(v1_api_and_json_patterns)),
    path("json/", include(v1_api_and_json_patterns)),
]
