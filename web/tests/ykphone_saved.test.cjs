"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const channel = mock_esm("../src/channel");
mock_esm("../src/timerender", {
    get_localized_date_or_time_for_format: (date, format) =>
        `${format}:${new Date(date).getHours()}:${new Date(date).getMinutes()}:${new Date(date).getDate()}`,
});
mock_esm("../src/ykphone_activity", {
    row_context: ({message}) => ({
        message_id: message.id,
        avatar_url: `/avatar/${message.sender_id}`,
        sender_name: message.sender_full_name,
        context_label: "#Verona",
        snippet: `snippet ${message.id}`,
        time_label: "just now",
        url: "#unused",
    }),
});
mock_esm("../src/ykphone_schedule_presets", {
    popover_context: (now) => ({
        possible_send_later_today: {
            in_twenty_minutes: {text: "In 20 minutes", stamp: now.getTime() + 20 * 60 * 1000},
        },
        send_later_tomorrow: {tomorrow_nine_am: {text: "Tomorrow", stamp: 1_800_000_000_500}},
        possible_send_later_monday: false,
        max_reminder_note_length: 10,
    }),
    relative_send_at_seconds: (id, now) =>
        id === "in_twenty_minutes" ? Math.floor(now.getTime() / 1000) + 1200 : undefined,
});

const ykphone_saved = zrequire("ykphone_saved");

function item(message_id, overrides = {}) {
    return {
        message_id,
        state: "in_progress",
        due: null,
        date_created: 1000 + message_id,
        ...overrides,
    };
}

function raw_message(id) {
    return {
        id,
        avatar_url: null,
        client: "website",
        content: `<p>${id}</p>`,
        content_type: "text/html",
        is_me_message: false,
        reactions: [],
        sender_email: "hamlet@zulip.com",
        sender_full_name: "Hamlet",
        sender_id: 8,
        submessages: [],
        timestamp: 1_600_000_000,
        flags: [],
        type: "stream",
        stream_id: 3,
        display_recipient: "Verona",
        subject: "",
        topic_links: [],
    };
}

function load_items(
    items,
    in_progress_count = items.filter((row) => row.state === "in_progress").length,
) {
    let request;
    channel.get = (opts) => {
        request = opts;
    };
    const calls = [];
    ykphone_saved.load({
        on_loaded() {
            calls.push("loaded");
        },
        on_error() {
            calls.push("error");
        },
    });
    assert.equal(request.url, "/json/ykphone/saved");
    request.success({items, in_progress_count, result: "success", msg: ""});
    assert.deepEqual(calls, ["loaded"]);
}

run_test("states, labels and loading", () => {
    ykphone_saved.clear_for_testing();
    assert.ok(ykphone_saved.is_saved_state("archived"));
    assert.ok(!ykphone_saved.is_saved_state("done"));
    assert.ok(!ykphone_saved.is_saved_state(undefined));
    assert.equal(ykphone_saved.state_label("in_progress"), "translated: In progress");
    assert.equal(ykphone_saved.state_label("completed"), "translated: Completed");
    assert.equal(ykphone_saved.state_label("archived"), "translated: Archived");
    assert.equal(ykphone_saved.empty_label("in_progress"), "translated: Nothing saved for later.");
    assert.equal(ykphone_saved.empty_label("completed"), "translated: No completed items.");
    assert.equal(ykphone_saved.empty_label("archived"), "translated: No archived items.");

    // Before the list is known, upstream's starred count stands in and
    // star changes are left to the fetch.
    assert.ok(!ykphone_saved.is_loaded());
    assert.equal(ykphone_saved.in_progress_count(), undefined);
    assert.equal(ykphone_saved.sidebar_count(4), 4);
    assert.deepEqual(ykphone_saved.items_in_state("in_progress"), []);
    ykphone_saved.apply_star_change([1], true, new Date());
    assert.equal(ykphone_saved.get_item(1), undefined);
    ykphone_saved.handle_event({type: "ykphone_saved", op: "remove", message_id: 1});
    ykphone_saved.on_messages_removed([1]);

    // A failed fetch says so.
    let request;
    channel.get = (opts) => {
        request = opts;
    };
    let failed = false;
    ykphone_saved.load({
        on_loaded() {
            throw new Error("not loaded");
        },
        on_error() {
            failed = true;
        },
    });
    request.error();
    assert.ok(failed);

    let changes = 0;
    ykphone_saved.on_change(() => {
        changes += 1;
    });
    load_items([
        item(1),
        item(2, {state: "completed"}),
        item(3, {date_created: 5000}),
        item(4, {state: "archived"}),
        item(5, {date_created: 1001}),
    ]);
    assert.equal(changes, 1);
    assert.ok(ykphone_saved.is_loaded());
    assert.equal(ykphone_saved.in_progress_count(), 3);
    assert.equal(ykphone_saved.sidebar_count(99), 3);
    // Newest saved first; the same second, the newer message first.
    assert.deepEqual(
        ykphone_saved.items_in_state("in_progress").map((row) => row.message_id),
        [3, 5, 1],
    );
    assert.equal(ykphone_saved.get_item(2).state, "completed");
    assert.equal(ykphone_saved.get_item(9), undefined);
});

