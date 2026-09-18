"use strict";

const assert = require("node:assert/strict");

const {make_user} = require("./lib/example_user.cjs");
const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const me = make_user({user_id: 5});
const verona_id = 3;
const names = new Map([
    [5, "Me"],
    [7, "Hamlet"],
    [8, "Cordelia"],
]);

const channel = mock_esm("../src/channel");
mock_esm("../src/people", {
    is_known_user_id: (user_id) => names.has(user_id),
    get_users_from_ids: (user_ids) =>
        user_ids.map((user_id) => ({user_id, full_name: names.get(user_id)})),
    sorted_other_user_ids: (user_ids) => user_ids.filter((user_id) => user_id !== me.user_id),
});
const scheduled_messages = mock_esm("../src/scheduled_messages", {
    scheduled_messages_by_id: new Map(),
    get_all_scheduled_messages: () => [...scheduled_messages.scheduled_messages_by_id.values()],
});
mock_esm("../src/stream_data", {
    get_sub_by_id: (stream_id) => (stream_id === verona_id ? {name: "Verona"} : undefined),
});
mock_esm("../src/timerender", {
    relative_time_string_from_date: (date) => `relative:${date.getTime()}`,
});
mock_esm("../src/ykphone_activity", {
    plain_text_snippet: (html) => `text(${html})`,
    context_label: (message) => (message.subject === "" ? "#Verona" : "#Verona thread"),
});
mock_esm("../src/ykphone_saved", {
    due_label: (due) => `due:${due}`,
});

const {set_current_user} = zrequire("state_data");
const ykphone_drafts_page = zrequire("ykphone_drafts_page");

set_current_user(me);

const hash_for = (id) => `#ykphone/drafts/x/${id}`;

function raw_message(id, opts = {}) {
    const base = {
        id,
        avatar_url: null,
        client: "website",
        content: `<p>${id}</p>`,
        content_type: "text/html",
        is_me_message: false,
        reactions: [],
        sender_email: "me@zulip.com",
        sender_full_name: "Me",
        sender_id: me.user_id,
        submessages: [],
        timestamp: 1_700_000_000 + id,
        flags: [],
    };
    if (opts.type === "private") {
        return {...base, ...opts};
    }
    return {
        ...base,
        type: "stream",
        stream_id: verona_id,
        display_recipient: "Verona",
        subject: "",
        topic_links: [],
        ...opts,
    };
}

run_test("tabs and labels", () => {
    assert.ok(ykphone_drafts_page.is_drafts_tab("sent"));
    assert.ok(!ykphone_drafts_page.is_drafts_tab("all"));
    assert.ok(!ykphone_drafts_page.is_drafts_tab(undefined));
    assert.deepEqual(
        ykphone_drafts_page.DRAFTS_TABS.map((tab) => ykphone_drafts_page.tab_label(tab)),
        ["translated: Drafts", "translated: Scheduled", "translated: Sent"],
    );
    assert.deepEqual(
        ykphone_drafts_page.DRAFTS_TABS.map((tab) => ykphone_drafts_page.empty_label(tab)),
        [
            "translated: No drafts.",
            "translated: No scheduled messages.",
            "translated: You have not sent any messages yet.",
        ],
    );
    assert.equal(ykphone_drafts_page.draft_snippet("  one\n\n two  "), "one two");
});

