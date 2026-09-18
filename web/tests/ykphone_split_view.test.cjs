"use strict";

const assert = require("node:assert/strict");

const {make_realm} = require("./lib/example_realm.cjs");
const {make_user} = require("./lib/example_user.cjs");
const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const me = make_user({user_id: 5, full_name: "Me"});
const verona_id = 3;

// ---- Fakes of the data the rows are built from ----

let conversations = [];
let unread_ids = new Set();
let unread_by_dm = new Map();
let unread_by_topic = new Map();
let participated_topics = new Set();
let threads_by_topic = new Map();
let presence_disabled = false;
const users = new Map([
    [5, {user_id: 5, full_name: "Me", is_bot: false, is_active: true}],
    [7, {user_id: 7, full_name: "Hamlet", is_bot: false, is_active: true}],
    [8, {user_id: 8, full_name: "Cordelia", is_bot: false, is_active: true}],
    [9, {user_id: 9, full_name: "Welcome Bot", is_bot: true, is_active: true}],
    [10, {user_id: 10, full_name: "Gone", is_bot: false, is_active: false}],
]);

const channel = mock_esm("../src/channel");
mock_esm("../src/buddy_data", {
    get_user_circle_class: (user_id, is_deactivated) =>
        is_deactivated ? "user-circle-deactivated" : `user-circle-${user_id}`,
});
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
    maybe_get_user_by_id: (user_id) => users.get(user_id),
    small_avatar_url_for_person: (person) => `/avatar/${person.user_id}/small`,
    small_avatar_url_for_user_id: (user_id) => `/avatar/${user_id}`,
    sorted_other_user_ids: (user_ids) => user_ids.filter((user_id) => user_id !== me.user_id),
    user_ids_string_to_ids_array: (s) => s.split(",").map((part) => Number.parseInt(part, 10)),
    get_users_from_ids: (user_ids) => user_ids.map((user_id) => users.get(user_id)),
    dm_matches_search_string: (matched_users, search) =>
        search === "" || matched_users.some((user) => user.full_name.includes(search)),
    format_recipients: (user_ids_string) =>
        user_ids_string
            .split(",")
            .map((part) => users.get(Number.parseInt(part, 10)).full_name)
            .join(", "),
    is_active_user_or_system_bot: (user_id) => users.get(user_id)?.is_active === true,
    is_active_user: (user_id) => users.get(user_id)?.is_active === true,
    is_valid_user_id: (user_id) => users.has(Number(user_id)),
    is_valid_user_ids: (user_ids) => user_ids.every((user_id) => users.has(Number(user_id))),
    get_realm_active_human_users: () =>
        [...users.values()].filter((user) => user.is_active && !user.is_bot),
    get_people_for_search_bar: (query) =>
        [...users.values()].filter((user) => user.full_name.toLowerCase().includes(query)),
});
let can_dm = () => true;
mock_esm("../src/message_util", {
    user_can_send_direct_message: (user_ids_string) => can_dm(user_ids_string),
});
mock_esm("../src/pm_conversations", {
    recent: {
        get: () => conversations,
    },
});
const verona_sub = {
    stream_id: verona_id,
    name: "Verona",
    description: "",
    invite_only: false,
    is_web_public: false,
    is_archived: false,
    subscribed: true,
};
mock_esm("../src/stream_data", {
    get_sub_by_id: (stream_id) => (stream_id === verona_id ? verona_sub : undefined),
    get_sub_by_id_string: (id_string) => (Number(id_string) === verona_id ? verona_sub : undefined),
    get_unsorted_subs: () => [verona_sub],
});
mock_esm("../src/timerender", {
    relative_time_string_from_date: (date) => `relative:${date.getTime() / 1000}`,
    get_localized_date_or_time_for_format: (date) => `date:${date.getTime() / 1000}`,
});
let unread_topic_ids = new Map();
let unread_private_ids = [];
mock_esm("../src/unread", {
    get_unread_topics() {
        const topic_counts = new Map();
        for (const key of unread_topic_ids.keys()) {
            const [stream_id, topic] = key.split(":");
            const topics = topic_counts.get(Number(stream_id)) ?? new Map();
            topics.set(topic, {});
            topic_counts.set(Number(stream_id), topics);
        }
        return {topic_counts};
    },
    get_msg_ids_for_topic: (stream_id, topic) => unread_topic_ids.get(`${stream_id}:${topic}`),
    get_msg_ids_for_private: () => unread_private_ids,
    get_unread_message_ids: (ids) => ids.filter((id) => unread_ids.has(id)),
    num_unread_for_user_ids_string: (s) => unread_by_dm.get(s) ?? 0,
    num_unread_for_topic: (stream_id, topic) => unread_by_topic.get(`${stream_id}:${topic}`) ?? 0,
});
mock_esm("../src/ykphone_threads", {
    user_takes_part_in_topic: (stream_id, topic) =>
        participated_topics.has(`${stream_id}:${topic}`),
    get_thread_for_topic: (stream_id, topic) => threads_by_topic.get(`${stream_id}:${topic}`),
});

// The Drafts & sent, Later and unread messages pages' own data
// (tested in their modules' tests).
const fake_drafts = new Map();
const fake_scheduled = new Map();
let fake_sent;
const drafts_tabs = ["drafts", "scheduled", "sent"];
mock_esm("../src/ykphone_drafts_page", {
    DRAFTS_TABS: drafts_tabs,
    is_drafts_tab: (value) => drafts_tabs.includes(value),
    tab_label: (tab) => `tab:${tab}`,
    find_draft: (id) => fake_drafts.get(id),
    draft_narrow_terms: (draft) => draft.terms,
    find_scheduled: (id) => fake_scheduled.get(id),
    scheduled_narrow_terms: (message) => message.terms,
    find_sent_message: (id) => fake_sent?.find((message) => message.id === id),
    get_sent_messages: () => fake_sent,
});
const saved_states = ["in_progress", "completed", "archived"];
let saved_loaded = false;
let saved_missing = [];
const saved_messages = new Map();
mock_esm("../src/ykphone_saved", {
    SAVED_STATES: saved_states,
    is_saved_state: (value) => saved_states.includes(value),
    state_label: (state) => `state:${state}`,
    is_loaded: () => saved_loaded,
    in_progress_count: () => (saved_loaded ? 2 : undefined),
    get_message: (message_id) => saved_messages.get(message_id),
    missing_message_ids: () => saved_missing,
});
let unreads_loaded = false;
mock_esm("../src/ykphone_unreads", {
    is_loaded: () => unreads_loaded,
    narrow_terms: (selection) =>
        selection === "70" ? [{operator: "near", operand: "70"}] : undefined,
    affects_unreads: (messages) => messages.length > 0,
});

const {set_current_user, set_realm} = zrequire("state_data");
const message_store = zrequire("message_store");
const ykphone_search = zrequire("ykphone_search");
const ykphone_split_view = zrequire("ykphone_split_view");

set_current_user(me);
const realm = make_realm({realm_presence_disabled: false});
set_realm(realm);

function reset() {
    ykphone_split_view.clear_for_testing();
    ykphone_search.clear_for_testing();
    conversations = [];
    unread_ids = new Set();
    unread_by_dm = new Map();
    unread_by_topic = new Map();
    message_store.clear_for_testing();
    participated_topics = new Set();
    threads_by_topic = new Map();
    unread_topic_ids = new Map();
    unread_private_ids = [];
    presence_disabled = false;
    realm.realm_presence_disabled = presence_disabled;
    can_dm = () => true;
}

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

// A message as message_store holds it (topic rather than subject,
// boolean flags).
function stored_message(id, opts = {}) {
    const raw = raw_message(id, opts);
    if (raw.type === "stream") {
        const {subject, ...rest} = raw;
        return {...rest, topic: subject, mentioned: opts.mentioned ?? false};
    }
    return {...raw, mentioned: opts.mentioned ?? false};
}

function capture_requests(helpers) {
    const requests = [];
    helpers.override(channel, "get", (options) => {
        requests.push(options);
    });
    return requests;
}