run_test("the star rule and events", () => {
    ykphone_saved.clear_for_testing();
    load_items([item(1), item(2, {state: "completed"}), item(3, {state: "archived"})]);
    let changes = 0;
    ykphone_saved.on_change(() => {
        changes += 1;
    });
    const now = new Date(1_700_000_000_500);

    // Starring adds an item in progress and brings an archived one
    // back; an item already saved stays as it is.
    ykphone_saved.apply_star_change([2, 3, 4], true, now);
    assert.equal(ykphone_saved.get_item(2).state, "completed");
    assert.equal(ykphone_saved.get_item(3).state, "in_progress");
    assert.deepEqual(ykphone_saved.get_item(4), item(4, {date_created: 1_700_000_000}));
    assert.equal(changes, 1);
    assert.equal(ykphone_saved.in_progress_count(), 3);
    ykphone_saved.apply_star_change([1], true, now);
    assert.equal(changes, 1);

    // Unstarring removes what is not archived.
    ykphone_saved.handle_event({
        type: "ykphone_saved",
        op: "update",
        item: item(3, {state: "archived"}),
    });
    assert.equal(changes, 2);
    ykphone_saved.apply_star_change([1, 2, 3, 9], false, now);
    assert.equal(changes, 3);
    assert.equal(ykphone_saved.in_progress_count(), 1);
    assert.equal(ykphone_saved.get_item(1), undefined);
    assert.equal(ykphone_saved.get_item(2), undefined);
    assert.equal(ykphone_saved.get_item(3).state, "archived");
    ykphone_saved.apply_star_change([3], false, now);
    assert.equal(changes, 3);

    ykphone_saved.handle_event({type: "ykphone_saved", op: "add", item: item(6, {due: 5})});
    assert.equal(ykphone_saved.get_item(6).due, 5);
    ykphone_saved.handle_event({type: "ykphone_saved", op: "remove", message_id: 6});
    assert.equal(ykphone_saved.get_item(6), undefined);
    assert.throws(() => {
        ykphone_saved.handle_event({type: "ykphone_saved", op: "rename"});
    });

    // Deleted messages take their items with them.
    const before = changes;
    ykphone_saved.on_messages_removed([4, 77]);
    assert.equal(ykphone_saved.get_item(4), undefined);
    assert.equal(changes, before + 1);
    ykphone_saved.on_messages_removed([77]);
    assert.equal(changes, before + 1);
    assert.equal(ykphone_saved.in_progress_count(), 0);
});

