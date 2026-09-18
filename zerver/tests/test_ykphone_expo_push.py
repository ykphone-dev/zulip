from datetime import timedelta
from typing import Any
from unittest import mock

import orjson
import responses
from django.utils.timezone import now as timezone_now

from ykphone.lib.expo_push import EXPO_PUSH_URL, expo_push_event, send_expo_push
from ykphone.models import ExpoPushToken, NotificationPause
from zerver.lib.message_cache import MessageDict
from zerver.lib.test_classes import ZulipTestCase
from zerver.models import Message, UserProfile

HAMLET_TOKEN = "ExponentPushToken[hamlet-aaaa]"
CORDELIA_TOKEN = "ExponentPushToken[cordelia-bbbb]"


def expo_ok(count: int) -> dict[str, Any]:
    return {"data": [{"status": "ok", "id": f"ticket-{i}"} for i in range(count)]}


class ExpoPushTokenEndpointTest(ZulipTestCase):
    def test_register_and_remove(self) -> None:
        self.login("hamlet")
        result = self.client_post("/json/ykphone/expo_push_token", {"token": HAMLET_TOKEN})
        self.assert_json_success(result)
        hamlet = self.example_user("hamlet")
        self.assertEqual(
            list(ExpoPushToken.objects.filter(user=hamlet).values_list("token", flat=True)),
            [HAMLET_TOKEN],
        )

        # Registering again is idempotent.
        self.assert_json_success(
            self.client_post("/json/ykphone/expo_push_token", {"token": HAMLET_TOKEN})
        )
        self.assertEqual(ExpoPushToken.objects.filter(token=HAMLET_TOKEN).count(), 1)

        result = self.client_delete("/json/ykphone/expo_push_token", {"token": HAMLET_TOKEN})
        self.assert_json_success(result)
        self.assertFalse(ExpoPushToken.objects.filter(token=HAMLET_TOKEN).exists())

    def test_invalid_token(self) -> None:
        self.login("hamlet")
        result = self.client_post("/json/ykphone/expo_push_token", {"token": "not-a-token"})
        self.assert_json_error(result, "Invalid Expo push token.")
        self.assertFalse(ExpoPushToken.objects.exists())

    def test_token_moves_to_new_user(self) -> None:
        ExpoPushToken.objects.create(user=self.example_user("cordelia"), token=HAMLET_TOKEN)
        self.login("hamlet")
        self.assert_json_success(
            self.client_post("/json/ykphone/expo_push_token", {"token": HAMLET_TOKEN})
        )
        token = ExpoPushToken.objects.get(token=HAMLET_TOKEN)
        self.assertEqual(token.user, self.example_user("hamlet"))

    def test_remove_leaves_other_users_token(self) -> None:
        ExpoPushToken.objects.create(user=self.example_user("cordelia"), token=CORDELIA_TOKEN)
        self.login("hamlet")
        self.assert_json_success(
            self.client_delete("/json/ykphone/expo_push_token", {"token": CORDELIA_TOKEN})
        )
        self.assertTrue(ExpoPushToken.objects.filter(token=CORDELIA_TOKEN).exists())


class ExpoPushEventTest(ZulipTestCase):
    def message_dict(self, message_id: int) -> dict[str, Any]:
        message = Message.objects.get(id=message_id)
        return MessageDict.wide_dict(message, message.realm_id)

    def test_stream_message(self) -> None:
        iago = self.example_user("iago")
        message_id = self.send_stream_message(iago, "Denmark", "secret content", "plans")
        realm = iago.realm
        hamlet = self.example_user("hamlet")
        event = expo_push_event(realm, self.message_dict(message_id), {iago.id, hamlet.id}, iago.id)
        assert event is not None
        self.assertEqual(event["user_ids"], [hamlet.id])
        self.assertEqual(event["title"], iago.full_name)
        self.assertEqual(event["body"], "#Denmark에 새 메시지")
        self.assertNotIn("secret content", orjson.dumps(event).decode())
        self.assertTrue(event["url"].startswith(f"{realm.url}/#narrow/channel/"))
        self.assertTrue(event["url"].endswith(f"/with/{message_id}"))

    def test_direct_messages(self) -> None:
        iago = self.example_user("iago")
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        message_id = self.send_personal_message(iago, hamlet, "secret")
        event = expo_push_event(
            iago.realm, self.message_dict(message_id), {iago.id, hamlet.id}, iago.id
        )
        assert event is not None
        self.assertEqual(event["body"], "새 메시지")
        self.assertIn("/#narrow/dm/", event["url"])

        message_id = self.send_group_direct_message(iago, [hamlet, cordelia], "secret")
        event = expo_push_event(
            iago.realm,
            self.message_dict(message_id),
            {iago.id, hamlet.id, cordelia.id},
            iago.id,
        )
        assert event is not None
        self.assertEqual(event["body"], "그룹 메시지")
        self.assertEqual(event["user_ids"], sorted([hamlet.id, cordelia.id]))

    def test_nobody_but_sender(self) -> None:
        iago = self.example_user("iago")
        message_id = self.send_personal_message(iago, iago, "note to self")
        self.assertIsNone(
            expo_push_event(iago.realm, self.message_dict(message_id), {iago.id}, iago.id)
        )

    def test_queued_on_send(self) -> None:
        iago = self.example_user("iago")
        hamlet = self.example_user("hamlet")
        with mock.patch("zerver.actions.message_send.queue_event_on_commit") as queue:
            self.send_personal_message(iago, hamlet, "hello")
        events = [call.args[1] for call in queue.call_args_list if call.args[0] == "deferred_work"]
        self.assert_length(events, 1)
        self.assertEqual(events[0]["type"], "ykphone_expo_push")
        self.assertEqual(events[0]["user_ids"], [hamlet.id])