run_test("routes and hashes", () => {
    reset();
    assert.equal(ykphone_split_view.is_open(), false);
    assert.equal(ykphone_split_view.parse_hash(["nope"]), undefined);
    assert.equal(ykphone_split_view.parse_hash([]), undefined);
    assert.deepEqual(ykphone_split_view.parse_hash(["dms"]), {
        page: "dms",
        tab: "all",
        selection: undefined,
    });
    assert.deepEqual(ykphone_split_view.parse_hash(["dms", ""]), {
        page: "dms",
        tab: "all",
        selection: undefined,
    });
    assert.deepEqual(ykphone_split_view.parse_hash(["dms", "7,9"]), {
        page: "dms",
        tab: "all",
        selection: "7,9",
    });
    assert.deepEqual(ykphone_split_view.parse_hash(["threads", "42"]), {
        page: "threads",
        tab: "all",
        selection: "42",
    });
    assert.deepEqual(ykphone_split_view.parse_hash(["activity"]), {
        page: "activity",
        tab: "all",
        selection: undefined,
    });
    // Only a known tab may follow; a bare number is not a selection.
    assert.deepEqual(ykphone_split_view.parse_hash(["activity", "42"]), {
        page: "activity",
        tab: "all",
        selection: undefined,
    });
    assert.deepEqual(ykphone_split_view.parse_hash(["activity", "mentions", "42"]), {
        page: "activity",
        tab: "mentions",
        selection: "42",
    });

    assert.equal(ykphone_split_view.page_hash("dms"), "#ykphone/dms");
    assert.equal(ykphone_split_view.page_hash("dms", {selection: "7"}), "#ykphone/dms/7");
    assert.equal(ykphone_split_view.page_hash("threads", {selection: "42"}), "#ykphone/threads/42");
    assert.equal(ykphone_split_view.page_hash("activity"), "#ykphone/activity");
    assert.equal(
        ykphone_split_view.page_hash("activity", {tab: "mentions"}),
        "#ykphone/activity/mentions",
    );
    assert.equal(
        ykphone_split_view.page_hash("activity", {selection: "42"}),
        "#ykphone/activity/all/42",
    );
    const activity_route = {page: "activity", tab: "dm", selection: "1"};
    assert.equal(ykphone_split_view.route_hash(activity_route, "2"), "#ykphone/activity/dm/2");
    assert.equal(ykphone_split_view.route_hash(activity_route, undefined), "#ykphone/activity/dm");
    assert.equal(
        ykphone_split_view.route_hash({page: "threads", tab: "all", selection: "1"}, undefined),
        "#ykphone/threads",
    );

    ykphone_split_view.set_route(activity_route);
    assert.equal(ykphone_split_view.is_open(), true);
    assert.deepEqual(ykphone_split_view.get_route(), activity_route);
    assert.equal(ykphone_split_view.is_placeholder_visible(), false);
    ykphone_split_view.set_placeholder_visible(true);
    assert.equal(ykphone_split_view.is_placeholder_visible(), true);

    assert.equal(ykphone_split_view.page_title("dms"), "translated: Direct messages");
    assert.equal(ykphone_split_view.page_title("activity"), "translated: Activity");
    assert.equal(ykphone_split_view.page_title("threads"), "translated: Threads");
    assert.equal(ykphone_split_view.page_icon("dms"), "ykphone-rail-dm");
    assert.equal(ykphone_split_view.page_icon("activity"), "ykphone-rail-bell");
    assert.equal(ykphone_split_view.page_icon("threads"), "threads");
});

