"use strict";

const assert = require("node:assert/strict");

const {make_user} = require("./lib/example_user.cjs");
const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const me = make_user({user_id: 5});
const verona_id = 3;
const muted_id = 4;

const channel = mock_esm("../src/channel");
mock_esm("../src/people", {
    sorted_other_user_ids: (user_ids) => user_ids.filter((user_id) => user_id !== me.user_id),
    format_recipients: (user_ids_string) => `people(${user_ids_string})`,
});
mock_esm("../src/timerender", {
    get_localized_date_or_time_for_format: (date, format) => `${format}:${date.getTime() / 1000}`,
});
// Unread conversations unread.ts knows of: "stream:topic" or a DM's
// user ids string, with their message ids.
let known_topics = new Map();
let known_dms = new Map();
const unread = mock_esm("../src/unread", {
    get_unread_topics() {
        const topic_counts = new Map();
        for (const key of known_topics.keys()) {
            const [stream_id, topic] = key.split(":");
            const topics = topic_counts.get(Number(stream_id)) ?? new Map();
            topics.set(topic, {});
            topic_counts.set(Number(stream_id), topics);
        }
        return {topic_counts};
    },
    get_unread_pm: () => ({pm_dict: new Map([...known_dms.keys()].map((key) => [key, {}]))}),
    get_unread_message_ids: (ids) => ids.filter((id) => !read_ids.has(id)),
    num_unread_for_topic: (_stream_id, topic) => (topic.toLowerCase() === "plans" ? 9 : 0),
    num_unread_for_user_ids_string: () => 0,
    get_msg_ids_for_topic: (stream_id, topic) =>
        known_topics.get(`${stream_id}:${topic}`) ?? [1, 2],
    get_msg_ids_for_user_ids_string: (user_ids_string) =>
        known_dms.get(user_ids_string) ?? (user_ids_string === "7" ? [40] : []),
});
mock_esm("../src/user_topics", {
    is_topic_visible_in_home: (stream_id) => stream_id !== muted_id,
});
mock_esm("../src/ykphone_activity", {
    context_label: (message) => (message.subject === "" ? "#Verona" : "#Verona thread"),
    row_context: ({message}) => ({
        avatar_url: `/avatar/${message.sender_id}`,
        sender_name: message.sender_full_name,
        snippet: `snippet ${message.id}`,
    }),
    message_terms: (message) => [{operator: "near", operand: message.id.toString()}],
});

const {set_current_user} = zrequire("state_data");
const ykphone_unreads = zrequire("ykphone_unreads");

set_current_user(me);

const read_ids = new Set();

