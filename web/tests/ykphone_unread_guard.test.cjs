"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

// Rows by message id, with the viewport's visible band at 100–700.
const row_tops = new Map();
const message_lists = mock_esm("../src/message_lists", {
    current: {
        get_row(message_id) {
            const top = row_tops.get(message_id);
            return top === undefined
                ? []
                : [{getBoundingClientRect: () => ({top, bottom: top + 40})}];
        },
    },
});
mock_esm("../src/message_viewport", {
    message_viewport_info: () => ({visible_top: 100, visible_bottom: 700}),
});

const ykphone_unread_guard = zrequire("ykphone_unread_guard");

function messages(...ids) {
    return ids.map(([id, unread]) => ({id, unread}));
}

run_test("unseen unread messages are held until they are on screen", () => {
    ykphone_unread_guard.clear();
    // 1 is read; 2 is unread and above the screen; 3 is unread and on
    // screen; 4 is unread below the compose box; 5 has no rendered row.
    row_tops.clear();
    row_tops.set(1, -500);
    row_tops.set(2, -300);
    row_tops.set(3, 300);
    row_tops.set(4, 900);
    const all = messages([1, false], [2, true], [3, true], [4, true], [5, true]);

    assert.equal(ykphone_unread_guard.readable(all), all);
    ykphone_unread_guard.hold_unseen(all);
    assert.deepEqual(
        ykphone_unread_guard.readable(all).map((message) => message.id),
        [1, 3],
    );

    // The feed moves: 4 comes into view (its bottom edge just inside the
    // band), 2 is still above it.
    row_tops.set(4, 670);
    ykphone_unread_guard.release_visible();
    assert.deepEqual(
        ykphone_unread_guard.readable(all).map((message) => message.id),
        [1, 3, 4],
    );

    // A row whose top is exactly at the compose box is not on screen,
    // nor one whose bottom is exactly at the header.
    row_tops.set(2, 700);
    row_tops.set(5, 60);
    ykphone_unread_guard.release_visible();
    assert.deepEqual(
        ykphone_unread_guard.readable(all).map((message) => message.id),
        [1, 3, 4],
    );

    // Another conversation holds nothing over.
    ykphone_unread_guard.clear();
    assert.equal(ykphone_unread_guard.readable(all), all);
});

run_test("no current list", ({override}) => {
    override(message_lists, "current", undefined);
    assert.equal(ykphone_unread_guard.is_on_screen(1), false);
});
