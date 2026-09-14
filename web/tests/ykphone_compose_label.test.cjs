"use strict";

const assert = require("node:assert/strict");

const {make_realm} = require("./lib/example_realm.cjs");
const {make_stream} = require("./lib/example_stream.cjs");
const {mock_esm, set_global, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

set_global("document", "document-stub");
mock_esm("../src/recent_view_util", {
    is_visible: () => true,
});

const compose_closed_ui = zrequire("compose_closed_ui");
const stream_data = zrequire("stream_data");
const {set_realm} = zrequire("state_data");
const ykphone_flags = zrequire("ykphone_flags");

set_realm(make_realm({realm_empty_topic_display_name: "general chat"}));

const verona = make_stream({stream_id: 3, name: "Verona"});
stream_data.add_sub_for_tests(verona);

// The collapsed compose bar labels the reply target of the focused
// row in the inbox and Threads views; with channels opening in
// general chat, that topic is the channel itself and the label drops
// the topic part.
run_test("general chat label", () => {
    ykphone_flags.set_channels_open_in_general_chat(false);
    assert.deepEqual(compose_closed_ui.get_recipient_label({stream_id: 3, topic: ""}), {
        label_text: "#Verona > translated: general chat",
        has_empty_string_topic: true,
        stream_name: "Verona",
    });

    ykphone_flags.set_channels_open_in_general_chat(true);
    assert.deepEqual(compose_closed_ui.get_recipient_label({stream_id: 3, topic: ""}), {
        label_text: "#Verona",
        has_empty_string_topic: false,
        stream_name: "Verona",
    });
    // Named topics (threads) keep the full label.
    assert.deepEqual(compose_closed_ui.get_recipient_label({stream_id: 3, topic: "Friday"}), {
        label_text: "#Verona > Friday",
        has_empty_string_topic: false,
        stream_name: "Verona",
    });
    ykphone_flags.set_channels_open_in_general_chat(false);
});