run_test("the count is the server's, and changes wait for the first fetch", () => {
    ykphone_saved.clear_for_testing();
    let request;
    channel.get = (opts) => {
        request = opts;
    };
    // A failed fetch drops what was waiting for it.
    ykphone_saved.load({
        on_loaded() {
            throw new Error("not loaded");
        },
        on_error() {},
    });
    ykphone_saved.handle_event({type: "ykphone_saved", op: "add", item: item(9)});
    request.error();
    ykphone_saved.load({on_loaded() {}, on_error() {}});
    ykphone_saved.apply_star_change([7], true, new Date(1_700_000_000_000));
    ykphone_saved.apply_star_change([8], false, new Date());
    ykphone_saved.handle_event({
        type: "ykphone_saved",
        op: "update",
        item: item(8, {state: "completed"}),
    });
    assert.equal(ykphone_saved.in_progress_count(), undefined);
    // The list is capped: 40 in progress, 2 listed.
    request.success({
        items: [item(1), item(2), item(8)],
        in_progress_count: 40,
    });
    assert.equal(ykphone_saved.get_item(7).state, "in_progress");
    assert.equal(ykphone_saved.get_item(8).state, "completed");
    // 40 + the star on 7, − 8 unstarred (in progress), 8 then completed.
    assert.equal(ykphone_saved.in_progress_count(), 40);
    assert.equal(ykphone_saved.sidebar_count(3), 40);
    assert.equal(ykphone_saved.get_item(9), undefined);

    // A second fetch that answers after the first finds nothing waiting.
    const requests = [];
    channel.get = (opts) => {
        requests.push(opts);
    };
    ykphone_saved.load({on_loaded() {}, on_error() {}});
    ykphone_saved.load({on_loaded() {}, on_error() {}});
    requests[0].success({items: [item(1)], in_progress_count: 1});
    requests[1].success({items: [item(1), item(2)], in_progress_count: 2});
    assert.equal(ykphone_saved.in_progress_count(), 2);

    // An edited message is fetched again.
    let fetched;
    channel.get = (opts) => {
        fetched = opts;
    };
    ykphone_saved.load_messages([1], {on_loaded() {}, on_error() {}});
    fetched.success({messages: [raw_message(1)]});
    assert.ok(ykphone_saved.forget_messages([1, 5]));
    assert.equal(ykphone_saved.get_message(1), undefined);
    assert.ok(!ykphone_saved.forget_messages([1]));
});

run_test("messages and rows", () => {
    ykphone_saved.clear_for_testing();
    const now = new Date(2026, 8, 18, 10, 0);
    const today_3pm = Math.floor(new Date(2026, 8, 18, 15, 0).getTime() / 1000);
    const past = Math.floor(new Date(2026, 8, 18, 9, 0).getTime() / 1000);
    load_items([
        item(1, {due: today_3pm}),
        item(2, {due: past}),
        item(3, {state: "completed", due: past}),
        item(4),
    ]);
    assert.deepEqual(ykphone_saved.missing_message_ids("in_progress"), [4, 2, 1]);

    // No ids, no request.
    let loaded = 0;
    ykphone_saved.load_messages([], {
        on_loaded() {
            loaded += 1;
        },
        on_error() {
            throw new Error("no request");
        },
    });
    assert.equal(loaded, 1);

    let request;
    channel.get = (opts) => {
        request = opts;
    };
    let failed = false;
    ykphone_saved.load_messages([4, 2, 1], {
        on_loaded() {
            loaded += 1;
        },
        on_error() {
            failed = true;
        },
    });
    assert.equal(request.url, "/json/messages");
    assert.equal(request.data.message_ids, "[4,2,1]");
    request.error();
    assert.ok(failed);
    // The item without a message has no row until it is fetched.
    request.success({messages: [raw_message(1), raw_message(2)]});
    assert.equal(loaded, 2);
    assert.equal(ykphone_saved.get_message(1).id, 1);
    assert.deepEqual(ykphone_saved.missing_message_ids("in_progress"), [4]);

    const rows = ykphone_saved.row_contexts("in_progress", {
        selection: "1",
        hash_for: (message_id) => `#ykphone/saved/in_progress/${message_id}`,
        now,
    });
    assert.deepEqual(
        rows.map((row) => [row.message_id, row.url, row.is_active, row.is_overdue, row.has_due]),
        [
            [2, "#ykphone/saved/in_progress/2", false, true, true],
            [1, "#ykphone/saved/in_progress/1", true, false, true],
        ],
    );
    assert.equal(rows[1].due_label, "translated: Today at time:15:0:18");
    assert.equal(rows[1].sender_name, "Hamlet");
    assert.equal(rows[1].snippet, "snippet 1");
    assert.deepEqual(
        rows[1].actions.map((action) => action.id),
        ["complete", "archive", "due"],
    );

    // A completed item's date is not a warning.
    request.success({messages: [raw_message(3), raw_message(4)]});
    const completed = ykphone_saved.row_contexts("completed", {
        selection: undefined,
        hash_for: String,
        now,
    });
    assert.equal(completed[0].is_overdue, false);
    assert.deepEqual(
        completed[0].actions.map((action) => action.id),
        ["restore", "archive"],
    );
    const plain = ykphone_saved.row_contexts("in_progress", {
        selection: undefined,
        hash_for: String,
        now,
    });
    assert.equal(plain[0].message_id, 4);
    assert.equal(plain[0].due_label, "");
    assert.deepEqual(
        ykphone_saved.row_actions("archived").map((action) => [action.id, action.icon]),
        [["restore", "unarchive"]],
    );
});

