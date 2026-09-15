"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const ykphone_compose_narrow = mock_esm("../src/ykphone_compose_narrow");
const ykphone_conversation = mock_esm("../src/ykphone_conversation");
const ykphone_pins_ui = mock_esm("../src/ykphone_pins_ui");
const ykphone_rail = mock_esm("../src/ykphone_rail");
const ykphone_thread_panel = mock_esm("../src/ykphone_thread_panel");

const ykphone_ui_hooks = zrequire("ykphone_ui_hooks");

run_test("handle_narrow_activated", ({override}) => {
    const calls = [];
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
    assert.deepEqual(calls, ["panel", "pins", "rail", "conversation", "compose:sidebar"]);
});
