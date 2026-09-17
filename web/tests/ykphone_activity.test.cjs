"use strict";

const assert = require("node:assert/strict");

const {make_user} = require("./lib/example_user.cjs");
const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const me = make_user({user_id: 5});
const verona_id = 3;

const channel = mock_esm("../src/channel");
mock_esm("../src/hash_util", {
    search_terms_to_hash: (terms) =>
        "#narrow/" +
        terms
            .map(
                (term) =>
                    `${term.operator}/${
                        Array.isArray(term.operand) ? term.operand.join(",") : term.operand
                    }`,
            )
            .join("/"),
});
mock_esm("../src/people", {
    maybe_get_user_by_id: (user_id) => (user_id === 7 ? {user_id: 7} : undefined),
    small_avatar_url_for_person: (person) => `/avatar/${person.user_id}/small`,
    sorted_other_user_ids: (user_ids) => user_ids.filter((user_id) => user_id !== me.user_id),
});
mock_esm("../src/stream_data", {
    get_sub_by_id: (stream_id) => (stream_id === verona_id ? {name: "Verona"} : undefined),
});
mock_esm("../src/timerender", {
    relative_time_string_from_date: (date) => `relative:${date.getTime() / 1000}`,
});

const {set_current_user} = zrequire("state_data");
const ykphone_activity = zrequire("ykphone_activity");

set_current_user(me);