run_test("due labels and presets", () => {
    const now = new Date(2026, 8, 18, 10, 0);
    const at = (day, hour) => Math.floor(new Date(2026, 8, day, hour, 0).getTime() / 1000);
    assert.equal(ykphone_saved.due_label(at(18, 15), now), "translated: Today at time:15:0:18");
    assert.equal(ykphone_saved.due_label(at(19, 9), now), "translated: Tomorrow at time:9:0:19");
    assert.equal(
        ykphone_saved.due_label(at(21, 9), now),
        "translated: dayofyear:9:0:21 at time:9:0:21",
    );
    const next_year = Math.floor(new Date(2027, 8, 21, 9, 0).getTime() / 1000);
    assert.equal(
        ykphone_saved.due_label(next_year, now),
        "translated: dayofyear_year:9:0:21 at time:9:0:21",
    );

    const presets = ykphone_saved.due_presets(now);
    assert.deepEqual(
        presets.map((preset) => preset.id),
        ["in_twenty_minutes", "tomorrow_nine_am"],
    );
    // A relative preset counts from when it is chosen; the others keep
    // their stamp, in whole seconds.
    const later = new Date(now.getTime() + 5000);
    assert.equal(
        ykphone_saved.due_seconds_for(presets[0], later),
        Math.floor(later.getTime() / 1000) + 1200,
    );
    assert.equal(ykphone_saved.due_seconds_for(presets[1], later), 1_800_000_000);
});

run_test("changes", () => {
    ykphone_saved.clear_for_testing();
    load_items([item(1)]);
    const requests = [];
    channel.post = (opts) => {
        requests.push(["post", opts]);
    };
    channel.patch = (opts) => {
        requests.push(["patch", opts]);
    };
    let errors = 0;
    const callbacks = {
        on_error() {
            errors += 1;
        },
    };
    ykphone_saved.save(2, callbacks);
    ykphone_saved.set_state(1, "completed", callbacks);
    ykphone_saved.set_due(1, 1_800_000_000, callbacks);
    ykphone_saved.set_due(1, null, callbacks);
    assert.deepEqual(
        requests.map(([method, opts]) => [method, opts.url, opts.data]),
        [
            ["post", "/json/ykphone/saved", {message_id: "2"}],
            ["patch", "/json/ykphone/saved/1", {state: "completed"}],
            ["patch", "/json/ykphone/saved/1", {due: "1800000000"}],
            ["patch", "/json/ykphone/saved/1", {clear_due: "true"}],
        ],
    );
    // The answer is the item.
    requests[0][1].success({...item(2), result: "success", msg: ""});
    assert.equal(ykphone_saved.get_item(2).state, "in_progress");
    requests[1][1].success({...item(1, {state: "completed"}), result: "success", msg: ""});
    assert.equal(ykphone_saved.get_item(1).state, "completed");
    requests[2][1].error();
    assert.equal(errors, 1);
});
