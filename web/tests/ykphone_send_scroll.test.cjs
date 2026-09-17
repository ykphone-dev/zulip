"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const calls = [];
let scroll_top = 1000;
let row_bottom = 2000;
const list = {
    all_messages: () => [{id: 1, unread: true}],
    get_row: (message_id) =>
        message_id === 7 ? [{getBoundingClientRect: () => ({bottom: row_bottom})}] : [],
    select_id(message_id, opts) {
        calls.push(["select", message_id, opts]);
    },
};
const message_lists = mock_esm("../src/message_lists", {current: list});
mock_esm("../src/message_scroll_state", {
    set_update_selection_on_next_scroll(value) {
        calls.push(["update_selection", value]);
    },
});
mock_esm("../src/message_viewport", {
    message_viewport_info: () => ({visible_top: 100, visible_bottom: 763}),
    scrollTop(target) {
        if (target === undefined) {
            return scroll_top;
        }
        // The browser clamps to the end of the document.
        scroll_top = Math.min(target, 1500);
        return undefined;
    },
});
mock_esm("../src/narrow_state", {filter: () => "filter"});
const ykphone_conversation = mock_esm("../src/ykphone_conversation", {
    is_conversation: () => true,
});
mock_esm("../src/ykphone_unread_guard", {
    hold_unseen(messages) {
        calls.push(["hold", messages.map((message) => message.id)]);
    },
});

const ykphone_send_scroll = zrequire("ykphone_send_scroll");

run_test("scrolls a conversation to the sent message", () => {
    calls.length = 0;
    assert.ok(ykphone_send_scroll.scroll_to_sent_message(7));
    // The unseen unreads are held first, the pointer moves without
    // marking anything read, and the row's bottom lands on the compose
    // box's top (clamped by the document end here).
    assert.deepEqual(calls, [
        ["hold", [1]],
        ["select", 7, {mark_read: false}],
        ["update_selection", false],
    ]);
    assert.equal(scroll_top, 1500);

    // Already in place: no scroll happens, so the next real scroll must
    // still update the selection as usual.
    calls.length = 0;
    row_bottom = 763;
    assert.ok(ykphone_send_scroll.scroll_to_sent_message(7));
    assert.deepEqual(
        calls.map((call) => call[0]),
        ["hold", "select"],
    );
});

run_test("declines outside a conversation and without a row", ({override}) => {
    calls.length = 0;
    // No rendered row for the message (for example, not in this list).
    assert.equal(ykphone_send_scroll.scroll_to_sent_message(8), false);

    override(ykphone_conversation, "is_conversation", () => false);
    assert.equal(ykphone_send_scroll.scroll_to_sent_message(7), false);

    override(message_lists, "current", undefined);
    assert.equal(ykphone_send_scroll.scroll_to_sent_message(7), false);
    assert.deepEqual(calls, []);
});