function raw_message(id, opts = {}) {
    const base = {
        id,
        avatar_url: null,
        client: "website",
        content: `<p>${id}</p>`,
        content_type: "text/html",
        is_me_message: false,
        reactions: [],
        sender_email: "hamlet@zulip.com",
        sender_full_name: "Hamlet",
        sender_id: 7,
        submessages: [],
        timestamp: 1_700_000_000 + id,
        flags: [],
    };
    if (opts.type === "private") {
        return {
            ...base,
            display_recipient: [
                {id: me.user_id, email: "me@zulip.com", full_name: "Me"},
                {id: 7, email: "hamlet@zulip.com", full_name: "Hamlet"},
            ],
            ...opts,
        };
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

function load(messages) {
    let request;
    channel.get = (opts) => {
        request = opts;
    };
    let loaded = false;
    ykphone_unreads.load({
        on_loaded() {
            loaded = true;
        },
        on_error() {
            throw new Error("failed");
        },
    });
    assert.equal(request.url, "/json/messages");
    assert.equal(
        request.data.narrow,
        JSON.stringify([
            {operator: "is", operand: "unread"},
            {operator: "is", operand: "muted", negated: true},
        ]),
    );
    request.success({messages, found_oldest: true});
    assert.ok(loaded);
}

run_test("groups", () => {
    ykphone_unreads.clear_for_testing();
    assert.ok(!ykphone_unreads.is_loaded());
    assert.deepEqual(ykphone_unreads.groups(), []);
    assert.equal(ykphone_unreads.narrow_terms("1"), undefined);

    const plans = (id) => raw_message(id, {subject: "Plans"});
    load([
        raw_message(1),
        plans(2),
        plans(3),
        plans(4),
        plans(5),
        plans(6),
        plans(8),
        raw_message(7, {type: "private"}),
        raw_message(9, {stream_id: muted_id}),
        raw_message(10, {type: "private", display_recipient: "weird"}),
        raw_message(11, {
            type: "private",
            display_recipient: [{id: me.user_id, email: "me@zulip.com", full_name: "Me"}],
        }),
    ]);
    assert.ok(ykphone_unreads.is_loaded());
    read_ids.add(1);

    const groups = ykphone_unreads.groups();
    // Newest group first; the muted channel is left out; the read
    // message's group is gone.
    assert.deepEqual(
        groups.map((group) => [group.key, group.messages.map((message) => message.id)]),
        [
            ["d5", [10, 11]],
            ["c3:plans", [2, 3, 4, 5, 6, 8]],
            ["d7", [7]],
        ],
    );
    assert.equal(ykphone_unreads.group_key(raw_message(1, {subject: "X"})), "c3:x");
    // A message without a topic field is in the general chat.
    assert.equal(ykphone_unreads.group_key(raw_message(1, {subject: undefined})), "c3:");

    const contexts = ykphone_unreads.group_contexts({
        selection: "3",
        hash_for: (selection) => `#ykphone/unreads/${selection}`,
    });
    const plans_group = contexts[1];
    // The newest five, oldest of them first, selected by the first.
    assert.deepEqual(
        plans_group.messages.map((message) => message.message_id),
        [3, 4, 5, 6, 8],
    );
    assert.equal(plans_group.url, "#ykphone/unreads/3");
    assert.ok(plans_group.is_active);
    assert.equal(plans_group.label, "#Verona thread");
    assert.equal(plans_group.mark_read_label, "translated: Mark #Verona thread as read");
    assert.equal(plans_group.topic, "Plans");
    // One sender's messages after the first go without name and avatar.
    assert.deepEqual(
        plans_group.messages.map((message) => message.is_continuation),
        [false, true, true, true, true],
    );
    // unread.ts knows of more than were fetched.
    assert.equal(plans_group.count, 9);
    assert.ok(plans_group.has_more);
    assert.equal(plans_group.more_label, "translated: 4 more unread messages");
    assert.equal(plans_group.messages[0].time_label, "time:1700000003");
    assert.equal(plans_group.messages[0].snippet, "snippet 3");
    // A group with all its messages listed says nothing more.
    assert.equal(contexts[2].label, "people(7)");
    assert.equal(contexts[2].topic, "");
    assert.equal(contexts[2].count, 1);
    assert.ok(!contexts[2].has_more);
    assert.equal(contexts[2].more_label, "");
    assert.ok(!contexts[2].is_active);

    assert.equal(ykphone_unreads.find_group("4").key, "c3:plans");
    assert.equal(ykphone_unreads.find_group("1"), undefined);
    // A read group's conversation can still be opened.
    assert.deepEqual(ykphone_unreads.narrow_terms("1"), [{operator: "near", operand: "1"}]);
    assert.equal(ykphone_unreads.narrow_terms("99"), undefined);

    assert.deepEqual(ykphone_unreads.conversation_unread_ids(groups[1]), [1, 2, 3, 4, 5, 6, 8]);
    assert.deepEqual(ykphone_unreads.conversation_unread_ids(groups[2]), [7, 40]);

    ykphone_unreads.clear();
    assert.ok(!ykphone_unreads.is_loaded());
    read_ids.clear();
});

run_test("loading", () => {
    ykphone_unreads.clear_for_testing();
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
    ykphone_unreads.load(callbacks);
    ykphone_unreads.load(callbacks);
    requests[0].success({messages: [], found_oldest: true});
    requests[0].error();
    assert.deepEqual(calls, []);
    requests[1].error();
    assert.deepEqual(calls, ["error"]);
    assert.ok(!ykphone_unreads.is_loaded());
    assert.deepEqual(ykphone_unreads.hidden_unread_message_ids(), []);
    assert.ok(!ykphone_unreads.has_message(1));
});

run_test("paging until every unread conversation has a group", () => {
    ykphone_unreads.clear_for_testing();
    // unread.ts knows of three conversations; the newest page covers
    // one, the next page a second, and the last one is older than the
    // pages allowed.
    known_topics = new Map([
        [`${verona_id}:new`, [900]],
        [`${verona_id}:old`, [500, 501]],
        [`${verona_id}:ancient`, [3, 4]],
        [`${muted_id}:muted`, [7]],
    ]);
    known_dms = new Map([["7", [600]]]);
    const requests = [];
    channel.get = (opts) => {
        requests.push(opts);
    };
    const calls = [];
    ykphone_unreads.load({
        on_loaded() {
            calls.push("loaded");
        },
        on_error() {
            calls.push("error");
        },
    });
    assert.equal(requests[0].data.anchor, "newest");
    assert.equal(requests[0].data.include_anchor, true);
    requests[0].success({
        messages: [raw_message(900, {subject: "new"}), raw_message(600, {type: "private"})],
        found_oldest: false,
    });
    // Older: from the oldest message fetched, which is not fetched again.
    assert.equal(requests[1].data.anchor, "600");
    assert.equal(requests[1].data.include_anchor, false);
    requests[1].success({messages: [raw_message(501, {subject: "old"})], found_oldest: false});
    assert.equal(requests.length, 3);
    for (let page = 2; page < 5; page += 1) {
        requests[page].success({
            messages: [raw_message(100 + page, {subject: "old"})],
            found_oldest: false,
        });
    }
    // Five pages is the most the page reads.
    assert.equal(requests.length, 5);
    assert.deepEqual(calls, ["loaded"]);
    assert.ok(ykphone_unreads.has_message(900));
    // The muted topic is not the page's; the ancient one is summed up.
    assert.deepEqual(ykphone_unreads.hidden_unread_message_ids(), [3, 4]);

    // Once every known conversation has a group, no more pages.
    ykphone_unreads.load({on_loaded() {}, on_error() {}});
    requests[5].success({
        messages: [
            raw_message(900, {subject: "new"}),
            raw_message(501, {subject: "old"}),
            raw_message(3, {subject: "ancient"}),
            raw_message(600, {type: "private"}),
        ],
        found_oldest: false,
    });
    assert.equal(requests.length, 6);
    assert.deepEqual(ykphone_unreads.hidden_unread_message_ids(), []);

    // An empty page ends it too.
    ykphone_unreads.load({on_loaded() {}, on_error() {}});
    requests[6].success({messages: [], found_oldest: false});
    assert.equal(requests.length, 7);
    known_topics = new Map();
    known_dms = new Map();
});

run_test("keys and new messages", () => {
    assert.equal(ykphone_unreads.adjacent_group_key([], undefined, 1), undefined);
    const keys = ["a", "b", "c"];
    assert.equal(ykphone_unreads.adjacent_group_key(keys, undefined, 1), "a");
    assert.equal(ykphone_unreads.adjacent_group_key(keys, undefined, -1), "c");
    assert.equal(ykphone_unreads.adjacent_group_key(keys, "gone", 1), "a");
    assert.equal(ykphone_unreads.adjacent_group_key(keys, "a", 1), "b");
    assert.equal(ykphone_unreads.adjacent_group_key(keys, "a", -1), "a");
    assert.equal(ykphone_unreads.adjacent_group_key(keys, "c", 1), "c");

    const message = (opts) => ({
        unread: true,
        sender_id: 7,
        type: "stream",
        stream_id: verona_id,
        topic: "",
        ...opts,
    });
    assert.ok(ykphone_unreads.affects_unreads([message({})]));
    assert.ok(ykphone_unreads.affects_unreads([message({type: "private"})]));
    assert.ok(!ykphone_unreads.affects_unreads([message({unread: false})]));
    assert.ok(!ykphone_unreads.affects_unreads([message({sender_id: me.user_id})]));
    assert.ok(!ykphone_unreads.affects_unreads([message({stream_id: muted_id})]));
    assert.equal(unread.num_unread_for_user_ids_string("7"), 0);
});