function raw_message(id, opts = {}) {
    const base = {
        id,
        avatar_url: null,
        client: "website",
        content: `<p>message ${id}</p>`,
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
            type: "private",
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

run_test("tabs", () => {
    ykphone_activity.clear_for_testing();
    assert.deepEqual(
        ykphone_activity.TABS.map((tab) => [tab, ykphone_activity.tab_label(tab)]),
        [
            ["all", "translated: All"],
            ["mentions", "translated: Mentions"],
            ["threads", "translated: Threads"],
            ["reactions", "translated: Reactions"],
            ["dm", "translated: Direct messages"],
        ],
    );
});

run_test("plain_text_snippet", () => {
    assert.equal(
        ykphone_activity.plain_text_snippet("<p>Hello <strong>world</strong></p><p>second</p>"),
        "Hello world second",
    );
    assert.equal(ykphone_activity.plain_text_snippet("line one<br>line two"), "line one line two");
    assert.equal(
        ykphone_activity.plain_text_snippet(
            "<p>&lt;a&gt; &amp; &#39;q&#39; &#x41;&#X42; &nbsp;x &zzz;</p>",
        ),
        "<a> & 'q' AB x &zzz;",
    );
    // A message that is only an image or an attachment link.
    assert.equal(
        ykphone_activity.plain_text_snippet(
            '<div class="message_inline_image"><a href="/user_uploads/x.png"><img src="/user_uploads/x.png"></a></div>',
        ),
        "translated: (attached file)",
    );
    assert.equal(ykphone_activity.plain_text_snippet("<p>  </p>"), "");
});

run_test("context_label and message_url", () => {
    const general = raw_message(10);
    assert.equal(ykphone_activity.context_label(general), "#Verona");
    assert.equal(ykphone_activity.message_url(general), "#narrow/channel/3/topic//near/10");

    const reply = raw_message(11, {subject: "Ship it"});
    assert.equal(ykphone_activity.context_label(reply), "translated: #Verona thread");
    assert.equal(ykphone_activity.message_url(reply), "#narrow/channel/3/topic/Ship it/near/11");

    // A message sent from this client carries no subject yet.
    const unsent = raw_message(17, {subject: undefined});
    assert.equal(ykphone_activity.context_label(unsent), "#Verona");
    assert.equal(ykphone_activity.message_url(unsent), "#narrow/channel/3/topic//near/17");

    // A channel the user has left: the server's name is used.
    const gone = raw_message(12, {stream_id: 9, display_recipient: "Gone"});
    assert.equal(ykphone_activity.context_label(gone), "#Gone");
    const nameless = raw_message(13, {stream_id: 9, display_recipient: []});
    assert.equal(ykphone_activity.context_label(nameless), "#");

    const dm = raw_message(14, {type: "private"});
    assert.equal(ykphone_activity.context_label(dm), "translated: DM");
    assert.equal(ykphone_activity.message_url(dm), "#narrow/dm/7/near/14");

    // A conversation with oneself keeps the user's own id.
    const self_dm = raw_message(15, {
        type: "private",
        display_recipient: [{id: me.user_id, email: "me@zulip.com", full_name: "Me"}],
    });
    assert.equal(ykphone_activity.message_url(self_dm), "#narrow/dm/5/near/15");
    const odd_dm = raw_message(16, {type: "private", display_recipient: "Odd"});
    assert.equal(ykphone_activity.message_url(odd_dm), "#narrow/dm//near/16");
});

run_test("row_context", () => {
    const item = {message: raw_message(20, {subject: "Ship it"}), source: "threads"};
    assert.deepEqual(ykphone_activity.row_context(item), {
        message_id: 20,
        avatar_url: "/avatar/7/small",
        sender_name: "Hamlet",
        context_label: "translated: #Verona thread",
        snippet: "message 20",
        time_label: "relative:1700000020",
        url: "#narrow/channel/3/topic/Ship it/near/20",
    });
    // A sender who is not in the user store still gets an avatar.
    const unknown = {message: raw_message(21, {sender_id: 99}), source: "mentions"};
    assert.equal(ykphone_activity.row_context(unknown).avatar_url, "/avatar/99");
});

run_test("merge", () => {
    const by_source = new Map([
        ["mentions", [raw_message(30), raw_message(31, {timestamp: 1_700_000_050})]],
        ["threads", [raw_message(30), raw_message(32)]],
        ["dm", [raw_message(33, {type: "private", timestamp: 1_700_000_050})]],
    ]);
    assert.deepEqual(
        ykphone_activity.merge(by_source).map((item) => [item.message.id, item.source]),
        [
            // Same timestamp: the newer id first.
            [33, "dm"],
            [31, "mentions"],
            [32, "threads"],
            // Once, under the first source that listed it.
            [30, "mentions"],
        ],
    );
});

function capture_requests({override}) {
    const requests = [];
    override(channel, "get", (opts) => {
        requests.push(opts);
    });
    return requests;
}

// Callbacks that record what a load reported.
function make_callbacks() {
    const state = {results: [], errors: 0};
    state.callbacks = {
        on_loaded(items) {
            state.results.push(items.map((item) => item.message.id));
        },
        on_error() {
            state.errors += 1;
        },
    };
    return state;
}

run_test("load all", (helpers) => {
    ykphone_activity.clear_for_testing();
    const requests = capture_requests(helpers);
    const state = make_callbacks();
    const {results, callbacks} = state;
    ykphone_activity.load("all", callbacks);
    assert.deepEqual(
        requests.map((request) => request.url),
        ["/json/messages", "/json/ykphone/threads/activity", "/json/messages", "/json/messages"],
    );
    const [mentions, threads, reactions, dm] = requests;
    assert.equal(mentions.data.narrow, JSON.stringify([{operator: "is", operand: "mentioned"}]));
    assert.equal(mentions.data.num_before, 50);
    assert.equal(mentions.data.apply_markdown, true);
    assert.equal(
        reactions.data.narrow,
        JSON.stringify([
            {operator: "has", operand: "reaction"},
            {operator: "sender", operand: me.user_id},
        ]),
    );
    assert.equal(dm.data.narrow, JSON.stringify([{operator: "is", operand: "dm"}]));
    assert.deepEqual(threads.data, {client_gravatar: true});

    // Nothing is reported until every feed has answered.
    mentions.success({messages: [raw_message(40)]});
    threads.success({messages: [raw_message(41, {subject: "t"})]});
    // A message only the user reacted to is not activity.
    const reaction = (user_id) => ({
        emoji_name: "+1",
        emoji_code: "1f44d",
        reaction_type: "unicode_emoji",
        user_id,
    });
    reactions.success({
        messages: [
            raw_message(42, {reactions: [reaction(me.user_id), reaction(7)]}),
            raw_message(45, {reactions: [reaction(me.user_id)]}),
        ],
    });
    assert.deepEqual(results, []);
    // Direct messages the user sent are left out.
    dm.success({
        messages: [
            raw_message(43, {type: "private"}),
            raw_message(44, {type: "private", sender_id: me.user_id}),
        ],
    });
    assert.deepEqual(results, [[43, 42, 41, 40]]);
    assert.equal(state.errors, 0);
});

run_test("load one tab, errors and stale responses", (helpers) => {
    ykphone_activity.clear_for_testing();
    const requests = capture_requests(helpers);
    const state = make_callbacks();
    const {results, callbacks} = state;

    ykphone_activity.load("threads", callbacks);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/json/ykphone/threads/activity");
    requests[0].success({messages: [raw_message(50, {subject: "t"})]});
    assert.deepEqual(results, [[50]]);

    // One failed feed fails the load once; later answers are dropped.
    ykphone_activity.load("all", callbacks);
    assert.equal(requests.length, 5);
    requests[1].error();
    requests[2].error();
    requests[3].success({messages: [raw_message(51)]});
    requests[4].success({messages: []});
    assert.equal(state.errors, 1);
    assert.deepEqual(results, [[50]]);

    // Answers of a load that was superseded are dropped too.
    ykphone_activity.load("mentions", callbacks);
    ykphone_activity.load("reactions", callbacks);
    assert.equal(requests.length, 7);
    requests[5].success({messages: [raw_message(52)]});
    requests[5].error();
    assert.deepEqual(results, [[50]]);
    assert.equal(state.errors, 1);
    requests[6].success({
        messages: [
            raw_message(53, {
                reactions: [
                    {
                        emoji_name: "+1",
                        emoji_code: "1f44d",
                        reaction_type: "unicode_emoji",
                        user_id: 7,
                    },
                ],
            }),
        ],
    });
    assert.deepEqual(results, [[50], [53]]);
});
