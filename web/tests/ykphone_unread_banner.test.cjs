"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const $ = require("./lib/zjquery.cjs");
const {page_params} = require("./lib/zpage_params.cjs");

// What the conversation on screen is, and what is unread in it.
let place = {kind: "channel", stream_id: 7};
let unread_ids = [101, 102, 103];
let first_unread = {flavor: "found", msg_id: 101};
// Where the first unread message's row sits, against a viewport of
// 100 to 800.
let rendered_row = {length: 1, get_offset_to_window: () => ({top: 900, bottom: 940})};
let messages = new Map([[101, {id: 101, timestamp: 1_756_684_800}]]);
let flag_on = true;
const narrowed = [];
const selected = [];
let marked_read = 0;

// The narrow on screen; its terms are read through ykphone_places.
const filter = {};

const message_lists = mock_esm("../src/message_lists", {
    current: {
        get: (message_id) => messages.get(message_id),
        get_row: () => rendered_row,
        select_id(message_id, opts) {
            selected.push({message_id, opts});
        },
    },
});
mock_esm("../src/message_store", {
    get: (message_id) => messages.get(message_id),
});
mock_esm("../src/browser_history", {
    go_to_location(hash) {
        narrowed.push(hash);
    },
});
mock_esm("../src/hash_util", {
    search_terms_to_hash: (terms) =>
        "#narrow/" + terms.map((term) => `${term.operator}/${term.operand}`).join("/"),
});
mock_esm("../src/message_viewport", {
    message_viewport_info: () => ({visible_top: 100, visible_bottom: 800}),
});
const narrow_state = mock_esm("../src/narrow_state", {
    filter: () => filter,
    get_first_unread_info: () => first_unread,
});
mock_esm("../src/ykphone_time", {
    day_or_time: () => "9:41 AM",
});
mock_esm("../src/unread", {
    num_unread_for_topic: () => unread_ids.length,
    num_unread_for_user_ids_string: () => unread_ids.length,
});
mock_esm("../src/ykphone_flags", {
    channels_open_in_general_chat: () => flag_on,
});
mock_esm("../src/ykphone_hotkeys", {
    mark_current_conversation_read() {
        marked_read += 1;
        return true;
    },
});
mock_esm("../src/ykphone_places", {
    place_for_filter: () => place,
});
const ykphone_unread_badges = mock_esm("../src/ykphone_unread_badges", {
    on_counts_updated() {
        throw new Error("the listener is registered only in its own test");
    },
});

const ykphone_unread_banner = zrequire("ykphone_unread_banner");

function reset() {
    $.clear_all_elements();
    page_params.is_spectator = false;
    place = {kind: "channel", stream_id: 7};
    unread_ids = [101, 102, 103];
    first_unread = {flavor: "found", msg_id: 101};
    rendered_row = {length: 1, get_offset_to_window: () => ({top: 900, bottom: 940})};
    messages = new Map([[101, {id: 101, timestamp: 1_756_684_800}]]);
    flag_on = true;
    narrowed.length = 0;
    selected.length = 0;
    marked_read = 0;
    ykphone_unread_banner.clear_for_testing();
}

run_test("what the bar says", () => {
    reset();
    assert.deepEqual(ykphone_unread_banner.get_context(), {
        count_label: "translated: 3 new messages",
        since_label: "translated: since 9:41 AM",
        mark_read_label: "translated: Mark as read",
        jump_label: "translated: Jump to first new message",
    });

    // The time comes from the first unread message; without it (not in
    // this client's store) the count stands alone.
    messages = new Map();
    assert.equal(ykphone_unread_banner.get_context().since_label, undefined);
});

