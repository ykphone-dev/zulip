"use strict";

const assert = require("node:assert/strict");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const $ = require("./lib/zjquery.cjs");

const ykphone_keyboard_nav = zrequire("ykphone_keyboard_nav");

run_test("navigation hotkeys reveal the selection", () => {
    const $body = $("body");
    assert.ok(!ykphone_keyboard_nav.is_active());
    assert.ok(!$body.hasClass("ykphone-keyboard-nav"));

    // A hotkey that acts on the selected message without moving it
    // leaves the feed as it is.
    ykphone_keyboard_nav.note_hotkey("reply_message");
    assert.ok(!$body.hasClass("ykphone-keyboard-nav"));

    ykphone_keyboard_nav.note_hotkey("vim_down");
    assert.ok(ykphone_keyboard_nav.is_active());
    assert.ok($body.hasClass("ykphone-keyboard-nav"));

    // Further hotkeys while it is already shown are a no-op.
    ykphone_keyboard_nav.note_hotkey("up_arrow");
    assert.ok($body.hasClass("ykphone-keyboard-nav"));

    // The pointer takes over again.
    ykphone_keyboard_nav.clear();
    assert.ok(!ykphone_keyboard_nav.is_active());
    assert.ok(!$body.hasClass("ykphone-keyboard-nav"));
    ykphone_keyboard_nav.clear();
    assert.ok(!$body.hasClass("ykphone-keyboard-nav"));
});

run_test("is_navigation_hotkey", () => {
    for (const name of ["up_arrow", "down_arrow", "vim_up", "vim_down", "home", "end", "G_end"]) {
        assert.ok(ykphone_keyboard_nav.is_navigation_hotkey(name));
    }
    for (const name of ["reply_message", "toggle_star", "compose", "search"]) {
        assert.ok(!ykphone_keyboard_nav.is_navigation_hotkey(name));
    }
});