run_test("dm rows", (helpers) => {
    reset();
    const requests = capture_requests(helpers);
    conversations = [
        {user_ids_string: "7", max_message_id: 30},
        {user_ids_string: "7,8", max_message_id: 20},
        {user_ids_string: "5", max_message_id: 10},
        {user_ids_string: "10", max_message_id: 5},
    ];
    unread_by_dm.set("7", 2);
    // The group's last message is already in the store; the others are
    // fetched in one request.
    message_store.update_message_cache({
        message: stored_message(20, {
            type: "private",
            sender_id: me.user_id,
            display_recipient: [
                {id: me.user_id, email: "me@zulip.com", full_name: "Me"},
                {id: 7, email: "hamlet@zulip.com", full_name: "Hamlet"},
                {id: 8, email: "cordelia@zulip.com", full_name: "Cordelia"},
            ],
        }),
    });
    let loaded = 0;
    ykphone_split_view.load_dm_snippets(() => {
        loaded += 1;
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/json/messages");
    assert.equal(requests[0].data.message_ids, JSON.stringify([30, 10, 5]));
    assert.equal(requests[0].data.apply_markdown, true);

    // Before the answer: rows without snippets, in the conversations'
    // order, the selected one marked.
    let rows = ykphone_split_view.dm_rows("", "7,8");
    assert.deepEqual(
        rows.map((row) => [row.user_ids_string, row.url, row.recipients, row.is_active]),
        [
            ["7", "#ykphone/dms/7", "Hamlet", false],
            ["7,8", "#ykphone/dms/7,8", "Hamlet, Cordelia", true],
            ["5", "#ykphone/dms/5", "Me", false],
            ["10", "#ykphone/dms/10", "Gone", false],
        ],
    );
    const [hamlet, group, self, gone] = rows;
    assert.equal(hamlet.snippet, "");
    assert.equal(hamlet.time_label, "");
    assert.equal(hamlet.unread, 2);
    assert.ok(hamlet.has_unread);
    assert.equal(hamlet.avatar_url, "/avatar/7");
    assert.deepEqual(hamlet.avatar_urls, []);
    assert.equal(hamlet.user_circle_class, "user-circle-7");
    assert.equal(hamlet.dm_user_id, 7);
    assert.ok(!hamlet.is_group);
    // The stored message gives its snippet at once, with the "You:"
    // prefix for one's own.
    assert.ok(group.is_group);
    assert.equal(group.avatar_url, undefined);
    assert.deepEqual(group.avatar_urls, ["/avatar/7", "/avatar/8"]);
    assert.equal(group.user_circle_class, undefined);
    assert.equal(group.dm_user_id, undefined);
    assert.equal(group.snippet, "translated: You: message 20");
    assert.equal(group.time_label, `relative:${1_700_000_020}`);
    assert.ok(!group.has_unread);
    assert.equal(self.user_circle_class, "user-circle-5");
    assert.equal(gone.user_circle_class, "user-circle-deactivated");

    // The answer fills the rest in.
    requests[0].success({
        messages: [
            raw_message(30, {type: "private"}),
            raw_message(10, {
                type: "private",
                sender_id: me.user_id,
                display_recipient: [{id: me.user_id, email: "me@zulip.com", full_name: "Me"}],
            }),
            raw_message(5, {
                type: "private",
                sender_id: 10,
                display_recipient: [
                    {id: me.user_id, email: "me@zulip.com", full_name: "Me"},
                    {id: 10, email: "gone@zulip.com", full_name: "Gone"},
                ],
            }),
            // A channel message in the answer is ignored.
            raw_message(31),
        ],
    });
    assert.equal(loaded, 1);
    rows = ykphone_split_view.dm_rows("", undefined);
    assert.deepEqual(
        rows.map((row) => row.snippet),
        ["message 30", "translated: You: message 20", "translated: You: message 10", "message 5"],
    );
    assert.equal(rows[0].time_label, `relative:${1_700_000_030}`);
    assert.ok(rows.every((row) => !row.is_active));

    // Nothing to fetch the second time.
    ykphone_split_view.load_dm_snippets(() => {
        loaded += 1;
    });
    assert.equal(requests.length, 1);
    // A failed fetch leaves the rows as they are.
    conversations.push({user_ids_string: "8", max_message_id: 40});
    ykphone_split_view.load_dm_snippets(() => {
        loaded += 1;
    });
    assert.equal(requests.length, 2);
    requests[1].error();
    assert.equal(loaded, 1);

    // Search filters by name.
    assert.deepEqual(
        ykphone_split_view.dm_rows("Cord", undefined).map((row) => row.user_ids_string),
        ["7,8", "8"],
    );

    // New messages update the snippet of their conversation; older
    // ones and channel messages change nothing.
    assert.ok(
        ykphone_split_view.note_new_messages([
            stored_message(50, {type: "private", content: "<p>newest</p>"}),
            stored_message(51),
        ]),
    );
    assert.equal(ykphone_split_view.dm_rows("", undefined)[0].snippet, "newest");
    assert.ok(!ykphone_split_view.note_new_messages([stored_message(49, {type: "private"})]));
    assert.ok(!ykphone_split_view.note_new_messages([stored_message(52)]));

    // Presence dots follow the realm setting.
    realm.realm_presence_disabled = true;
    assert.equal(ykphone_split_view.dm_rows("", undefined)[0].user_circle_class, undefined);
    realm.realm_presence_disabled = false;
});

run_test("people rows and dm narrows", () => {
    reset();
    assert.deepEqual(ykphone_split_view.people_rows("  ", new Set()), []);
    // Bots, deactivated users and people already listed are left out.
    const rows = ykphone_split_view.people_rows("e", new Set(["7"]));
    assert.deepEqual(
        rows.map((row) => [row.user_id, row.url, row.name, row.avatar_url, row.user_circle_class]),
        [
            [5, "#ykphone/dms/5", "Me", "/avatar/5/small", "user-circle-5"],
            [8, "#ykphone/dms/8", "Cordelia", "/avatar/8/small", "user-circle-8"],
        ],
    );

    // People the realm's direct message permission excludes are not offered.
    can_dm = (user_ids_string) => user_ids_string !== "8";
    assert.deepEqual(
        ykphone_split_view.people_rows("e", new Set(["7"])).map((row) => row.user_id),
        [5],
    );
    can_dm = () => true;

    // A search looks past the newest 100 conversations; the cap applies
    // to what is listed.
    conversations = Array.from({length: 105}, (_, i) => ({
        user_ids_string: i === 104 ? "8" : `${1000 + i}`,
        max_message_id: 2000 - i,
    }));
    for (let i = 0; i < 104; i += 1) {
        users.set(1000 + i, {
            user_id: 1000 + i,
            full_name: `User ${i}`,
            is_bot: false,
            is_active: true,
        });
    }
    assert.equal(ykphone_split_view.dm_rows("", undefined).length, 100);
    assert.deepEqual(
        ykphone_split_view.dm_rows("Cord", undefined).map((row) => row.user_ids_string),
        ["8"],
    );
    for (let i = 0; i < 104; i += 1) {
        users.delete(1000 + i);
    }

    assert.deepEqual(ykphone_split_view.dm_narrow_terms("7,8"), [
        {operator: "dm", operand: [7, 8]},
    ]);
    assert.equal(ykphone_split_view.dm_narrow_terms("x"), undefined);
    assert.equal(ykphone_split_view.dm_narrow_terms("7,999"), undefined);

    conversations = [{user_ids_string: "7,8", max_message_id: 2}];
    assert.equal(
        ykphone_split_view.default_selection({page: "dms", tab: "all", selection: undefined}),
        "7,8",
    );
    // Opening the page must not read messages the user did not choose.
    unread_by_dm.set("7,8", 1);
    assert.equal(
        ykphone_split_view.default_selection({page: "dms", tab: "all", selection: undefined}),
        undefined,
    );
    unread_by_dm.clear();
    conversations = [];
    assert.equal(
        ykphone_split_view.default_selection({page: "dms", tab: "all", selection: undefined}),
        undefined,
    );
});

run_test("activity rows", () => {
    reset();
    const route = {page: "activity", tab: "mentions", selection: "41"};
    assert.deepEqual(
        ykphone_split_view.activity_tab_links(route).map((tab) => [tab.id, tab.active, tab.url]),
        [
            ["all", false, "#ykphone/activity/all/41"],
            ["mentions", true, "#ykphone/activity/mentions/41"],
            ["threads", false, "#ykphone/activity/threads/41"],
            ["reactions", false, "#ykphone/activity/reactions/41"],
        ],
    );
    assert.equal(ykphone_split_view.activity_tab_links(route)[0].label, "translated: All");

    const reaction_by_other = {
        emoji_name: "+1",
        emoji_code: "1f44d",
        reaction_type: "unicode_emoji",
        user_id: 8,
    };
    const items = [
        {source: "mentions", message: raw_message(41)},
        {source: "mentions", message: raw_message(42, {subject: "Ship it"})},
        {source: "mentions", message: raw_message(43, {type: "private"})},
        {source: "threads", message: raw_message(44, {subject: "Ship it"})},
        {source: "dm", message: raw_message(45, {type: "private"})},
        {
            source: "reactions",
            message: raw_message(46, {
                sender_id: me.user_id,
                sender_full_name: "Me",
                reactions: [
                    {...reaction_by_other, user_id: me.user_id},
                    reaction_by_other,
                    {
                        emoji_name: "octopus",
                        emoji_code: "octopus",
                        reaction_type: "realm_emoji",
                        user_id: 7,
                    },
                ],
            }),
        },
        {source: "reactions", message: raw_message(47, {sender_id: me.user_id, reactions: []})},
    ];
    ykphone_split_view.set_activity_items(items);
    assert.equal(ykphone_split_view.get_activity_items(), items);
    unread_ids = new Set([41, 44, 46]);

    const rows = ykphone_split_view.activity_rows(route);
    assert.deepEqual(
        rows.map((row) => row.line),
        [
            "translated: Hamlet mentioned you in #Verona",
            "translated: Hamlet mentioned you in translated: #Verona thread",
            "translated: Hamlet mentioned you in a direct message",
            "translated: Hamlet replied in a thread",
            "translated: Hamlet sent you a direct message",
            // The newest reaction by somebody else; a realm emoji by
            // its name. A message only the user reacted to (47) has no
            // row.
            "translated: Hamlet reacted :octopus: to your message",
        ],
    );
    assert.equal(ykphone_split_view.listed_activity_items().length, 6);
    assert.deepEqual(
        rows.map((row) => [row.message_id, row.url, row.is_unread, row.is_active]),
        [
            [41, "#ykphone/activity/mentions/41", true, true],
            [42, "#ykphone/activity/mentions/42", false, false],
            [43, "#ykphone/activity/mentions/43", false, false],
            [44, "#ykphone/activity/mentions/44", true, false],
            [45, "#ykphone/activity/mentions/45", false, false],
            // A reaction has no unread state of its own.
            [46, "#ykphone/activity/mentions/46", false, false],
        ],
    );
    // "Unread only" keeps the unread rows (a reaction has no unread
    // state).
    assert.ok(!ykphone_split_view.is_activity_unread_only());
    ykphone_split_view.set_activity_unread_only(true);
    assert.deepEqual(
        ykphone_split_view.activity_rows(route).map((row) => row.message_id),
        [41, 44],
    );
    ykphone_split_view.set_activity_unread_only(false);
    // The reaction row shows the reactor; the others their sender.
    assert.equal(rows[0].avatar_url, "/avatar/7/small");
    assert.equal(rows[5].avatar_url, "/avatar/7");
    assert.equal(rows[0].snippet, "message 41");
    assert.equal(rows[0].time_label, `relative:${1_700_000_041}`);
    // A unicode emoji is shown as the character.
    assert.equal(
        ykphone_split_view.activity_line({
            source: "reactions",
            message: raw_message(48, {reactions: [reaction_by_other]}),
        }),
        "translated: Cordelia reacted 👍 to your message",
    );
    assert.equal(
        ykphone_split_view.activity_line({
            source: "reactions",
            message: raw_message(49, {reactions: [{...reaction_by_other, user_id: 999}]}),
        }),
        "translated:  reacted 👍 to your message",
    );

    assert.equal(ykphone_split_view.find_activity_item(44), items[3]);
    assert.equal(ykphone_split_view.find_activity_item(1), undefined);
    assert.deepEqual(ykphone_split_view.activity_narrow_terms(items[1]), [
        {operator: "channel", operand: "3"},
        {operator: "topic", operand: "Ship it"},
        {operator: "near", operand: "42"},
    ]);
    assert.deepEqual(ykphone_split_view.activity_narrow_terms(items[4]), [
        {operator: "dm", operand: [7]},
        {operator: "near", operand: "45"},
    ]);
    assert.equal(
        ykphone_split_view.default_selection({page: "activity", tab: "all", selection: undefined}),
        undefined,
    );

    // Which new messages could add a row.
    participated_topics.add(`${verona_id}:Mobile topic`);
    threads_by_topic.set(`${verona_id}:Ship it`, {user_participated: true});
    threads_by_topic.set(`${verona_id}:Theirs`, {user_participated: false});
    const affects = (opts) => ykphone_split_view.affects_activity([stored_message(60, opts)]);
    assert.ok(!affects({sender_id: me.user_id, mentioned: true}));
    assert.ok(affects({mentioned: true}));
    assert.ok(affects({type: "private"}));
    assert.ok(affects({subject: "Ship it"}));
    assert.ok(affects({subject: "Mobile topic"}));
    assert.ok(!affects({subject: "Theirs"}));
    assert.ok(!affects({subject: "Unknown"}));
    assert.ok(!affects({}));
    assert.ok(!ykphone_split_view.affects_activity([]));

    // "Mark all as read" marks every unread message of the tab's kind:
    // mentions and direct messages by narrow, thread replies (in the
    // topics the user takes part in, not the general chat) by id.
    unread_topic_ids = new Map([
        [`${verona_id}:Ship it`, [70, 71]],
        [`${verona_id}:Mobile topic`, [72]],
        [`${verona_id}:Theirs`, [73]],
        [`${verona_id}:`, [74]],
    ]);
    unread_private_ids = [80, 81];
    const mentions = [
        {operator: "is", operand: "mentioned"},
        {operator: "is", operand: "unread"},
    ];
    assert.deepEqual(ykphone_split_view.activity_mark_read_plan("mentions"), {
        narrows: [mentions],
        message_ids: [],
        direct_message_count: 0,
    });
    assert.deepEqual(ykphone_split_view.activity_mark_read_plan("threads"), {
        narrows: [],
        message_ids: [70, 71, 72],
        direct_message_count: 0,
    });
    assert.deepEqual(ykphone_split_view.activity_mark_read_plan("all"), {
        narrows: [
            mentions,
            [
                {operator: "is", operand: "dm"},
                {operator: "is", operand: "unread"},
            ],
        ],
        message_ids: [70, 71, 72],
        direct_message_count: 2,
    });
    assert.deepEqual(ykphone_split_view.activity_mark_read_plan("reactions"), {
        narrows: [],
        message_ids: [],
        direct_message_count: 0,
    });

    // The switch is off again when the page is opened anew.
    ykphone_split_view.set_activity_unread_only(true);
    ykphone_split_view.clear_activity_items();
    assert.ok(!ykphone_split_view.is_activity_unread_only());
});

run_test("thread rows", (helpers) => {
    reset();
    const requests = capture_requests(helpers);
    assert.equal(ykphone_split_view.get_thread_rows(), undefined);
    assert.equal(ykphone_split_view.find_thread_row(1), undefined);
    const route = {page: "threads", tab: "all", selection: undefined};
    assert.equal(ykphone_split_view.default_selection(route), undefined);

    const results = [];
    let errors = 0;
    const callbacks = {
        on_loaded(rows) {
            results.push(rows.map((row) => row.root_message_id));
        },
        on_error() {
            errors += 1;
        },
    };
    ykphone_split_view.load_my_threads(callbacks);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/json/ykphone/threads/mine");
    const thread = (root_message_id, opts = {}) => ({
        root_message_id,
        stream_id: verona_id,
        topic_name: `Topic ${root_message_id}`,
        is_thread: true,
        reply_count: 2,
        last_reply_timestamp: 1_700_000_100 + root_message_id,
        root_sender_id: 7,
        root_sender_full_name: "Hamlet",
        root_snippet: `root ${root_message_id}`,
        root_timestamp: 1_700_000_000 + root_message_id,
        last_activity_timestamp: 1_700_000_100 + root_message_id,
        ...opts,
    });
    const rows = [
        thread(1),
        thread(2, {
            reply_count: 1,
            last_reply_timestamp: null,
            last_activity_timestamp: 1_700_000_002,
        }),
        thread(3, {
            root_sender_id: 999,
            root_sender_full_name: "Ghost",
            stream_id: 4,
            reply_count: 0,
            last_reply_timestamp: null,
        }),
        thread(4, {last_activity_timestamp: 1_700_000_104}),
        // The same second as thread 4: the newer root comes first.
        thread(5, {last_activity_timestamp: 1_700_000_104}),
    ];
    requests[0].success({threads: rows});
    assert.deepEqual(results, [[1, 2, 3, 4, 5]]);
    assert.deepEqual(ykphone_split_view.find_thread_row(3), rows[2]);

    // The page opens on the newest thread by activity (5 ties with 4,
    // the newer root wins) unless it has unread replies.
    assert.equal(ykphone_split_view.default_selection(route), "5");
    unread_by_topic.set(`${verona_id}:Topic 5`, 1);
    assert.equal(ykphone_split_view.default_selection(route), undefined);
    unread_by_topic.delete(`${verona_id}:Topic 5`);
    // Unread threads are listed first, then the newest activity.
    unread_by_topic.set(`${verona_id}:Topic 2`, 3);
    const contexts = ykphone_split_view.thread_row_contexts({...route, selection: "1"}, rows);
    assert.deepEqual(
        contexts.map((row) => [row.root_message_id, row.unread, row.has_unread, row.is_active]),
        [
            [2, 3, true, false],
            [5, 0, false, false],
            [4, 0, false, false],
            [3, 0, false, false],
            [1, 0, false, true],
        ],
    );
    const [two, three, one] = [contexts[0], contexts[3], contexts[4]];
    assert.equal(one.url, "#ykphone/threads/1");
    assert.equal(one.channel_name, "Verona");
    assert.equal(one.avatar_url, "/avatar/7/small");
    assert.equal(one.sender_name, "Hamlet");
    assert.equal(one.snippet, "root 1");
    assert.equal(one.reply_label, "translated: 2 replies");
    assert.equal(one.last_reply_label, `translated: Last reply relative:${1_700_000_101}`);
    assert.equal(two.reply_label, "translated: 1 reply");
    assert.equal(two.last_reply_label, "");
    // A topic without replies shows no count.
    assert.equal(three.reply_label, "");
    assert.equal(three.last_reply_label, "");
    // An unknown channel or sender still makes a row.
    assert.equal(three.channel_name, "");
    assert.equal(three.avatar_url, "/avatar/999");
    assert.deepEqual(ykphone_split_view.thread_narrow_terms(rows[0]), [
        {operator: "channel", operand: "3"},
        {operator: "topic", operand: "Topic 1"},
    ]);

    // A selected thread resolves to its topic narrow.
    assert.deepEqual(
        ykphone_split_view.narrow_terms({page: "threads", tab: "all", selection: "2"}),
        [
            {operator: "channel", operand: "3"},
            {operator: "topic", operand: "Topic 2"},
        ],
    );

    // Errors, and answers of a superseded load, are dropped.
    ykphone_split_view.load_my_threads(callbacks);
    ykphone_split_view.load_my_threads(callbacks);
    assert.equal(requests.length, 3);
    requests[1].success({threads: []});
    requests[1].error();
    assert.deepEqual(results, [[1, 2, 3, 4, 5]]);
    assert.equal(errors, 0);
    requests[2].error();
    assert.equal(errors, 1);
});

run_test("narrow_terms", () => {
    reset();
    assert.equal(
        ykphone_split_view.narrow_terms({page: "dms", tab: "all", selection: undefined}),
        undefined,
    );
    assert.deepEqual(ykphone_split_view.narrow_terms({page: "dms", tab: "all", selection: "7"}), [
        {operator: "dm", operand: [7]},
    ]);
    ykphone_split_view.set_activity_items([{source: "mentions", message: raw_message(41)}]);
    assert.deepEqual(
        ykphone_split_view.narrow_terms({page: "activity", tab: "all", selection: "41"}),
        [
            {operator: "channel", operand: "3"},
            {operator: "topic", operand: ""},
            {operator: "near", operand: "41"},
        ],
    );
    assert.equal(
        ykphone_split_view.narrow_terms({page: "activity", tab: "all", selection: "1"}),
        undefined,
    );
    assert.equal(
        ykphone_split_view.narrow_terms({page: "threads", tab: "all", selection: "1"}),
        undefined,
    );
});

run_test("what new messages and reactions change", () => {
    reset();
    const dm_route = {page: "dms", tab: "all", selection: "7"};
    // No page: nothing.
    assert.equal(
        ykphone_split_view.refresh_for_messages([stored_message(1, {type: "private"})]),
        undefined,
    );

    ykphone_split_view.set_route(dm_route);
    assert.equal(
        ykphone_split_view.refresh_for_messages([stored_message(2, {type: "private"})]),
        "rows",
    );
    assert.equal(ykphone_split_view.refresh_for_messages([stored_message(3)]), undefined);

    ykphone_split_view.set_route({page: "activity", tab: "all", selection: undefined});
    assert.equal(
        ykphone_split_view.refresh_for_messages([stored_message(4, {mentioned: true})]),
        "reload",
    );
    assert.equal(ykphone_split_view.refresh_for_messages([stored_message(5)]), undefined);

    // Threads: own replies, listed threads, topics the user takes part
    // in, mentions; not the rest of the realm.
    ykphone_split_view.set_route({page: "threads", tab: "all", selection: undefined});
    const affects = (opts) => ykphone_split_view.affects_threads([stored_message(60, opts)]);
    assert.ok(!affects({}));
    assert.ok(!affects({subject: "Elsewhere"}));
    assert.ok(affects({subject: "Elsewhere", sender_id: me.user_id}));
    assert.ok(affects({subject: "Elsewhere", mentioned: true}));
    participated_topics.add(`${verona_id}:Mobile topic`);
    assert.ok(affects({subject: "Mobile topic"}));
    threads_by_topic.set(`${verona_id}:Ship it`, {user_participated: true});
    assert.ok(affects({subject: "Ship it"}));
    assert.ok(!affects({type: "private"}));
    assert.equal(ykphone_split_view.refresh_for_messages([stored_message(61)]), undefined);
    assert.equal(
        ykphone_split_view.refresh_for_messages([stored_message(62, {subject: "Ship it"})]),
        "reload",
    );

    // Reactions: somebody else's, on the user's own message (known from
    // the store or already listed), on the All and Reactions tabs.
    const event = {message_id: 70, user_id: 7};
    assert.ok(!ykphone_split_view.reaction_affects_activity(event));
    ykphone_split_view.set_route({page: "activity", tab: "mentions", selection: undefined});
    assert.ok(!ykphone_split_view.reaction_affects_activity(event));
    ykphone_split_view.set_route({page: "activity", tab: "reactions", selection: undefined});
    assert.ok(!ykphone_split_view.reaction_affects_activity(event));
    message_store.update_message_cache({message: stored_message(70, {sender_id: me.user_id})});
    assert.ok(ykphone_split_view.reaction_affects_activity(event));
    assert.ok(!ykphone_split_view.reaction_affects_activity({message_id: 70, user_id: me.user_id}));
    assert.ok(!ykphone_split_view.reaction_affects_activity({message_id: 71, user_id: 7}));
    ykphone_split_view.set_activity_items([
        {source: "reactions", message: raw_message(71, {sender_id: me.user_id})},
    ]);
    ykphone_split_view.set_route({page: "activity", tab: "all", selection: undefined});
    assert.ok(ykphone_split_view.reaction_affects_activity({message_id: 71, user_id: 7}));
});

run_test("plan_show and resolve_route", (helpers) => {
    reset();
    const requests = capture_requests(helpers);
    const wide = {stacked: false};
    const narrow = {stacked: true};
    const dm = (selection) => ({page: "dms", tab: "all", selection});
    const activity = (selection, tab = "all") => ({page: "activity", tab, selection});
    const threads = (selection) => ({page: "threads", tab: "all", selection});

    assert.equal(ykphone_split_view.plan_show(undefined, dm(undefined)), "page");
    assert.equal(ykphone_split_view.plan_show(dm("7"), threads("1")), "page");
    assert.equal(ykphone_split_view.plan_show(activity("1"), activity("1", "dm")), "tab");
    assert.equal(ykphone_split_view.plan_show(dm("7"), dm("8")), "rows");

    // No selection: the newest conversation on a wide window, the list
    // alone (the placeholder) on a stacked one.
    conversations = [{user_ids_string: "7", max_message_id: 9}];
    assert.deepEqual(ykphone_split_view.resolve_route(dm(undefined), wide), {
        type: "replace_hash",
        hash: "#ykphone/dms/7",
    });
    assert.deepEqual(ykphone_split_view.resolve_route(dm(undefined), narrow), {
        type: "placeholder",
        stale: false,
    });

    // A selection is narrowed to once; the same row again is kept; a
    // second row of the same conversation narrows again (the near
    // target differs).
    ykphone_split_view.set_route(dm("7"));
    assert.deepEqual(ykphone_split_view.resolve_route(dm("7"), wide), {
        type: "activate",
        terms: [{operator: "dm", operand: [7]}],
    });
    ykphone_split_view.note_shown_selection(dm("7"));
    assert.deepEqual(ykphone_split_view.resolve_route(dm("7"), wide), {type: "keep"});
    assert.ok(ykphone_split_view.is_narrow_shown_for(dm("7")));
    assert.ok(!ykphone_split_view.is_narrow_shown_for(dm("8")));
    ykphone_split_view.set_activity_items([
        {source: "dm", message: raw_message(41, {type: "private"})},
        {source: "dm", message: raw_message(42, {type: "private"})},
    ]);
    ykphone_split_view.set_route(activity("41"));
    ykphone_split_view.note_shown_selection(activity("41"));
    assert.deepEqual(ykphone_split_view.resolve_route(activity("41"), wide), {type: "keep"});
    assert.deepEqual(ykphone_split_view.resolve_route(activity("42"), wide), {
        type: "activate",
        terms: [
            {operator: "dm", operand: [7]},
            {operator: "near", operand: "42"},
        ],
    });
    // Switching the filter keeps the conversation even when the new
    // rows do not list it; the placeholder replaces nothing shown.
    ykphone_split_view.set_activity_items([]);
    assert.deepEqual(ykphone_split_view.resolve_route(activity("41", "mentions"), wide), {
        type: "keep",
    });
    ykphone_split_view.set_placeholder_visible(true);
    // ... but with nothing on the right a selection that names nothing
    // listed is stale: the Activity page has no default row.
    assert.deepEqual(ykphone_split_view.resolve_route(activity("41", "mentions"), wide), {
        type: "placeholder",
        stale: true,
    });
    // While the rows are still on the way the placeholder waits (a
    // reload: nothing shown yet).
    ykphone_split_view.clear_activity_items();
    assert.deepEqual(ykphone_split_view.resolve_route(activity("41"), wide), {type: "keep"});
    ykphone_split_view.set_placeholder_visible(false);
    ykphone_split_view.note_shown_selection(undefined);
    assert.deepEqual(ykphone_split_view.resolve_route(activity("41"), wide), {
        type: "placeholder",
        stale: false,
    });

    // A thread the user no longer has falls back to the newest one.
    ykphone_split_view.set_route(threads("9"));
    assert.deepEqual(ykphone_split_view.resolve_route(threads("9"), wide), {
        type: "placeholder",
        stale: false,
    });
    ykphone_split_view.load_my_threads({on_loaded() {}, on_error() {}});
    requests.at(-1).success({
        threads: [
            {
                root_message_id: 1,
                stream_id: verona_id,
                topic_name: "Topic 1",
                is_thread: true,
                reply_count: 0,
                last_reply_timestamp: null,
                root_sender_id: 7,
                root_sender_full_name: "Hamlet",
                root_snippet: "root",
                root_timestamp: 1_700_000_001,
                last_activity_timestamp: 1_700_000_001,
            },
        ],
    });
    assert.deepEqual(ykphone_split_view.resolve_route(threads("9"), wide), {
        type: "replace_hash",
        hash: "#ykphone/threads/1",
    });
    assert.deepEqual(ykphone_split_view.resolve_route(threads("9"), narrow), {
        type: "placeholder",
        stale: true,
    });
    // A reply in a listed thread (topics match regardless of case)
    // refreshes the page's rows.
    assert.ok(ykphone_split_view.affects_threads([stored_message(63, {subject: "topic 1"})]));
    assert.ok(!ykphone_split_view.affects_threads([stored_message(64, {subject: "Topic 2"})]));
    // An invalid direct message selection likewise.
    conversations = [];
    assert.deepEqual(ykphone_split_view.resolve_route(dm("x"), wide), {
        type: "placeholder",
        stale: true,
    });

    // The composer and the pane header call a channel topic on the
    // Threads or Activity page a thread.
    ykphone_split_view.set_route(threads("1"));
    ykphone_split_view.note_shown_selection(threads("1"));
    assert.ok(ykphone_split_view.is_thread_shown());
    ykphone_split_view.set_placeholder_visible(true);
    assert.ok(!ykphone_split_view.is_thread_shown());
    ykphone_split_view.set_placeholder_visible(false);
    ykphone_split_view.set_route(dm("7"));
    assert.ok(!ykphone_split_view.is_thread_shown());
    ykphone_split_view.set_route(threads(undefined));
    assert.ok(!ykphone_split_view.is_thread_shown());
    ykphone_split_view.note_shown_selection(undefined);
    assert.ok(!ykphone_split_view.is_narrow_shown_for(threads("1")));
});

// ---- The search results page ----

function search_route(opts = {}) {
    return {
        page: "search",
        tab: opts.tab ?? "messages",
        selection: opts.selection,
        query: opts.query ?? "예산",
        sort: opts.sort ?? "newest",
        range: opts.range ?? "any",
    };
}

// Runs a search and answers both of its requests.
function run_search(helpers, query, {messages = [], files = [], complete = true} = {}) {
    const requests = capture_requests(helpers);
    ykphone_search.load(query, {sort: "newest", range: "any"}, () => {
        // The DOM side draws the rows; nothing to do here.
    });
    requests[0].success({messages, found_oldest: complete, found_newest: complete});
    requests[1].success({messages: files, found_oldest: complete, found_newest: complete});
}

run_test("the search page's route", () => {
    reset();
    // #ykphone/search/<query>[/<tab>[/<sort>-<range>[/<result>]]]
    assert.deepEqual(ykphone_split_view.parse_hash(["search", "%EC%98%88%EC%82%B0"]), {
        page: "search",
        tab: "messages",
        selection: undefined,
        query: "예산",
        sort: "newest",
        range: "any",
    });
    assert.deepEqual(ykphone_split_view.parse_hash(["search", "channel%3A3+예산", "files", "30"]), {
        page: "search",
        tab: "files",
        selection: "30",
        query: "channel:3 예산",
        sort: "newest",
        range: "any",
    });
    // The view choices travel with the query, so a reload and Back
    // show what the page showed.
    assert.deepEqual(
        ykphone_split_view.parse_hash(["search", "예산", "messages", "oldest-week", "30"]),
        {
            page: "search",
            tab: "messages",
            selection: "30",
            query: "예산",
            sort: "oldest",
            range: "week",
        },
    );
    // A tab nobody knows falls back to the messages; so does a view
    // segment nobody knows, which is then the selection.
    assert.equal(ykphone_split_view.parse_hash(["search", "예산", "nope"]).tab, "messages");
    assert.equal(
        ykphone_split_view.parse_hash(["search", "예산", "messages", "oldest-never"]).selection,
        "oldest-never",
    );
    assert.equal(ykphone_split_view.parse_hash(["search"]).query, "");

    assert.equal(
        ykphone_split_view.page_hash("search", {query: "channel:3 예산"}),
        "#ykphone/search/channel%3A3+%EC%98%88%EC%82%B0",
    );
    assert.equal(
        ykphone_split_view.page_hash("search", {query: "예산", tab: "files"}),
        "#ykphone/search/%EC%98%88%EC%82%B0/files",
    );
    // The default choices are left out of the hash; a chosen one
    // brings the segment, and a selection always does.
    assert.equal(
        ykphone_split_view.page_hash("search", {query: "예산", range: "week"}),
        "#ykphone/search/%EC%98%88%EC%82%B0/messages/newest-week",
    );
    assert.equal(
        ykphone_split_view.route_hash(search_route({tab: "files"}), "30"),
        "#ykphone/search/%EC%98%88%EC%82%B0/files/newest-any/30",
    );
    assert.equal(
        ykphone_split_view.route_hash(search_route({sort: "oldest", range: "month"}), undefined),
        "#ykphone/search/%EC%98%88%EC%82%B0/messages/oldest-month",
    );
    assert.equal(ykphone_split_view.page_hash("search"), "#ykphone/search/");
    assert.equal(
        ykphone_split_view.page_hash("search", {query: "예산", selection: "30"}),
        "#ykphone/search/%EC%98%88%EC%82%B0/messages/newest-any/30",
    );
    assert.equal(ykphone_split_view.page_title("search"), "translated: Search results");
    assert.equal(ykphone_split_view.page_icon("search"), "search");

    // A new query, and an order that reads the other end of the
    // history, are new pages; another tab and another date range are
    // answered by the results the page already has.
    assert.equal(
        ykphone_split_view.plan_show(search_route(), search_route({query: "보고"})),
        "page",
    );
    assert.equal(
        ykphone_split_view.plan_show(search_route(), search_route({sort: "oldest"})),
        "page",
    );
    assert.equal(
        ykphone_split_view.plan_show(search_route(), search_route({range: "week"})),
        "tab",
    );
    assert.equal(ykphone_split_view.plan_show(search_route(), search_route({tab: "files"})), "tab");
    assert.equal(
        ykphone_split_view.plan_show(search_route(), search_route({selection: "30"})),
        "rows",
    );

    // A search is a snapshot: messages that arrive while it is open do
    // not change what was searched for.
    ykphone_split_view.set_route(search_route());
    assert.equal(ykphone_split_view.refresh_for_messages([stored_message(30)]), undefined);
    // A result in a thread is a thread on the right.
    ykphone_split_view.set_route(search_route({selection: "30"}));
    assert.ok(ykphone_split_view.is_thread_shown());
});

run_test("the search page's rows and counts", (helpers) => {
    reset();
    const route = search_route({query: "예산"});
    ykphone_split_view.set_route(route);

    // Before the search answers there are no rows and every count is
    // empty; the placeholder waits rather than calling the selection
    // stale.
    assert.deepEqual(
        ykphone_split_view.search_tab_links(route).map((tab) => tab.count),
        ["0", "0", "0", "0"],
    );
    // A page opened with no query at all.
    const blank = {page: "search", tab: "messages", selection: undefined, query: undefined};
    assert.deepEqual(ykphone_split_view.search_messages(blank), []);
    assert.deepEqual(ykphone_split_view.search_file_rows(blank), []);
    assert.deepEqual(
        ykphone_split_view.search_tab_links(blank).map((tab) => tab.count),
        ["0", "0", "0", "0"],
    );
    assert.deepEqual(ykphone_split_view.search_messages(route), []);
    assert.deepEqual(ykphone_split_view.search_file_rows(route), []);
    assert.deepEqual(
        ykphone_split_view.resolve_route(search_route({selection: "30"}), {stacked: false}),
        {type: "placeholder", stale: false},
    );

    const now = Date.now() / 1000;
    run_search(helpers, "예산", {
        messages: [
            raw_message(30, {timestamp: now - 60}),
            raw_message(31, {timestamp: now - 60 * 60 * 24 * 40}),
        ],
        files: [
            raw_message(32, {
                timestamp: now - 120,
                content: '<p><a href="/user_uploads/2/ab/notes.txt">notes.txt</a></p>',
            }),
        ],
        complete: true,
    });

    assert.deepEqual(
        ykphone_split_view.search_messages(route).map((message) => message.id),
        [30, 31],
    );
    assert.deepEqual(
        ykphone_split_view.search_file_rows(route).map((row) => row.name),
        ["notes.txt"],
    );
    assert.deepEqual(
        ykphone_split_view.search_tab_links(route).map((tab) => [tab.id, tab.count, tab.active]),
        [
            ["messages", "2", true],
            ["files", "1", false],
            ["channels", "0", false],
            ["people", "0", false],
        ],
    );
    assert.equal(
        ykphone_split_view.search_tab_links(route)[1].url,
        "#ykphone/search/%EC%98%88%EC%82%B0/files",
    );

    // The date range and the sort come from the route.
    const week = search_route({query: "예산", range: "week"});
    assert.deepEqual(
        ykphone_split_view.search_messages(week).map((message) => message.id),
        [30],
    );
    const oldest = search_route({query: "예산", sort: "oldest"});
    assert.deepEqual(
        ykphone_split_view.search_messages(oldest).map((message) => message.id),
        [31, 30],
    );

    // A route with no choices of its own reads as the defaults, and
    // the files are ordered the same way the messages are, oldest
    // first when that is asked for.
    const bare = {page: "search", tab: "messages", selection: undefined, query: "예산"};
    assert.deepEqual(
        ykphone_split_view.search_messages(bare).map((message) => message.id),
        [30, 31],
    );
    assert.deepEqual(
        ykphone_split_view.search_file_rows(bare).map((row) => row.message_id),
        [32],
    );
    run_search(helpers, "예산", {
        messages: [],
        files: [
            raw_message(40, {
                timestamp: now - 10,
                content: '<p><a href="/user_uploads/2/ab/a.txt">a.txt</a></p>',
            }),
            raw_message(41, {
                timestamp: now - 10,
                content: '<p><a href="/user_uploads/2/ab/b.txt">b.txt</a></p>',
            }),
        ],
    });
    // Two files of the same second are ordered by their message.
    assert.deepEqual(
        ykphone_split_view.search_file_rows(route).map((row) => row.message_id),
        [41, 40],
    );
    assert.deepEqual(
        ykphone_split_view
            .search_file_rows(search_route({query: "예산", sort: "oldest"}))
            .map((row) => row.message_id),
        [40, 41],
    );
    run_search(helpers, "예산", {
        messages: [
            raw_message(30, {timestamp: now - 60}),
            raw_message(31, {timestamp: now - 60 * 60 * 24 * 40}),
        ],
        files: [
            raw_message(32, {
                timestamp: now - 120,
                content: '<p><a href="/user_uploads/2/ab/notes.txt">notes.txt</a></p>',
            }),
        ],
    });

    // A file facet narrows the Files tab's rows, but not the count on
    // its own tab: that is how many files the search found.
    ykphone_search.set_file_filters({kind: "image", sender_id: undefined, stream_id: undefined});
    assert.deepEqual(ykphone_split_view.search_file_rows(route), []);
    assert.deepEqual(ykphone_split_view.search_file_rows(route, {facets: false}).length, 1);
    assert.equal(ykphone_split_view.search_tab_links(route)[1].count, "1");
    ykphone_search.reset_facets();

    // A search that stopped at a page says so, whatever a date range
    // then left of it.
    run_search(helpers, "예산", {
        messages: [
            raw_message(33, {timestamp: now - 60}),
            raw_message(34, {timestamp: now - 60 * 60 * 24 * 400}),
        ],
        files: [],
        complete: false,
    });
    assert.equal(ykphone_split_view.search_tab_links(week)[0].count, "1+");
    assert.equal(ykphone_split_view.search_tab_links(route)[0].count, "2+");

    // The rows of another query than the one on screen are not shown.
    assert.deepEqual(ykphone_split_view.search_messages(search_route({query: "보고"})), []);
    assert.deepEqual(ykphone_split_view.search_file_rows(search_route({query: "보고"})), []);
    assert.deepEqual(ykphone_split_view.search_messages(blank), []);
    assert.deepEqual(ykphone_split_view.search_file_rows(blank), []);

    // A word in the query lists the channels and people it matches.
    const with_words = search_route({query: "Verona"});
    run_search(helpers, "Verona", {messages: [], files: []});
    assert.deepEqual(
        ykphone_split_view.search_tab_links(with_words).map((tab) => [tab.id, tab.count]),
        [
            ["messages", "0"],
            ["files", "0"],
            ["channels", "1"],
            ["people", "0"],
        ],
    );
});

run_test("what a search result opens", (helpers) => {
    reset();
    run_search(helpers, "예산", {
        messages: [raw_message(30)],
        files: [
            raw_message(32, {
                content: '<p><a href="/user_uploads/2/ab/notes.txt">notes.txt</a></p>',
            }),
        ],
    });

    // A message result opens its conversation at that message; a
    // channel and a person result open the conversation itself.
    assert.deepEqual(ykphone_split_view.narrow_terms(search_route({selection: "30"})), [
        {operator: "channel", operand: String(verona_id)},
        {operator: "topic", operand: ""},
        {operator: "near", operand: "30"},
    ]);
    assert.deepEqual(ykphone_split_view.narrow_terms(search_route({selection: `c${verona_id}`})), [
        {operator: "channel", operand: String(verona_id)},
        {operator: "topic", operand: ""},
    ]);
    assert.deepEqual(ykphone_split_view.narrow_terms(search_route({selection: "u7"})), [
        {operator: "dm", operand: [7]},
    ]);
    // A file's row opens the message it was shared in, which the page
    // knows from the Files tab's own results.
    assert.deepEqual(
        ykphone_split_view.narrow_terms(search_route({tab: "files", selection: "32"})),
        [
            {operator: "channel", operand: String(verona_id)},
            {operator: "topic", operand: ""},
            {operator: "near", operand: "32"},
        ],
    );

    // Once the results are in, a selection that names nothing is
    // stale, and the page opens nothing by itself.
    assert.deepEqual(
        ykphone_split_view.resolve_route(search_route({selection: "999"}), {stacked: false}),
        {type: "placeholder", stale: true},
    );
    assert.deepEqual(ykphone_split_view.resolve_route(search_route(), {stacked: false}), {
        type: "placeholder",
        stale: false,
    });
    assert.deepEqual(
        ykphone_split_view.resolve_route(search_route({selection: "30"}), {stacked: false}),
        {
            type: "activate",
            terms: [
                {operator: "channel", operand: String(verona_id)},
                {operator: "topic", operand: ""},
                {operator: "near", operand: "30"},
            ],
        },
    );
});

run_test("the Drafts & sent, Later and unread messages pages", () => {
    reset();
    fake_drafts.clear();
    fake_scheduled.clear();
    fake_sent = undefined;
    saved_loaded = false;
    saved_missing = [];
    saved_messages.clear();
    unreads_loaded = false;

    // Routes and hashes.
    assert.deepEqual(ykphone_split_view.parse_hash(["drafts"]), {
        page: "drafts",
        tab: "drafts",
        selection: undefined,
    });
    assert.deepEqual(ykphone_split_view.parse_hash(["drafts", "scheduled", "5"]), {
        page: "drafts",
        tab: "scheduled",
        selection: "5",
    });
    assert.deepEqual(ykphone_split_view.parse_hash(["drafts", "bogus", "5"]), {
        page: "drafts",
        tab: "drafts",
        selection: "5",
    });
    assert.deepEqual(ykphone_split_view.parse_hash(["saved"]), {
        page: "saved",
        tab: "in_progress",
        selection: undefined,
    });
    assert.deepEqual(ykphone_split_view.parse_hash(["saved", "completed", "9"]), {
        page: "saved",
        tab: "completed",
        selection: "9",
    });
    assert.deepEqual(ykphone_split_view.parse_hash(["unreads", "70"]), {
        page: "unreads",
        tab: "all",
        selection: "70",
    });
    assert.equal(ykphone_split_view.page_hash("drafts"), "#ykphone/drafts");
    assert.equal(
        ykphone_split_view.page_hash("drafts", {tab: "sent", selection: "9"}),
        "#ykphone/drafts/sent/9",
    );
    assert.equal(
        ykphone_split_view.page_hash("drafts", {selection: "a"}),
        "#ykphone/drafts/drafts/a",
    );
    assert.equal(
        ykphone_split_view.page_hash("saved", {selection: "3"}),
        "#ykphone/saved/in_progress/3",
    );
    assert.equal(ykphone_split_view.page_hash("unreads", {selection: "70"}), "#ykphone/unreads/70");
    assert.equal(
        ykphone_split_view.route_hash({page: "saved", tab: "archived", selection: "1"}, "2"),
        "#ykphone/saved/archived/2",
    );
    assert.equal(
        ykphone_split_view.route_hash({page: "unreads", tab: "all", selection: "1"}, "2"),
        "#ykphone/unreads/2",
    );
    assert.deepEqual(
        ["drafts", "saved", "unreads"].map((page) => [
            ykphone_split_view.page_title(page),
            ykphone_split_view.page_icon(page),
        ]),
        [
            ["translated: Drafts & sent", "drafts"],
            ["translated: Later", "bookmark"],
            ["translated: Unread messages", "unread"],
        ],
    );

    // Tabs: switching drops the selection; Later counts what is in
    // progress once the list is known.
    const drafts_route = {page: "drafts", tab: "scheduled", selection: "5"};
    assert.deepEqual(
        ykphone_split_view
            .page_tab_links(drafts_route)
            .map((tab) => [tab.id, tab.label, tab.count, tab.active, tab.url]),
        [
            ["drafts", "tab:drafts", "", false, "#ykphone/drafts/drafts"],
            ["scheduled", "tab:scheduled", "", true, "#ykphone/drafts/scheduled"],
            ["sent", "tab:sent", "", false, "#ykphone/drafts/sent"],
        ],
    );
    const saved_route = {page: "saved", tab: "in_progress", selection: undefined};
    assert.deepEqual(
        ykphone_split_view.page_tab_links(saved_route).map((tab) => tab.count),
        ["", "", ""],
    );
    saved_loaded = true;
    assert.deepEqual(
        ykphone_split_view
            .page_tab_links(saved_route)
            .map((tab) => [tab.id, tab.count, tab.active]),
        [
            ["in_progress", "2", true],
            ["completed", "", false],
            ["archived", "", false],
        ],
    );
    assert.deepEqual(ykphone_split_view.page_tab_links({page: "dms", tab: "all"}), []);
    assert.equal(ykphone_split_view.saved_state({page: "saved", tab: "all"}), "in_progress");

    // What a selection opens.
    const dm_terms = [{operator: "dm", operand: [7]}];
    fake_drafts.set("a", {terms: dm_terms});
    fake_scheduled.set("5", {terms: dm_terms});
    const narrow = (route) => ykphone_split_view.narrow_terms(route);
    assert.deepEqual(narrow({page: "drafts", tab: "drafts", selection: "a"}), dm_terms);
    assert.equal(narrow({page: "drafts", tab: "drafts", selection: "b"}), undefined);
    assert.deepEqual(narrow(drafts_route), dm_terms);
    assert.equal(narrow({page: "drafts", tab: "scheduled", selection: "6"}), undefined);
    assert.equal(narrow({page: "drafts", tab: "sent", selection: "12"}), undefined);
    fake_sent = [raw_message(12, {type: "private"})];
    assert.deepEqual(narrow({page: "drafts", tab: "sent", selection: "12"}), [
        ...dm_terms,
        {operator: "near", operand: "12"},
    ]);
    saved_messages.set(20, raw_message(20));
    assert.deepEqual(narrow({page: "saved", tab: "completed", selection: "20"}), [
        {operator: "channel", operand: "3"},
        {operator: "topic", operand: ""},
        {operator: "near", operand: "20"},
    ]);
    assert.equal(narrow({page: "saved", tab: "completed", selection: "21"}), undefined);
    assert.deepEqual(narrow({page: "unreads", tab: "all", selection: "70"}), [
        {operator: "near", operand: "70"},
    ]);

    // The right column: these pages wait for a click; a selection
    // whose rows are on the way waits too, and is stale once they are
    // here.
    const resolve = (route) => ykphone_split_view.resolve_route(route, {stacked: false});
    assert.deepEqual(resolve({page: "drafts", tab: "drafts", selection: undefined}), {
        type: "placeholder",
        stale: false,
    });
    assert.deepEqual(resolve({page: "drafts", tab: "drafts", selection: "b"}), {
        type: "placeholder",
        stale: true,
    });
    fake_sent = undefined;
    assert.deepEqual(resolve({page: "drafts", tab: "sent", selection: "13"}), {
        type: "placeholder",
        stale: false,
    });
    saved_loaded = false;
    assert.deepEqual(resolve({page: "saved", tab: "in_progress", selection: "21"}), {
        type: "placeholder",
        stale: false,
    });
    saved_loaded = true;
    saved_missing = [21];
    assert.deepEqual(resolve({page: "saved", tab: "in_progress", selection: "21"}), {
        type: "placeholder",
        stale: false,
    });
    saved_missing = [];
    assert.deepEqual(resolve({page: "saved", tab: "in_progress", selection: "21"}), {
        type: "placeholder",
        stale: true,
    });
    assert.deepEqual(resolve({page: "unreads", tab: "all", selection: "71"}), {
        type: "placeholder",
        stale: false,
    });
    unreads_loaded = true;
    assert.deepEqual(resolve({page: "unreads", tab: "all", selection: "71"}), {
        type: "placeholder",
        stale: true,
    });
    assert.deepEqual(resolve({page: "unreads", tab: "all", selection: "70"}), {
        type: "activate",
        terms: [{operator: "near", operand: "70"}],
    });

    // A conversation opened from these pages is called a thread.
    ykphone_split_view.set_route({page: "saved", tab: "in_progress", selection: "20"});
    assert.ok(ykphone_split_view.is_thread_shown());

    // What new messages change.
    const mine = stored_message(80, {sender_id: me.user_id});
    const theirs = stored_message(81);
    assert.equal(ykphone_split_view.refresh_for_messages([mine]), undefined);
    ykphone_split_view.set_route({page: "drafts", tab: "sent", selection: undefined});
    assert.equal(ykphone_split_view.refresh_for_messages([mine]), "reload");
    assert.equal(ykphone_split_view.refresh_for_messages([theirs]), undefined);
    ykphone_split_view.set_route({page: "drafts", tab: "drafts", selection: undefined});
    assert.equal(ykphone_split_view.refresh_for_messages([mine]), undefined);
    ykphone_split_view.set_route({page: "unreads", tab: "all", selection: undefined});
    assert.equal(ykphone_split_view.refresh_for_messages([theirs]), "reload");
    assert.equal(ykphone_split_view.refresh_for_messages([]), undefined);

    // A tab of these pages is fetched on its own.
    assert.equal(
        ykphone_split_view.plan_show(
            {page: "drafts", tab: "drafts", selection: undefined},
            {page: "drafts", tab: "sent", selection: undefined},
        ),
        "tab",
    );
});
