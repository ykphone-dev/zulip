"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const ykphone_compose_narrow = mock_esm("../src/ykphone_compose_narrow");
const ykphone_conversation = mock_esm("../src/ykphone_conversation");
const ykphone_pins_ui = mock_esm("../src/ykphone_pins_ui");
const narrow_state = mock_esm("../src/narrow_state");
const ykphone_rail = mock_esm("../src/ykphone_rail");
const ykphone_quick_switcher = mock_esm("../src/ykphone_quick_switcher");
const ykphone_recents = mock_esm("../src/ykphone_recents");
const ykphone_thread_panel = mock_esm("../src/ykphone_thread_panel");
const ykphone_unread_guard = mock_esm("../src/ykphone_unread_guard");

const ykphone_ui_hooks = zrequire("ykphone_ui_hooks");

run_test("handle_narrow_activated", ({override}) => {
    const calls = [];
    override(ykphone_unread_guard, "clear", () => {
        calls.push("unread-guard");
    });
    const filter = {};
    override(narrow_state, "filter", () => filter);
    override(ykphone_recents, "note_narrow", (narrow_filter) => {
        assert.equal(narrow_filter, filter);
        calls.push("recents");
    });
    override(ykphone_quick_switcher, "invalidate", () => {
        calls.push("switcher");
    });
    override(ykphone_thread_panel, "handle_narrow_activated", () => {
        calls.push("panel");
    });
    override(ykphone_pins_ui, "handle_narrow_activated", () => {
        calls.push("pins");
    });
    override(ykphone_rail, "handle_narrow_activated", () => {
        calls.push("rail");
    });
    override(ykphone_conversation, "handle_narrow_activated", () => {
        calls.push("conversation");
    });
    override(ykphone_compose_narrow, "handle_narrow_activated", (opts) => {
        calls.push(`compose:${opts.trigger}`);
    });

    ykphone_ui_hooks.handle_narrow_activated({trigger: "sidebar"});
    assert.deepEqual(calls, [
        "unread-guard",
        "recents",
        "switcher",
        "panel",
        "pins",
        "rail",
        "conversation",
        "compose:sidebar",
    ]);
});
