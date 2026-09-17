"use strict";

const assert = require("node:assert/strict");

const {make_user, Role} = require("./lib/example_user.cjs");
const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const me = make_user({user_id: 5, full_name: "Me"});
const admin = make_user({user_id: 5, full_name: "Me", role: Role.ADMINISTRATOR});

const users = new Map([
    [5, {user_id: 5, full_name: "Me"}],
    [7, {user_id: 7, full_name: "Hamlet"}],
    [8, {user_id: 8, full_name: "Cordelia"}],
]);
function sub(stream_id, name, opts = {}) {
    return [
        stream_id,
        {
            stream_id,
            name,
            invite_only: false,
            is_web_public: false,
            subscribed: true,
            is_archived: false,
            ...opts,
        },
    ];
}
const subs = new Map([
    sub(3, "Verona"),
    sub(4, "secret", {invite_only: true}),
    sub(6, "open", {is_web_public: true}),
    // A channel the user left, and one the organization archived.
    sub(7, "left", {subscribed: false}),
    sub(8, "gone", {is_archived: true}),
]);

mock_esm("../src/hash_util", {
    by_stream_topic_url: (stream_id, topic) => `#narrow/channel/${stream_id}/topic/${topic}`,
    pm_with_url: (user_ids_string) => `#narrow/dm/${user_ids_string}`,
});
const narrow_state = mock_esm("../src/narrow_state");
mock_esm("../src/people", {
    sorted_other_user_ids(user_ids) {
        const others = user_ids.filter((user_id) => user_id !== me.user_id);
        return (others.length > 0 ? others : [me.user_id]).toSorted((a, b) => a - b);
    },
    is_valid_user_ids: (user_ids) => user_ids.every((user_id) => users.has(user_id)),
    format_recipients: (user_ids_string) =>
        user_ids_string
            .split(",")
            .map((id) => users.get(Number(id)).full_name)
            .join(", "),
    get_by_user_id: (user_id) => users.get(user_id),
    small_avatar_url_for_person: (person) => `/avatar/${person.user_id}`,
});
mock_esm("../src/stream_data", {
    get_sub_by_id: (stream_id) => subs.get(stream_id),
});
const ykphone_split_view = mock_esm("../src/ykphone_split_view", {
    get_route: () => undefined,
    page_title: (page) => `title:${page}`,
    page_icon: (page) => `icon:${page}`,
    page_hash: (page) => `#ykphone/${page}`,
});

const {set_current_user} = zrequire("state_data");
const ykphone_places = zrequire("ykphone_places");

set_current_user(me);

function fake_filter({conversation = false, term_types = []} = {}) {
    return {
        is_conversation_view: () => conversation,
        sorted_term_types: () => term_types,
    };
}

run_test("place keys", () => {
    assert.equal(ykphone_places.place_key(ykphone_places.channel_place(3)), "channel:3");
    assert.equal(ykphone_places.place_key(ykphone_places.dm_place([8, 7, 5])), "dm:7,8");
    // A conversation with oneself is kept under one's own id.
    assert.equal(ykphone_places.place_key(ykphone_places.dm_place([5])), "dm:5");
    // Topics are case-insensitive, so a thread is one place however
    // it is spelled.
    assert.equal(
        ykphone_places.place_key({kind: "thread", stream_id: 3, topic: "Plans"}),
        ykphone_places.place_key({kind: "thread", stream_id: 3, topic: "plans"}),
    );
    assert.equal(ykphone_places.place_key(ykphone_places.page_place("activity")), "page:activity");

    assert.ok(ykphone_places.is_conversation(ykphone_places.channel_place(3)));
    assert.ok(!ykphone_places.is_conversation(ykphone_places.page_place("files")));

    // The stored form is validated when it is read back.
    assert.ok(ykphone_places.place_schema.safeParse({kind: "page", page: "threads"}).success);
    assert.ok(!ykphone_places.place_schema.safeParse({kind: "page", page: "inbox"}).success);

    // A page named by one of our own rows.
    assert.deepEqual(ykphone_places.page_place_from_id("drafts"), {kind: "page", page: "drafts"});
    assert.equal(ykphone_places.page_place_from_id("inbox"), undefined);
    assert.equal(ykphone_places.page_place_from_id(undefined), undefined);
});

run_test("place_for_filter", ({override}) => {
    let pm_ids;
    let stream_id;
    let topic;
    override(narrow_state, "pm_ids", () => pm_ids);
    override(narrow_state, "stream_id", (_filter, only_valid_id) => {
        assert.ok(only_valid_id);
        return stream_id;
    });
    override(narrow_state, "topic", () => topic);
    const conversation = fake_filter({conversation: true});

    pm_ids = [7, 5];
    assert.deepEqual(ykphone_places.place_for_filter(conversation), {kind: "dm", user_ids: [7]});

    pm_ids = undefined;
    stream_id = 3;
    topic = "";
    assert.deepEqual(ykphone_places.place_for_filter(conversation), {
        kind: "channel",
        stream_id: 3,
    });
    topic = "Plans";
    assert.deepEqual(ykphone_places.place_for_filter(conversation), {
        kind: "thread",
        stream_id: 3,
        topic: "Plans",
    });
    // A channel this user cannot see.
    stream_id = undefined;
    assert.equal(ykphone_places.place_for_filter(conversation), undefined);
    stream_id = 3;
    topic = undefined;
    assert.equal(ykphone_places.place_for_filter(conversation), undefined);

    assert.deepEqual(
        ykphone_places.place_for_filter(fake_filter({term_types: ["has-attachment"]})),
        {kind: "page", page: "files"},
    );
    assert.deepEqual(ykphone_places.place_for_filter(fake_filter({term_types: ["is-starred"]})), {
        kind: "page",
        page: "saved",
    });
    // Searches and the other feeds are not places.
    assert.equal(ykphone_places.place_for_filter(fake_filter({term_types: ["search"]})), undefined);
});