run_test("drafts", () => {
    ykphone_drafts_page.clear_for_testing();
    assert.deepEqual(ykphone_drafts_page.get_drafts(), {});
    let notified = 0;
    ykphone_drafts_page.on_drafts_changed(() => {
        notified += 1;
    });
    ykphone_drafts_page.notify_drafts_changed();
    assert.equal(notified, 1);

    const drafts = {
        a: {type: "stream", stream_id: verona_id, topic: "", content: "general", updatedAt: 30},
        b: {type: "stream", stream_id: verona_id, topic: "plans", content: "thread", updatedAt: 50},
        c: {type: "private", private_message_recipient_ids: [7, 8], content: "dm", updatedAt: 40},
        d: {type: "stream", stream_id: 99, topic: "", content: "gone channel", updatedAt: 30},
        e: {type: "stream", topic: "", content: "no channel", updatedAt: 10},
        f: {type: "private", private_message_recipient_ids: [], content: "nobody", updatedAt: 5},
    };
    ykphone_drafts_page.set_drafts_source(() => drafts);
    assert.equal(ykphone_drafts_page.find_draft("c"), drafts.c);
    assert.equal(ykphone_drafts_page.find_draft("zz"), undefined);

    // Newest first; the same moment, the later id first.
    const rows = ykphone_drafts_page.page_rows("drafts", {
        selection: "c",
        hash_for,
        now: new Date(),
    });
    assert.deepEqual(
        rows.map((row) => [row.key, row.recipient, row.snippet, row.is_active]),
        [
            ["draft-b", "translated: #Verona thread", "thread", false],
            ["draft-c", "Hamlet, Cordelia", "dm", true],
            ["draft-d", "translated: No channel selected", "gone channel", false],
            ["draft-a", "#Verona", "general", false],
            ["draft-e", "translated: No channel selected", "no channel", false],
            ["draft-f", "translated: No recipients", "nobody", false],
        ],
    );
    assert.equal(rows[0].url, "#ykphone/drafts/x/b");
    assert.equal(rows[0].time_label, "relative:50");
    assert.deepEqual(
        rows[0].actions.map((action) => action.id),
        ["delete"],
    );

    assert.deepEqual(ykphone_drafts_page.draft_narrow_terms(drafts.b), [
        {operator: "channel", operand: "3"},
        {operator: "topic", operand: "plans"},
    ]);
    assert.deepEqual(ykphone_drafts_page.draft_narrow_terms(drafts.c), [
        {operator: "dm", operand: [7, 8]},
    ]);
    // Nothing to open for a draft without a conversation.
    assert.equal(ykphone_drafts_page.draft_narrow_terms(drafts.d), undefined);
    assert.equal(ykphone_drafts_page.draft_narrow_terms(drafts.e), undefined);
    assert.equal(ykphone_drafts_page.draft_narrow_terms(drafts.f), undefined);
});

run_test("scheduled", () => {
    const by_id = scheduled_messages.scheduled_messages_by_id;
    by_id.clear();
    by_id.set(1, {
        scheduled_message_id: 1,
        type: "stream",
        to: verona_id,
        topic: "",
        content: "x",
        rendered_content: "<p>later</p>",
        scheduled_delivery_timestamp: 300,
        failed: false,
    });
    by_id.set(2, {
        scheduled_message_id: 2,
        type: "private",
        to: [me.user_id, 7],
        content: "x",
        rendered_content: "<p>soon</p>",
        scheduled_delivery_timestamp: 100,
        failed: true,
    });
    by_id.set(3, {
        scheduled_message_id: 3,
        type: "private",
        to: [me.user_id],
        content: "x",
        rendered_content: "<p>note</p>",
        scheduled_delivery_timestamp: 300,
        failed: false,
    });
    by_id.set(4, {
        scheduled_message_id: 4,
        type: "stream",
        to: 99,
        topic: "t",
        content: "x",
        rendered_content: "",
        scheduled_delivery_timestamp: 400,
        failed: false,
    });
    const rows = ykphone_drafts_page.page_rows("scheduled", {
        selection: "3",
        hash_for,
        now: new Date(),
    });
    // Soonest first; the same moment, the lower id first.
    assert.deepEqual(
        rows.map((row) => [
            row.id,
            row.recipient,
            row.snippet,
            row.time_label,
            row.failed,
            row.is_active,
        ]),
        [
            ["2", "Hamlet", "text(<p>soon</p>)", "due:100", true, false],
            ["1", "#Verona", "text(<p>later</p>)", "due:300", false, false],
            ["3", "Me", "text(<p>note</p>)", "due:300", false, true],
            ["4", "translated: No channel selected", "text()", "due:400", false, false],
        ],
    );
    assert.deepEqual(
        rows[0].actions.map((action) => action.id),
        ["edit", "cancel"],
    );
    assert.equal(ykphone_drafts_page.find_scheduled("2").scheduled_message_id, 2);
    assert.equal(ykphone_drafts_page.find_scheduled("9"), undefined);

    assert.deepEqual(ykphone_drafts_page.scheduled_narrow_terms(by_id.get(1)), [
        {operator: "channel", operand: "3"},
        {operator: "topic", operand: ""},
    ]);
    assert.deepEqual(ykphone_drafts_page.scheduled_narrow_terms(by_id.get(2)), [
        {operator: "dm", operand: [7]},
    ]);
    assert.deepEqual(ykphone_drafts_page.scheduled_narrow_terms(by_id.get(3)), [
        {operator: "dm", operand: [me.user_id]},
    ]);
    assert.equal(ykphone_drafts_page.scheduled_narrow_terms(by_id.get(4)), undefined);
});