class SendExpoPushTest(ZulipTestCase):
    def event(self, *user_ids: int) -> dict[str, Any]:
        return {
            "type": "ykphone_expo_push",
            "user_ids": list(user_ids),
            "message_id": 17,
            "title": "Iago",
            "body": "새 메시지",
            "url": "http://zulip.testserver/#narrow/dm/1-iago/with/17",
        }

    def register_tokens(self) -> tuple[int, int]:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        ExpoPushToken.objects.create(user=hamlet, token=HAMLET_TOKEN)
        ExpoPushToken.objects.create(user=cordelia, token=CORDELIA_TOKEN)
        return hamlet.id, cordelia.id

    @responses.activate
    def test_sends_to_every_token(self) -> None:
        hamlet_id, cordelia_id = self.register_tokens()
        responses.add(responses.POST, EXPO_PUSH_URL, json=expo_ok(2))
        send_expo_push(self.event(hamlet_id, cordelia_id))

        self.assert_length(responses.calls, 1)
        body = orjson.loads(responses.calls[0].request.body)
        self.assertEqual({message["to"] for message in body}, {HAMLET_TOKEN, CORDELIA_TOKEN})
        self.assertEqual(body[0]["title"], "Iago")
        self.assertEqual(body[0]["body"], "새 메시지")
        self.assertEqual(body[0]["data"]["message_id"], 17)

    @responses.activate
    def test_no_tokens_no_request(self) -> None:
        send_expo_push(self.event(self.example_user("hamlet").id))
        self.assert_length(responses.calls, 0)

    @responses.activate
    def test_paused_and_mobile_off_skipped(self) -> None:
        hamlet_id, cordelia_id = self.register_tokens()
        NotificationPause.objects.create(
            user_id=hamlet_id, paused_until=timezone_now() + timedelta(minutes=30)
        )
        NotificationPause.objects.create(user_id=cordelia_id, mobile_notifications=False)
        with self.assertLogs(level="INFO"):
            send_expo_push(self.event(hamlet_id, cordelia_id))
        self.assert_length(responses.calls, 0)

    @responses.activate
    def test_deactivated_skipped(self) -> None:
        hamlet_id, cordelia_id = self.register_tokens()
        UserProfile.objects.filter(id=cordelia_id).update(is_active=False)
        responses.add(responses.POST, EXPO_PUSH_URL, json=expo_ok(1))
        send_expo_push(self.event(hamlet_id, cordelia_id))
        body = orjson.loads(responses.calls[0].request.body)
        self.assertEqual([message["to"] for message in body], [HAMLET_TOKEN])

    @responses.activate
    def test_unregistered_token_dropped(self) -> None:
        hamlet_id, _ = self.register_tokens()
        responses.add(
            responses.POST,
            EXPO_PUSH_URL,
            json={
                "data": [
                    {
                        "status": "error",
                        "message": "not registered",
                        "details": {"error": "DeviceNotRegistered"},
                    }
                ]
            },
        )
        with self.assertLogs("ykphone.lib.expo_push", level="INFO"):
            send_expo_push(self.event(hamlet_id))
        self.assertFalse(ExpoPushToken.objects.filter(token=HAMLET_TOKEN).exists())
        self.assertTrue(ExpoPushToken.objects.filter(token=CORDELIA_TOKEN).exists())

    @responses.activate
    def test_expo_failure_logged(self) -> None:
        hamlet_id, _ = self.register_tokens()
        responses.add(responses.POST, EXPO_PUSH_URL, status=503)
        with self.assertLogs("ykphone.lib.expo_push", level="ERROR") as logs:
            send_expo_push(self.event(hamlet_id))
        self.assertIn("expo push failed for message 17", logs.output[0])
        self.assertTrue(ExpoPushToken.objects.filter(token=HAMLET_TOKEN).exists())