run_test("current_view_place", ({override}) => {
    override(narrow_state, "filter", () => undefined);
    assert.equal(ykphone_places.current_view_place(), undefined);

    override(narrow_state, "filter", () => fake_filter({term_types: ["is-starred"]}));
    assert.deepEqual(ykphone_places.current_view_place(), {kind: "page", page: "saved"});

    // A split page is the place even with a conversation beside it.
    override(ykphone_split_view, "get_route", () => ({page: "dms", selection: "7"}));
    assert.deepEqual(ykphone_places.current_view_place(), {kind: "page", page: "dms"});

    // A search results page is not a place to return to: its results
    // go stale, and Home should not land on an old query.
    override(ykphone_split_view, "get_route", () => ({page: "search", query: "예산"}));
    assert.equal(ykphone_places.current_view_place(), undefined);
});

run_test("describe conversations", () => {
    assert.deepEqual(ykphone_places.describe(ykphone_places.channel_place(3)), {
        key: "channel:3",
        kind: "channel",
        title: "Verona",
        context: undefined,
        icon: "hashtag",
        avatar_url: undefined,
        hash: "#narrow/channel/3/topic/",
    });
    assert.equal(ykphone_places.describe(ykphone_places.channel_place(4)).icon, "lock");
    assert.equal(ykphone_places.describe(ykphone_places.channel_place(6)).icon, "globe");
    // A channel that is gone, one the user left and one that was
    // archived cannot be opened, so no list offers them.
    for (const stream_id of [99, 7, 8]) {
        assert.equal(ykphone_places.describe(ykphone_places.channel_place(stream_id)), undefined);
        assert.equal(ykphone_places.describe({kind: "thread", stream_id, topic: "x"}), undefined);
        assert.equal(ykphone_places.is_open_channel(stream_id), false);
    }
    assert.equal(ykphone_places.is_open_channel(3), true);

    assert.deepEqual(ykphone_places.describe({kind: "thread", stream_id: 3, topic: "Plans"}), {
        key: "thread:3:plans",
        kind: "thread",
        title: "Plans",
        context: "#Verona",
        icon: "threads",
        avatar_url: undefined,
        hash: "#narrow/channel/3/topic/Plans",
    });
    assert.equal(ykphone_places.describe({kind: "thread", stream_id: 99, topic: "x"}), undefined);

    assert.deepEqual(ykphone_places.describe(ykphone_places.dm_place([7])), {
        key: "dm:7",
        kind: "dm",
        title: "Hamlet",
        context: undefined,
        icon: "user",
        avatar_url: "/avatar/7",
        hash: "#narrow/dm/7",
    });
    const group = ykphone_places.describe(ykphone_places.dm_place([7, 8]));
    assert.equal(group.title, "Hamlet, Cordelia");
    assert.equal(group.icon, "users");
    assert.equal(group.avatar_url, undefined);
    // Someone who is gone, or no one.
    assert.equal(ykphone_places.describe({kind: "dm", user_ids: [7, 42]}), undefined);
    assert.equal(ykphone_places.describe({kind: "dm", user_ids: []}), undefined);
});

run_test("describe pages", () => {
    set_current_user(me);
    const views = Object.fromEntries(
        [
            "dms",
            "activity",
            "threads",
            "files",
            "saved",
            "drafts",
            "scheduled",
            "reminders",
            "settings",
            "admin",
        ].map((page) => [page, ykphone_places.describe(ykphone_places.page_place(page))]),
    );
    assert.deepEqual(views.dms, {
        key: "page:dms",
        kind: "page",
        context: undefined,
        avatar_url: undefined,
        title: "title:dms",
        icon: "icon:dms",
        hash: "#ykphone/dms",
    });
    assert.equal(views.threads.hash, "#ykphone/threads");
    assert.equal(views.activity.hash, "#ykphone/activity");
    assert.deepEqual(
        [views.files.title, views.files.hash],
        ["translated: Files", "#narrow/has/attachment"],
    );
    assert.deepEqual(
        [views.saved.title, views.saved.hash],
        ["translated: Later", "#narrow/is/starred"],
    );
    assert.equal(views.drafts.hash, "#drafts");
    assert.equal(views.scheduled.hash, "#scheduled");
    assert.equal(views.reminders.hash, "#reminders");
    assert.equal(views.settings.hash, "#settings");
    // Only administrators are offered the admin pages.
    assert.equal(views.admin, undefined);
    set_current_user(admin);
    assert.equal(ykphone_places.describe(ykphone_places.page_place("admin")).hash, "#organization");
    set_current_user(me);
});