run_test("when the bar appears", () => {
    reset();
    assert.ok(ykphone_unread_banner.get_context() !== undefined);

    // Nothing to report.
    unread_ids = [];
    assert.equal(ykphone_unread_banner.get_context(), undefined);
    reset();

    // The first unread message is already on screen: upstream's own
    // reading is about to mark it read, and the in-feed "새로운" line
    // says where it is.
    rendered_row = {length: 1, get_offset_to_window: () => ({top: 300, bottom: 340})};
    assert.equal(ykphone_unread_banner.get_context(), undefined);
    // Scrolled past, above the viewport: out of sight again.
    rendered_row = {length: 1, get_offset_to_window: () => ({top: 20, bottom: 60})};
    assert.ok(ykphone_unread_banner.get_context() !== undefined);
    // A message that is not rendered at all counts as out of sight,
    // and so do unread messages this client cannot place.
    rendered_row = {length: 0};
    assert.ok(ykphone_unread_banner.get_context() !== undefined);
    reset();
    first_unread = {flavor: "not_found"};
    assert.ok(ykphone_unread_banner.get_context() !== undefined);
    reset();

    // Not a conversation: a split page's list, or no narrow at all.
    place = {kind: "page", page: "dms"};
    assert.equal(ykphone_unread_banner.get_context(), undefined);
    place = undefined;
    assert.equal(ykphone_unread_banner.get_context(), undefined);
    reset();

    // Dismissed, spectators and upstream's own layout.
    ykphone_unread_banner.hide();
    assert.equal(ykphone_unread_banner.get_context(), undefined);
    ykphone_unread_banner.handle_narrow_activated();
    assert.ok(ykphone_unread_banner.get_context() !== undefined);

    reset();
    page_params.is_spectator = true;
    assert.equal(ykphone_unread_banner.get_context(), undefined);
    page_params.is_spectator = false;
    flag_on = false;
    assert.equal(ykphone_unread_banner.get_context(), undefined);
});

run_test("a dismissed bar comes back for a later batch", () => {
    reset();
    ykphone_unread_banner.hide();
    assert.equal(ykphone_unread_banner.get_context(), undefined);
    // Reading the conversation clears the dismissal; the drawing pass
    // is what notices, so that get_context stays a question.
    unread_ids = [];
    assert.equal(ykphone_unread_banner.get_context(), undefined);
    ykphone_unread_banner.render();
    unread_ids = [201, 202];
    assert.ok(ykphone_unread_banner.get_context() !== undefined);
});

run_test("no narrow at all", ({override}) => {
    reset();
    override(narrow_state, "filter", () => undefined);
    assert.equal(ykphone_unread_banner.get_context(), undefined);
    // The jump has nothing to go to either.
    $.create("#ykphone-unread-banner", {elements: []});
    ykphone_unread_banner.jump_to_first_unread();
    assert.deepEqual(narrowed, []);
});

run_test("counting each kind of conversation", () => {
    reset();
    unread_ids = [1, 2];
    assert.equal(ykphone_unread_banner.unread_count({kind: "channel", stream_id: 7}), 2);
    assert.equal(
        ykphone_unread_banner.unread_count({kind: "thread", stream_id: 7, topic: "plans"}),
        2,
    );
    assert.equal(ykphone_unread_banner.unread_count({kind: "dm", user_ids: [10, 12]}), 2);
    assert.equal(ykphone_unread_banner.unread_count({kind: "page", page: "dms"}), 0);
});

run_test("rendering into the page", ({mock_template}) => {
    reset();
    let rendered;
    let render_count = 0;
    mock_template("ykphone_unread_banner.hbs", true, (data, html) => {
        rendered = {data, html};
        render_count += 1;
        return html;
    });
    const $banner = $("#ykphone-unread-banner");

    ykphone_unread_banner.render();
    assert.equal(rendered.data.count_label, "translated: 3 new messages");
    assert.ok(rendered.html.includes("ykphone-unread-banner-jump"));
    assert.ok(rendered.html.includes("translated: since 9:41 AM"));
    assert.equal($banner.html(), rendered.html);

    // The same bar is not drawn again: a settled scroll must not take
    // the focus out of it or have it read out once more.
    ykphone_unread_banner.render();
    assert.equal(render_count, 1);

    // Read, or dismissed: the bar is emptied rather than drawn again.
    unread_ids = [];
    ykphone_unread_banner.render();
    assert.equal(render_count, 1);

    // Before the bar is mounted (ui_init renders conversations first)
    // there is nothing to draw into.
    $.clear_all_elements();
    $.create("#ykphone-unread-banner", {elements: []});
    unread_ids = [101];
    ykphone_unread_banner.render();
    assert.equal(render_count, 1);
});

