"use strict";

const assert = require("node:assert/strict");

const {mock_esm, set_global, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const {page_params} = require("./lib/zpage_params.cjs");

const compose_actions = mock_esm("../src/compose_actions");
const compose_state = mock_esm("../src/compose_state");
const message_util = mock_esm("../src/message_util", {
    user_can_send_direct_message: (user_ids_string) => user_ids_string !== "9",
});
const narrow_state = mock_esm("../src/narrow_state", {
    filter: () => ({}),
    narrowed_by_pm_reply: () => false,
    set_compose_defaults: () => ({}),
});
const stream_data = mock_esm("../src/stream_data", {
    get_sub_by_id: (stream_id) => (stream_id === 3 ? {stream_id: 3} : undefined),
    can_post_messages_in_stream: (sub) => sub.stream_id === 3,
});
const ui_util = mock_esm("../src/ui_util", {
    matches_viewport_state: () => true,
});
const ykphone_compose = mock_esm("../src/ykphone_compose", {
    channel_narrow_target: () => ({stream_id: 3, topic: ""}),
    update_recipient_row() {},
});

const ykphone_compose_narrow = zrequire("ykphone_compose_narrow");

function set_focus(active) {
    set_global("document", {
        activeElement: active,
        body: {tag: "body"},
    });
}

// A stand-in for HTMLElement, which the module checks with instanceof.
class HTMLElement {
    constructor() {
        this.focused = 0;
    }

    focus() {
        this.focused += 1;
    }
}
set_global("HTMLElement", HTMLElement);

run_test("auto_open_target", ({override}) => {
    page_params.is_spectator = false;
    assert.equal(ykphone_compose_narrow.auto_open_target(), "stream");

    // Spectators cannot compose; phones keep the collapsed bar.
    page_params.is_spectator = true;
    assert.equal(ykphone_compose_narrow.auto_open_target(), undefined);
    page_params.is_spectator = false;
    override(ui_util, "matches_viewport_state", (state) => {
        assert.equal(state, "gte_md_min");
        return false;
    });
    assert.equal(ykphone_compose_narrow.auto_open_target(), undefined);
    override(ui_util, "matches_viewport_state", () => true);

    // A channel the user may not post to (announcement-only, archived)
    // or does not know keeps upstream's collapsed bar.
    override(ykphone_compose, "channel_narrow_target", () => ({stream_id: 4, topic: ""}));
    assert.equal(ykphone_compose_narrow.auto_open_target(), undefined);
    override(stream_data, "get_sub_by_id", () => ({stream_id: 4}));
    assert.equal(ykphone_compose_narrow.auto_open_target(), undefined);

    // Direct message conversations: valid recipients the user may
    // write to, as upstream checks before opening the box itself.
    override(ykphone_compose, "channel_narrow_target", () => undefined);
    assert.equal(ykphone_compose_narrow.auto_open_target(), undefined);
    override(narrow_state, "narrowed_by_pm_reply", () => true);
    assert.equal(ykphone_compose_narrow.auto_open_target(), undefined);
    override(narrow_state, "set_compose_defaults", () => ({
        private_message_recipient_ids: [8, 7],
    }));
    assert.equal(ykphone_compose_narrow.auto_open_target(), "private");
    override(narrow_state, "set_compose_defaults", () => ({
        private_message_recipient_ids: [9],
    }));
    assert.equal(ykphone_compose_narrow.auto_open_target(), undefined);
    override(narrow_state, "filter", () => undefined);
    assert.equal(ykphone_compose_narrow.auto_open_target(), undefined);
});

run_test("handle_narrow_activated", ({override}) => {
    page_params.is_spectator = false;
    const starts = [];
    override(compose_actions, "start", (opts) => {
        starts.push(opts);
    });
    let blurred = 0;
    override(compose_actions, "blur_compose_inputs", () => {
        blurred += 1;
    });
    let row_updates = 0;
    override(ykphone_compose, "update_recipient_row", () => {
        row_updates += 1;
    });
    let composing = false;
    override(compose_state, "composing", () => composing);
    set_focus(undefined);

    // A sidebar click opens the box for the channel and focuses it.
    ykphone_compose_narrow.handle_narrow_activated({trigger: "sidebar", force_close: false});
    assert.deepEqual(starts, [
        {
            message_type: "stream",
            trigger: "ykphone conversation",
            skip_scrolling_selected_message: true,
            defer_focus: true,
        },
    ]);
    assert.equal(blurred, 0);
    // Once before deciding, once after opening.
    assert.equal(row_updates, 2);

    // Hotkey navigation opens it without taking the keyboard.
    ykphone_compose_narrow.handle_narrow_activated({
        trigger: "next_topic_unread_hotkey",
        force_close: false,
    });
    assert.equal(starts[1].defer_focus, false);
    assert.equal(blurred, 1);
    ykphone_compose_narrow.handle_narrow_activated({trigger: "sidebar", force_close: true});
    assert.equal(starts[2].defer_focus, false);
    assert.equal(blurred, 2);

    // Focus goes back to what had it, when something did.
    const button = new HTMLElement();
    set_focus(button);
    ykphone_compose_narrow.handle_narrow_activated({trigger: "hotkey", force_close: false});
    assert.equal(button.focused, 1);
    assert.equal(blurred, 2);
    // The body counts as nothing.
    set_focus(undefined);
    global.document.activeElement = global.document.body;
    ykphone_compose_narrow.handle_narrow_activated({trigger: "hotkey", force_close: false});
    assert.equal(blurred, 3);

    // A box already open (upstream kept it for a topic hop, or opened a
    // DM) is left alone by a click, but a keyboard hop takes the focus
    // upstream's on_topic_narrow gave it back out of the box.
    composing = true;
    ykphone_compose_narrow.handle_narrow_activated({trigger: "sidebar", force_close: false});
    assert.equal(starts.length, 5);
    assert.equal(blurred, 3);
    ykphone_compose_narrow.handle_narrow_activated({
        trigger: "next_topic_unread_hotkey",
        force_close: false,
    });
    assert.equal(starts.length, 5);
    assert.equal(blurred, 4);
    composing = false;

    // A narrow without a conversation opens nothing; a direct message
    // conversation opens a private box.
    override(ykphone_compose, "channel_narrow_target", () => undefined);
    ykphone_compose_narrow.handle_narrow_activated({trigger: "sidebar", force_close: false});
    assert.equal(starts.length, 5);
    override(narrow_state, "narrowed_by_pm_reply", () => true);
    override(narrow_state, "set_compose_defaults", () => ({
        private_message_recipient_ids: [7],
    }));
    ykphone_compose_narrow.handle_narrow_activated({trigger: "hotkey", force_close: true});
    assert.equal(starts[5].message_type, "private");
    assert.equal(starts[5].defer_focus, false);
});

run_test("reopen after cancel", ({override}) => {
    page_params.is_spectator = false;
    const starts = [];
    override(compose_actions, "start", (opts) => {
        starts.push(opts);
    });
    override(compose_actions, "blur_compose_inputs", () => {});
    override(ykphone_compose, "update_recipient_row", () => {});
    override(ykphone_compose, "channel_narrow_target", () => ({stream_id: 3, topic: ""}));
    let composing = false;
    override(compose_state, "composing", () => composing);
    set_focus(undefined);

    let hook;
    override(compose_actions, "register_compose_cancel_hook", (f) => {
        hook = f;
    });
    const microtasks = [];
    set_global("queueMicrotask", (f) => {
        microtasks.push(f);
    });
    ykphone_compose_narrow.initialize();

    hook();
    assert.equal(starts.length, 0);
    assert.equal(microtasks.length, 1);
    microtasks[0]();
    assert.equal(starts.length, 1);
    assert.equal(starts[0].defer_focus, false);

    // Nothing to do when the box is open again already, or when the
    // narrow no longer has a conversation.
    composing = true;
    ykphone_compose_narrow.reopen_after_cancel();
    composing = false;
    override(ykphone_compose, "channel_narrow_target", () => undefined);
    ykphone_compose_narrow.reopen_after_cancel();
    assert.equal(starts.length, 1);
});