run_test("sent", () => {
    ykphone_drafts_page.clear_for_testing();
    assert.equal(ykphone_drafts_page.get_sent_messages(), undefined);
    assert.deepEqual(
        ykphone_drafts_page.page_rows("sent", {selection: undefined, hash_for, now: new Date()}),
        [],
    );

    const requests = [];
    channel.get = (opts) => {
        requests.push(opts);
    };
    const calls = [];
    const callbacks = {
        on_loaded() {
            calls.push("loaded");
        },
        on_error() {
            calls.push("error");
        },
    };
    ykphone_drafts_page.load_sent(callbacks);
    ykphone_drafts_page.load_sent(callbacks);
    assert.equal(requests[0].url, "/json/messages");
    assert.equal(requests[0].data.narrow, JSON.stringify([{operator: "sender", operand: 5}]));
    // An older request's answer is dropped.
    requests[0].success({messages: []});
    requests[0].error();
    assert.deepEqual(calls, []);
    requests[1].error();
    assert.deepEqual(calls, ["error"]);

    ykphone_drafts_page.load_sent(callbacks);
    requests[2].success({
        messages: [
            raw_message(10),
            raw_message(12, {
                type: "private",
                display_recipient: [
                    {id: me.user_id, email: "me@zulip.com", full_name: "Me"},
                    {id: 7, email: "hamlet@zulip.com", full_name: "Hamlet"},
                ],
            }),
            raw_message(11, {
                type: "private",
                display_recipient: [{id: me.user_id, email: "me@zulip.com", full_name: "Me"}],
            }),
            raw_message(13, {type: "private", display_recipient: "weird"}),
        ],
    });
    assert.deepEqual(calls, ["error", "loaded"]);
    const rows = ykphone_drafts_page.page_rows("sent", {
        selection: "12",
        hash_for,
        now: new Date(),
    });
    // Newest first.
    assert.deepEqual(
        rows.map((row) => [row.id, row.recipient, row.is_active, row.has_actions]),
        [
            ["13", "Me", false, false],
            ["12", "Hamlet", true, false],
            ["11", "Me", false, false],
            ["10", "#Verona", false, false],
        ],
    );
    assert.equal(rows[1].snippet, "text(<p>12</p>)");
    assert.equal(rows[1].time_label, `relative:${1_700_000_012 * 1000}`);
    assert.equal(ykphone_drafts_page.find_sent_message(11).id, 11);
    assert.equal(ykphone_drafts_page.find_sent_message(99), undefined);

    ykphone_drafts_page.clear_sent_messages();
    assert.equal(ykphone_drafts_page.find_sent_message(11), undefined);
});
