"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const {page_params} = require("./lib/zpage_params.cjs");

const channel = mock_esm("../src/channel", {
    xhr_error_message: (message, xhr) => `${message} ${xhr.responseJSON.msg}`,
});
const feedback_widget = mock_esm("../src/feedback_widget");
mock_esm("../src/hash_util", {
    search_terms_to_hash: (terms) =>
        "#narrow/" + terms.map((term) => `${term.operator}/${term.operand}`).join("/"),
});
mock_esm("../src/people", {
    maybe_get_user_by_id: (user_id) =>
        user_id === 7 ? {user_id: 7, full_name: "Cordelia"} : undefined,
    small_avatar_url_for_person: (person) => `/avatar/${person.user_id}/small`,
});
mock_esm("../src/timerender", {
    get_localized_date_or_time_for_format: (date, format) => `${format}:${date.getTime() / 1000}`,
});

const ykphone_pins = zrequire("ykphone_pins");

const verona_id = 3;

function pin_dict(message_id, overrides = {}) {
    return {
        message_id,
        stream_id: verona_id,
        topic_name: "",
        pinned_by_user_id: 7,
        date_pinned: 1_700_000_000 + message_id,
        sender_id: 8,
        sender_full_name: "Hamlet",
        timestamp: 1_600_000_000 + message_id,
        content: `<p>message ${message_id}</p>`,
        ...overrides,
    };
}

const stream_message = {id: 10, type: "stream", stream_id: verona_id, topic: ""};
const dm = {id: 12, type: "private"};

function track_changes() {
    const changes = [];
    ykphone_pins.on_pins_changed((stream_id, message_ids) => {
        changes.push([stream_id, message_ids]);
    });
    return changes;
}

run_test("labels and contexts", () => {
    ykphone_pins.clear_for_testing();
    page_params.is_spectator = false;

    assert.equal(ykphone_pins.pinned_by_label(pin_dict(1)), "translated: Pinned by Cordelia");
    // A pinner who left, or is unknown, still reads as pinned.
    assert.equal(
        ykphone_pins.pinned_by_label(pin_dict(1, {pinned_by_user_id: null})),
        "translated: Pinned to this channel",
    );
    assert.equal(
        ykphone_pins.pinned_by_label(pin_dict(1, {pinned_by_user_id: 99})),
        "translated: Pinned to this channel",
    );

    // Direct messages cannot be pinned, and spectators see no pin UI.
    assert.equal(ykphone_pins.can_pin(dm), false);
    assert.equal(ykphone_pins.get_menu_context(dm), undefined);
    assert.equal(ykphone_pins.get_pin_line_context(dm), undefined);
    page_params.is_spectator = true;
    assert.equal(ykphone_pins.can_pin(stream_message), false);
    assert.equal(ykphone_pins.get_menu_context(stream_message), undefined);
    page_params.is_spectator = false;
    assert.deepEqual(ykphone_pins.get_menu_context(stream_message), {
        message_id: 10,
        is_pinned: false,
    });
});