run_test("mark as read", () => {
    reset();
    $.create("#ykphone-unread-banner", {elements: []});
    ykphone_unread_banner.mark_read();
    assert.equal(marked_read, 1);
    // The bar is dismissed, so it does not flash back while the
    // request is in flight.
    assert.equal(ykphone_unread_banner.get_context(), undefined);
});

run_test("jump to the first new message", () => {
    reset();
    $.create("#ykphone-unread-banner", {elements: []});

    // A message this view holds is selected and scrolled to.
    ykphone_unread_banner.jump_to_first_unread();
    assert.deepEqual(selected, [{message_id: 101, opts: {then_scroll: true, use_closest: true}}]);
    assert.deepEqual(narrowed, []);

    // One it does not hold: the conversation is opened around it. A
    // channel's general chat is its empty topic, a thread is its own,
    // and a direct message conversation is its people.
    reset();
    $.create("#ykphone-unread-banner", {elements: []});
    messages = new Map();
    ykphone_unread_banner.jump_to_first_unread();
    assert.deepEqual(narrowed, ["#narrow/channel/7/topic//near/101"]);
    assert.deepEqual(selected, []);

    reset();
    $.create("#ykphone-unread-banner", {elements: []});
    messages = new Map();
    place = {kind: "thread", stream_id: 7, topic: "plans"};
    ykphone_unread_banner.jump_to_first_unread();
    assert.deepEqual(narrowed, ["#narrow/channel/7/topic/plans/near/101"]);

    reset();
    $.create("#ykphone-unread-banner", {elements: []});
    messages = new Map();
    place = {kind: "dm", user_ids: [10, 12]};
    ykphone_unread_banner.jump_to_first_unread();
    assert.deepEqual(narrowed, ["#narrow/dm/10,12/near/101"]);

    // With no unread message to go to, the button only dismisses.
    reset();
    $.create("#ykphone-unread-banner", {elements: []});
    first_unread = {flavor: "not_found"};
    ykphone_unread_banner.jump_to_first_unread();
    assert.deepEqual(narrowed, []);
    assert.deepEqual(selected, []);
    assert.equal(ykphone_unread_banner.get_context(), undefined);
});

run_test("mounting and the refresh listener", ({override, mock_template}) => {
    reset();
    mock_template("ykphone_unread_banner.hbs", true, (_data, html) => html);
    let after_node;
    $.create("#ykphone-pane-header", {
        elements: [
            {
                after(node) {
                    after_node = node;
                },
            },
        ],
    });
    ykphone_unread_banner.mount();
    assert.equal(after_node, $("<div>")[0]);
    assert.equal($("<div>").attr("id"), "ykphone-unread-banner");

    let listener;
    override(ykphone_unread_badges, "on_counts_updated", (callback) => {
        listener = callback;
    });
    ykphone_unread_banner.initialize();
    assert.equal(listener, ykphone_unread_banner.render);
});

run_test("no current message list", ({override}) => {
    reset();
    $.create("#ykphone-unread-banner", {elements: []});
    override(message_lists, "current", undefined);
    // A narrow that is being torn down still answers, and the jump
    // opens the conversation again rather than selecting a row.
    assert.ok(ykphone_unread_banner.get_context() !== undefined);
    ykphone_unread_banner.jump_to_first_unread();
    assert.equal(narrowed.length, 1);
});
