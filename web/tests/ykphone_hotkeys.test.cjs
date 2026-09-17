"use strict";

const assert = require("node:assert/strict");

const {mock_esm, set_global, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const {page_params} = require("./lib/zpage_params.cjs");

let sidebar_stream_ids = [];
let unread_channels = new Set();
let dm_conversations = [];
let current_filter;
let focus = "none";
let empty_compose = true;
let layers = {};
const visited = [];
const closed = [];

mock_esm("../src/browser_history", {
    go_to_location(hash) {
        visited.push(hash);
    },
});
mock_esm("../src/compose_state", {
    composing: () => true,
    focus_in_empty_compose: () => empty_compose,
});
mock_esm("../src/emoji_picker", {is_open: () => layers.emoji_picker === true});
const message_edit = mock_esm("../src/message_edit");
const message_lists = mock_esm("../src/message_lists", {current: undefined});
mock_esm("../src/modals", {
    any_active_or_animating: () => layers.modal === true,
});
mock_esm("../src/narrow_state", {filter: () => current_filter});
mock_esm("../src/overlays", {any_active: () => layers.overlay === true});
mock_esm("../src/pm_list_data", {get_conversations: () => dm_conversations});
mock_esm("../src/popover_menus", {
    get_visible_instance: () => (layers.popover_menu === true ? {} : undefined),
    is_gear_menu_popover_displayed: () => layers.gear_menu === true,
});
mock_esm("../src/popovers", {
    any_active: () => layers.popover === true,
    hide_all() {
        closed.push("popovers");
    },
});
mock_esm("../src/sidebar_ui", {
    any_sidebar_expanded_as_overlay: () => layers.sidebar === true,
});
mock_esm("../src/stream_list", {is_zoomed_in: () => layers.zoomed === true});
mock_esm("../src/stream_list_sort", {get_stream_ids: () => sidebar_stream_ids});
const unread = mock_esm("../src/unread", {
    num_unread_for_topic: () => 0,
    num_unread_for_user_ids_string: () => 0,
});
const unread_ops = mock_esm("../src/unread_ops");
const ykphone_compose = mock_esm("../src/ykphone_compose", {
    composer_belongs_to_narrow: () => layers.foreign_compose !== true,
    handle_dismiss() {
        closed.push("compose");
        return true;
    },
});
const opened_details = [];
mock_esm("../src/ykphone_channel_details_ui", {
    open(stream_id, tab) {
        opened_details.push({stream_id, tab});
    },
});
mock_esm("../src/ykphone_keyboard_nav", {
    is_active: () => layers.keyboard_nav === true,
});
mock_esm("../src/ykphone_pins", {
    get_panel_stream_id: () => (layers.pins === true ? 3 : undefined),
});

function key(place) {
    return place === undefined ? undefined : JSON.stringify(place);
}

mock_esm("../src/ykphone_places", {
    channel_place: (stream_id) => ({kind: "channel", stream_id}),
    dm_place: (user_ids) => ({kind: "dm", user_ids}),
    place_key: key,
    place_for_filter: (filter) => filter.place,
    describe: (place) =>
        place.kind === "dm" && place.user_ids.includes(42)
            ? undefined
            : {hash: `#to/${key(place)}`},
});
const quick_switcher_ui = mock_esm("../src/ykphone_quick_switcher_ui", {
    is_open: () => layers.switcher === true,
});
mock_esm("../src/ykphone_rich_hooks", {
    has_focus: () => focus === "compose",
    editor_has_focus: () => focus === "compose" || focus === "other-editor",
});
mock_esm("../src/ykphone_split_view", {page_hash: (page) => `#ykphone/${page}`});
const ykphone_thread_panel = mock_esm("../src/ykphone_thread_panel", {
    is_open: () => layers.thread_panel === true,
    close() {
        closed.push("thread panel");
        return true;
    },
});
mock_esm("../src/ykphone_unread_badges", {
    channel_has_unread_general_chat: (stream_id) => unread_channels.has(stream_id),
});

// The focus, as the module reads it off the document.
set_global("document", {
    get activeElement() {
        if (focus === "none") {
            return null;
        }
        return {
            matches: (selector) =>
                focus === "input" && selector.includes("input") ? true : focus === "select-field",
            closest(selector) {
                if (selector.includes("ykphone-thread-panel")) {
                    return focus === "thread-panel" ? {} : null;
                }
                return focus === "pill" ? {} : null;
            },
        };
    },
});

const ykphone_flags = zrequire("ykphone_flags");
const ykphone_hotkeys = zrequire("ykphone_hotkeys");

const key_event = {shiftKey: false};
const escape_event = {key: "Escape", originalEvent: {}};

function reset() {
    ykphone_flags.set_channels_open_in_general_chat(true);
    page_params.is_spectator = false;
    sidebar_stream_ids = [];
    unread_channels = new Set();
    dm_conversations = [];
    current_filter = undefined;
    focus = "none";
    empty_compose = true;
    layers = {};
    visited.length = 0;
    closed.length = 0;
    opened_details.length = 0;
}

run_test("key combinations", () => {
    reset();
    // macOS and the other systems.
    for (const modifier of ["Cmd", "Ctrl"]) {
        assert.equal(
            ykphone_hotkeys.keydown_hotkey(`${modifier}+Shift+K`).name,
            "ykphone_open_dms",
        );
        assert.equal(
            ykphone_hotkeys.keydown_hotkey(`${modifier}+Shift+M`).name,
            "ykphone_open_activity",
        );
        assert.equal(
            ykphone_hotkeys.keydown_hotkey(`${modifier}+Shift+T`).name,
            "ykphone_open_threads",
        );
    }
    assert.equal(
        ykphone_hotkeys.keydown_hotkey("Alt+Shift+ArrowDown").name,
        "ykphone_next_unread_conversation",
    );
    assert.equal(
        ykphone_hotkeys.keydown_hotkey("Alt+Shift+ArrowUp").name,
        "ykphone_previous_unread_conversation",
    );
    assert.equal(ykphone_hotkeys.keydown_hotkey("Ctrl+Shift+Z"), undefined);

    // Without the fork's layout, and for spectators, the keys stay
    // unmapped, as upstream has them.
    ykphone_flags.set_channels_open_in_general_chat(false);
    assert.equal(ykphone_hotkeys.keydown_hotkey("Ctrl+Shift+K"), undefined);
    ykphone_flags.set_channels_open_in_general_chat(true);
    page_params.is_spectator = true;
    assert.equal(ykphone_hotkeys.keydown_hotkey("Ctrl+Shift+K"), undefined);
    assert.equal(ykphone_hotkeys.process_hotkey(key_event, "ykphone_open_dms"), false);
    assert.equal(ykphone_hotkeys.process_hotkey(key_event, "search_with_k"), false);
    page_params.is_spectator = false;
});

run_test("pages, sequences and the quick switcher", ({override}) => {
    reset();
    for (const [name, hash] of [
        ["ykphone_open_dms", "#ykphone/dms"],
        ["ykphone_open_activity", "#ykphone/activity"],
        ["ykphone_open_threads", "#ykphone/threads"],
    ]) {
        assert.ok(ykphone_hotkeys.process_hotkey(key_event, name));
        assert.equal(visited.at(-1), hash);
    }
    assert.ok(!ykphone_hotkeys.process_hotkey(key_event, "compose"));

    // G opens upstream's gear menu; D, A and T while it is open are the
    // fork's sequences for the same three pages, for the browsers that
    // keep ⌘⇧K / ⌘⇧M / ⌘⇧T for themselves.
    assert.ok(!ykphone_hotkeys.process_hotkey(key_event, "open_drafts"));
    layers.gear_menu = true;
    for (const [name, hash] of [
        ["open_drafts", "#ykphone/dms"],
        ["open_combined_feed", "#ykphone/activity"],
        ["open_recent_view", "#ykphone/threads"],
    ]) {
        assert.ok(ykphone_hotkeys.process_hotkey(key_event, name));
        assert.equal(visited.at(-1), hash);
        assert.equal(closed.at(-1), "popovers");
    }
    assert.ok(!ykphone_hotkeys.process_hotkey(key_event, "open_starred_message_view"));
    // Not over a dialog, even one still opening.
    layers.modal = true;
    assert.ok(!ykphone_hotkeys.process_hotkey(key_event, "open_drafts"));
    layers.modal = false;
    layers.gear_menu = false;

    let opened = 0;
    let switcher_closed = 0;
    override(quick_switcher_ui, "open", () => {
        opened += 1;
    });
    override(quick_switcher_ui, "close", () => {
        switcher_closed += 1;
    });
    assert.ok(ykphone_hotkeys.process_hotkey(key_event, "search_with_k"));
    assert.equal(opened, 1);
    // The same keys close it again.
    layers.switcher = true;
    assert.ok(ykphone_hotkeys.process_hotkey(key_event, "search_with_k"));
    assert.equal(switcher_closed, 1);
    layers.switcher = false;

    // A dialog, even one still opening, keeps the keys.
    layers.modal = true;
    assert.ok(!ykphone_hotkeys.process_hotkey(key_event, "search_with_k"));
    assert.ok(!ykphone_hotkeys.process_hotkey(key_event, "ykphone_open_dms"));
    layers.modal = false;

    ykphone_flags.set_channels_open_in_general_chat(false);
    assert.ok(!ykphone_hotkeys.process_hotkey(key_event, "search_with_k"));
    assert.equal(opened, 1);
});

run_test("adjacent_unread_place", () => {
    reset();
    sidebar_stream_ids = [1, 2, 3];
    dm_conversations = [
        {user_ids_string: "7", unread: 0},
        {user_ids_string: "8,9", unread: 2},
    ];
    unread_channels = new Set([1, 3]);
    const channel = (stream_id) => ({kind: "channel", stream_id});
    const group = {kind: "dm", user_ids: [8, 9]};

    // From a place outside the sidebar: the first, or going up, the last.
    assert.deepEqual(ykphone_hotkeys.adjacent_unread_place(1, undefined), channel(1));
    assert.deepEqual(
        ykphone_hotkeys.adjacent_unread_place(-1, {kind: "page", page: "files"}),
        group,
    );
    // From a channel, round the end of the list in both directions.
    assert.deepEqual(ykphone_hotkeys.adjacent_unread_place(1, channel(1)), channel(3));
    assert.deepEqual(ykphone_hotkeys.adjacent_unread_place(1, channel(3)), group);
    assert.deepEqual(ykphone_hotkeys.adjacent_unread_place(1, group), channel(1));
    assert.deepEqual(ykphone_hotkeys.adjacent_unread_place(-1, channel(1)), group);
    assert.deepEqual(ykphone_hotkeys.adjacent_unread_place(-1, channel(2)), channel(1));
    // A thread stands at its channel.
    assert.deepEqual(
        ykphone_hotkeys.adjacent_unread_place(1, {kind: "thread", stream_id: 2, topic: "x"}),
        channel(3),
    );
    // The only unread conversation is the one on screen: nowhere to go.
    unread_channels = new Set([2]);
    dm_conversations = [];
    assert.equal(ykphone_hotkeys.adjacent_unread_place(1, channel(2)), undefined);
});

run_test("unread conversation hotkeys", () => {
    reset();
    sidebar_stream_ids = [1, 2];
    unread_channels = new Set([2]);
    current_filter = {place: {kind: "channel", stream_id: 1}};
    focus = "compose";

    // ⌥⇧↓/↑ is "select to the end of the paragraph" in a text field on
    // macOS: it navigates from the feed or from an empty compose box
    // only, and never from another view or over a dialog.
    assert.ok(ykphone_hotkeys.process_hotkey(key_event, "ykphone_next_unread_conversation"));
    assert.deepEqual(visited, [`#to/${key({kind: "channel", stream_id: 2})}`]);
    focus = "none";
    assert.ok(ykphone_hotkeys.process_hotkey(key_event, "ykphone_previous_unread_conversation"));
    assert.equal(visited.length, 2);

    // Typing in the box, or the cursor in any other text field.
    focus = "compose";
    empty_compose = false;
    assert.equal(
        ykphone_hotkeys.process_hotkey(key_event, "ykphone_next_unread_conversation"),
        false,
    );
    empty_compose = true;
    for (const value of ["other-editor", "input", "pill"]) {
        focus = value;
        assert.equal(
            ykphone_hotkeys.process_hotkey(key_event, "ykphone_next_unread_conversation"),
            false,
            value,
        );
    }
    focus = "none";
    for (const layer of ["overlay", "modal", "popover", "popover_menu", "switcher", "sidebar"]) {
        layers[layer] = true;
        assert.equal(
            ykphone_hotkeys.process_hotkey(key_event, "ykphone_next_unread_conversation"),
            false,
            layer,
        );
        layers[layer] = false;
    }
    // Not from a page or a search either.
    current_filter = {place: {kind: "page", page: "files"}};
    assert.equal(
        ykphone_hotkeys.process_hotkey(key_event, "ykphone_next_unread_conversation"),
        false,
    );
    current_filter = undefined;
    assert.equal(
        ykphone_hotkeys.process_hotkey(key_event, "ykphone_next_unread_conversation"),
        false,
    );
    assert.equal(visited.length, 2);

    // Nothing unread, or a conversation that cannot be opened: the keys
    // are used up, and nothing happens.
    current_filter = {place: {kind: "channel", stream_id: 1}};
    unread_channels = new Set();
    assert.ok(ykphone_hotkeys.process_hotkey(key_event, "ykphone_next_unread_conversation"));
    dm_conversations = [{user_ids_string: "42", unread: 1}];
    assert.ok(ykphone_hotkeys.process_hotkey(key_event, "ykphone_next_unread_conversation"));
    assert.equal(visited.length, 2);
});

run_test("i opens the channel details", () => {
    reset();
    // In a channel or one of its threads, with no message selected.
    current_filter = {place: {kind: "channel", stream_id: 7}};
    assert.equal(ykphone_hotkeys.process_hotkey(key_event, "message_actions"), true);
    current_filter = {place: {kind: "thread", stream_id: 8, topic: "plans"}};
    assert.equal(ykphone_hotkeys.process_hotkey(key_event, "message_actions"), true);
    assert.deepEqual(opened_details, [
        {stream_id: 7, tab: "info"},
        {stream_id: 8, tab: "info"},
    ]);

    // While the user is moving through the feed with the keyboard the
    // key keeps upstream's meaning (the selected message's menu), and
    // so it does in a direct message conversation, on a page, behind a
    // menu, and while a text field has the keyboard.
    reset();
    current_filter = {place: {kind: "channel", stream_id: 7}};
    layers.keyboard_nav = true;
    assert.equal(ykphone_hotkeys.process_hotkey(key_event, "message_actions"), false);
    reset();
    current_filter = {place: {kind: "dm", user_ids: [12]}};
    assert.equal(ykphone_hotkeys.process_hotkey(key_event, "message_actions"), false);
    current_filter = {place: {kind: "page", page: "dms"}};
    assert.equal(ykphone_hotkeys.process_hotkey(key_event, "message_actions"), false);
    current_filter = {place: {kind: "channel", stream_id: 7}};
    layers.popover = true;
    assert.equal(ykphone_hotkeys.process_hotkey(key_event, "message_actions"), false);
    layers.popover = false;
    focus = "input";
    assert.equal(ykphone_hotkeys.process_hotkey(key_event, "message_actions"), false);
    assert.deepEqual(opened_details, []);
});

run_test("up arrow edits the last message", ({override}) => {
    reset();
    focus = "compose";
    let edits = 0;
    override(message_edit, "edit_last_sent_message", () => {
        edits += 1;
    });
    let editable = true;
    override(message_edit, "is_content_editable", (message, buffer) => {
        assert.equal(message.id, 11);
        assert.equal(buffer, 5);
        return editable;
    });
    let last_message = {id: 11};
    message_lists.current = {get_last_message_sent_by_me: () => last_message};
    current_filter = {is_conversation_view: () => true};

    assert.ok(ykphone_hotkeys.process_hotkey(key_event, "up_arrow"));
    assert.equal(edits, 1);

    // Everything else keeps upstream's meaning of the key.
    assert.ok(!ykphone_hotkeys.process_hotkey({shiftKey: true}, "up_arrow"));
    editable = false;
    assert.ok(!ykphone_hotkeys.process_hotkey(key_event, "up_arrow"));
    editable = true;
    current_filter = {is_conversation_view: () => false};
    assert.ok(!ykphone_hotkeys.process_hotkey(key_event, "up_arrow"));
    current_filter = undefined;
    assert.ok(!ykphone_hotkeys.process_hotkey(key_event, "up_arrow"));
    current_filter = {is_conversation_view: () => true};
    last_message = undefined;
    assert.ok(!ykphone_hotkeys.process_hotkey(key_event, "up_arrow"));
    last_message = {id: 11};
    message_lists.current = undefined;
    assert.ok(!ykphone_hotkeys.process_hotkey(key_event, "up_arrow"));
    message_lists.current = {get_last_message_sent_by_me: () => last_message};
    // The cursor in a recipient field, text in the box, a dialog.
    focus = "none";
    assert.ok(!ykphone_hotkeys.process_hotkey(key_event, "up_arrow"));
    focus = "compose";
    empty_compose = false;
    assert.ok(!ykphone_hotkeys.process_hotkey(key_event, "up_arrow"));
    empty_compose = true;
    layers.modal = true;
    assert.ok(!ykphone_hotkeys.process_hotkey(key_event, "up_arrow"));
    assert.equal(edits, 1);
});

run_test("Escape only marks the conversation the user is in", ({override}) => {
    reset();
    const marked = [];
    override(unread_ops, "mark_topic_as_read", (stream_id, topic) => {
        marked.push(`topic ${stream_id} "${topic}"`);
    });
    override(unread, "num_unread_for_topic", () => 2);
    current_filter = {place: {kind: "channel", stream_id: 3}};

    // From the conversation's own compose box: marked read, and the box
    // gives up the keyboard so that the feed's hotkeys work again.
    focus = "compose";
    assert.ok(ykphone_hotkeys.process_escape_key(escape_event));
    assert.deepEqual(marked, ['topic 3 ""']);
    assert.deepEqual(closed, ["compose"]);

    // From the feed, with nothing focused.
    focus = "none";
    marked.length = 0;
    assert.ok(ykphone_hotkeys.process_escape_key(escape_event));
    assert.deepEqual(marked, ['topic 3 ""']);

    marked.length = 0;
    closed.length = 0;

    // Ctrl+[ keeps upstream's "go to the home view".
    assert.ok(!ykphone_hotkeys.process_escape_key({key: "[", originalEvent: {}}));

    // A Hangul syllable being composed: the input method cancels it and
    // nothing else happens.
    for (const originalEvent of [{isComposing: true}, {keyCode: 229}]) {
        assert.ok(ykphone_hotkeys.process_escape_key({key: "Escape", originalEvent}));
    }
    // An event with no browser event behind it is not a composition.
    assert.ok(ykphone_hotkeys.process_escape_key({key: "Escape"}));
    assert.deepEqual(marked, ['topic 3 ""']);
    marked.length = 0;
    closed.length = 0;

    // In the thread panel Escape closes the panel; the conversation
    // behind it is not touched.
    focus = "thread-panel";
    assert.ok(ykphone_hotkeys.process_escape_key(escape_event));
    assert.deepEqual(closed, ["thread panel"]);
    assert.deepEqual(marked, []);
    closed.length = 0;

    // Any other text field (the navbar search, a message edit form, a
    // settings input) leaves Escape to upstream.
    for (const value of ["other-editor", "input", "pill"]) {
        focus = value;
        assert.equal(ykphone_hotkeys.process_escape_key(escape_event), false, value);
    }
    // So does a dialog, a menu, a picker, a panel or an open sidebar
    // overlay, which Escape closes first.
    focus = "none";
    for (const layer of [
        "overlay",
        "modal",
        "switcher",
        "popover",
        "popover_menu",
        "emoji_picker",
        "sidebar",
        "zoomed",
        "thread_panel",
        "pins",
        // A compose box addressed somewhere else: upstream cancels it
        // and saves the draft.
        "foreign_compose",
    ]) {
        layers[layer] = true;
        assert.equal(ykphone_hotkeys.process_escape_key(escape_event), false, layer);
        layers[layer] = false;
    }
    assert.deepEqual(marked, []);
    assert.deepEqual(closed, []);

    // Not a conversation: Escape keeps its other meanings (the home
    // view, with the user's setting).
    current_filter = {place: {kind: "page", page: "files"}};
    assert.ok(!ykphone_hotkeys.process_escape_key(escape_event));
    current_filter = undefined;
    assert.ok(!ykphone_hotkeys.process_escape_key(escape_event));

    ykphone_flags.set_channels_open_in_general_chat(false);
    assert.ok(!ykphone_hotkeys.process_escape_key(escape_event));
    assert.ok(!ykphone_hotkeys.mark_current_conversation_read());
});

run_test("mark_current_conversation_read", ({override}) => {
    reset();
    const marked = [];
    override(unread_ops, "mark_topic_as_read", (stream_id, topic) => {
        marked.push(`topic ${stream_id} "${topic}"`);
    });
    override(unread_ops, "mark_pm_as_read", (user_ids_string) => {
        marked.push(`dm ${user_ids_string}`);
    });
    let unread_counts = new Map();
    override(unread, "num_unread_for_topic", (stream_id, topic) =>
        unread_counts.get(`${stream_id}:${topic}`),
    );
    override(unread, "num_unread_for_user_ids_string", (s) => unread_counts.get(s));

    unread_counts = new Map([
        ["3:", 2],
        ["3:Plans", 0],
        ["7,8", 1],
    ]);
    current_filter = {place: {kind: "channel", stream_id: 3}};
    assert.ok(ykphone_hotkeys.mark_current_conversation_read());
    // Nothing unread: no request, but Escape is still used up.
    current_filter = {place: {kind: "thread", stream_id: 3, topic: "Plans"}};
    assert.ok(ykphone_hotkeys.mark_current_conversation_read());
    current_filter = {place: {kind: "dm", user_ids: [7, 8]}};
    assert.ok(ykphone_hotkeys.mark_current_conversation_read());
    unread_counts.set("7,8", 0);
    assert.ok(ykphone_hotkeys.mark_current_conversation_read());
    unread_counts.set("3:Plans", 4);
    current_filter = {place: {kind: "thread", stream_id: 3, topic: "Plans"}};
    assert.ok(ykphone_hotkeys.mark_current_conversation_read());
    assert.deepEqual(marked, ['topic 3 ""', "dm 7,8", 'topic 3 "Plans"']);

    current_filter = {place: undefined};
    assert.ok(!ykphone_hotkeys.mark_current_conversation_read());
    assert.ok(ykphone_thread_panel.is_open() === false);
    assert.ok(ykphone_compose.composer_belongs_to_narrow());
});