run_test("load and pin line", ({override}) => {
    ykphone_pins.clear_for_testing();
    page_params.is_spectator = false;
    const changes = track_changes();
    const requests = [];
    override(channel, "get", (opts) => {
        requests.push(opts);
    });

    // The first look at a channel fetches its pins once.
    assert.equal(ykphone_pins.get_pin_line_context(stream_message), undefined);
    assert.equal(ykphone_pins.get_pin_line_context(stream_message), undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/json/ykphone/pins");
    assert.deepEqual(requests[0].data, {stream_id: verona_id});

    // A failed fetch is not retried by rendering; a forced load asks
    // again.
    requests[0].error();
    ykphone_pins.get_pin_line_context(stream_message);
    ykphone_pins.load_stream_pins(verona_id);
    assert.equal(requests.length, 1);
    ykphone_pins.load_stream_pins(verona_id, true);
    assert.equal(requests.length, 2);

    requests[1].success({pins: [pin_dict(10), pin_dict(11, {date_pinned: 5})]});
    assert.deepEqual(changes, [[verona_id, [10, 11]]]);
    assert.deepEqual(ykphone_pins.get_pin_line_context(stream_message), {
        pinned_by_label: "translated: Pinned by Cordelia",
    });
    assert.deepEqual(ykphone_pins.get_menu_context(stream_message), {
        message_id: 10,
        is_pinned: true,
    });
    assert.ok(ykphone_pins.is_pinned(11));
    assert.equal(ykphone_pins.pin_count(verona_id), 2);
    // Newest pin first.
    assert.deepEqual(
        ykphone_pins.pins_for_stream(verona_id).map((pin) => pin.message_id),
        [10, 11],
    );
    assert.deepEqual(ykphone_pins.get_pin(11), pin_dict(11, {date_pinned: 5}));

    // A reload reports what changed: a pin that went away, a pinner
    // that changed, nothing for pins that stayed the same.
    ykphone_pins.load_stream_pins(verona_id, true);
    requests[2].success({pins: [pin_dict(10, {pinned_by_user_id: 8})]});
    assert.deepEqual(changes[1], [verona_id, [11, 10]]);
    ykphone_pins.load_stream_pins(verona_id, true);
    requests[3].success({pins: [pin_dict(10, {pinned_by_user_id: 8})]});
    assert.deepEqual(changes[2], [verona_id, []]);
    assert.equal(ykphone_pins.pin_count(verona_id), 1);
});

run_test("pin and unpin", ({override}) => {
    ykphone_pins.clear_for_testing();
    const changes = track_changes();
    const posts = [];
    const deletes = [];
    override(channel, "post", (opts) => {
        posts.push(opts);
    });
    override(channel, "del", (opts) => {
        deletes.push(opts);
    });
    const toasts = [];
    override(feedback_widget, "show", (opts) => {
        let text;
        opts.populate({
            text(value) {
                text = value;
            },
        });
        toasts.push(`${opts.title_text}: ${text}`);
    });

    ykphone_pins.pin(10);
    assert.equal(posts[0].url, "/json/ykphone/pins");
    assert.deepEqual(posts[0].data, {message_id: 10});
    posts[0].success(pin_dict(10));
    assert.ok(ykphone_pins.is_pinned(10));
    assert.deepEqual(changes, [[verona_id, [10]]]);

    // The event for our own pin arrives too and changes nothing.
    ykphone_pins.handle_event({type: "ykphone_pin", op: "add", pin: pin_dict(10)});
    assert.deepEqual(changes, [
        [verona_id, [10]],
        [verona_id, []],
    ]);

    ykphone_pins.pin(11);
    posts[1].error({responseJSON: {msg: "Invalid message(s)"}});
    assert.deepEqual(toasts, [
        "translated: Pin: translated: Could not pin this message. Invalid message(s)",
    ]);
    assert.ok(!ykphone_pins.is_pinned(11));

    ykphone_pins.unpin(10);
    assert.equal(deletes[0].url, "/json/ykphone/pins/10");
    deletes[0].success();
    assert.ok(!ykphone_pins.is_pinned(10));
    assert.deepEqual(changes[2], [verona_id, [10]]);

    // Unpinning something we never knew was pinned changes nothing.
    ykphone_pins.unpin(12);
    deletes[1].success();
    assert.equal(changes.length, 3);
    ykphone_pins.unpin(12);
    deletes[2].error({responseJSON: {msg: "Nope"}});
    assert.equal(toasts[1], "translated: Pin: translated: Could not unpin this message. Nope");
});

run_test("events and deletions", () => {
    ykphone_pins.clear_for_testing();
    const changes = track_changes();

    ykphone_pins.handle_event({type: "ykphone_pin", op: "add", pin: pin_dict(10)});
    ykphone_pins.handle_event({type: "ykphone_pin", op: "add", pin: pin_dict(11)});
    assert.equal(ykphone_pins.pin_count(verona_id), 2);
    ykphone_pins.handle_event({
        type: "ykphone_pin",
        op: "remove",
        stream_id: verona_id,
        message_id: 10,
    });
    assert.ok(!ykphone_pins.is_pinned(10));
    // A removal we already applied is ignored.
    ykphone_pins.handle_event({
        type: "ykphone_pin",
        op: "remove",
        stream_id: verona_id,
        message_id: 10,
    });
    assert.deepEqual(changes, [
        [verona_id, [10]],
        [verona_id, [11]],
        [verona_id, [10]],
    ]);

    // Deleting messages drops their pins; unknown ids are skipped.
    ykphone_pins.on_messages_removed([11, 99]);
    assert.equal(ykphone_pins.pin_count(verona_id), 0);
    assert.deepEqual(changes[3], [verona_id, [11]]);
});

run_test("panel state", ({override}) => {
    ykphone_pins.clear_for_testing();
    const requests = [];
    override(channel, "get", (opts) => {
        requests.push(opts);
    });
    let panel_changes = 0;
    ykphone_pins.on_panel_changed(() => {
        panel_changes += 1;
    });

    assert.equal(ykphone_pins.get_panel_stream_id(), undefined);
    assert.equal(ykphone_pins.close_panel(), false);

    // Opening the panel refreshes the channel's pins.
    ykphone_pins.open_panel(verona_id);
    assert.equal(ykphone_pins.get_panel_stream_id(), verona_id);
    assert.equal(requests.length, 1);
    assert.equal(panel_changes, 1);
    // Opening it again for the same channel is a no-op.
    ykphone_pins.open_panel(verona_id);
    assert.equal(panel_changes, 1);

    ykphone_pins.toggle_panel(verona_id);
    assert.equal(ykphone_pins.get_panel_stream_id(), undefined);
    assert.equal(panel_changes, 2);
    ykphone_pins.toggle_panel(4);
    assert.equal(ykphone_pins.get_panel_stream_id(), 4);
    assert.equal(ykphone_pins.close_panel(), true);
    assert.equal(panel_changes, 4);
});

run_test("time_label", () => {
    const now = new Date();
    const today = Math.floor(now.getTime() / 1000);
    assert.equal(ykphone_pins.time_label(today), `time:${today}`);
    // Another day of this year, and a day of another year.
    const this_year = new Date(now.getFullYear(), now.getMonth() === 0 ? 6 : 0, 15);
    assert.equal(
        ykphone_pins.time_label(this_year.getTime() / 1000),
        `dayofyear_time:${this_year.getTime() / 1000}`,
    );
    const last_year = new Date(now.getFullYear() - 1, 5, 15);
    assert.equal(
        ykphone_pins.time_label(last_year.getTime() / 1000),
        `dayofyear_year_time:${last_year.getTime() / 1000}`,
    );
});

run_test("pin_row_context", () => {
    const row = ykphone_pins.pin_row_context(
        pin_dict(10, {sender_id: 7, topic_name: "Friday plans", timestamp: 1_600_000_010}),
    );
    assert.deepEqual(row, {
        message_id: 10,
        sender_name: "Hamlet",
        avatar_url: "/avatar/7/small",
        time_label: "dayofyear_year_time:1600000010",
        content: "<p>message 10</p>",
        pinned_by_label: "translated: Pinned by Cordelia",
        jump_url: "#narrow/channel/3/topic/Friday plans/near/10",
    });
    // A sender who is not in the user store still gets an avatar.
    assert.equal(ykphone_pins.pin_row_context(pin_dict(11)).avatar_url, "/avatar/8");
});

run_test("panel follows the channel room", ({override}) => {
    ykphone_pins.clear_for_testing();
    override(channel, "get", () => {});

    // Nothing to close.
    ykphone_pins.handle_narrow_activated({stream_id: 4, topic: undefined, is_files_narrow: false});

    ykphone_pins.open_panel(verona_id);
    // The channel narrow and its general chat keep the panel.
    ykphone_pins.handle_narrow_activated({
        stream_id: verona_id,
        topic: undefined,
        is_files_narrow: false,
    });
    ykphone_pins.handle_narrow_activated({stream_id: verona_id, topic: "", is_files_narrow: false});
    assert.equal(ykphone_pins.get_panel_stream_id(), verona_id);
    // A thread's full view closes it.
    ykphone_pins.handle_narrow_activated({
        stream_id: verona_id,
        topic: "Friday plans",
        is_files_narrow: false,
    });
    assert.equal(ykphone_pins.get_panel_stream_id(), undefined);
    // So does the Files tab, and another channel.
    ykphone_pins.open_panel(verona_id);
    ykphone_pins.handle_narrow_activated({
        stream_id: verona_id,
        topic: undefined,
        is_files_narrow: true,
    });
    assert.equal(ykphone_pins.get_panel_stream_id(), undefined);
    ykphone_pins.open_panel(verona_id);
    ykphone_pins.handle_narrow_activated({stream_id: 4, topic: undefined, is_files_narrow: false});
    assert.equal(ykphone_pins.get_panel_stream_id(), undefined);
});
