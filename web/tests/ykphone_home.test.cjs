"use strict";

const assert = require("node:assert/strict");

const {mock_esm, set_global, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

let recent_places = [];
let sidebar_stream_ids = [];
let unread_stream_ids = new Set();
const subs = new Map();
const valid_user_ids = new Set([7, 8]);
let current_filter;

mock_esm("../src/browser_history", {
    get_full_url: (hash) => `http://zulip.test/${hash}`,
});
mock_esm("../src/narrow_state", {
    filter: () => current_filter,
});
mock_esm("../src/stream_list_sort", {
    get_stream_ids: () => sidebar_stream_ids,
});
// describe() is where "can this still be opened?" lives: a channel the
// user left or that was archived, or a person who is gone, has no view.
mock_esm("../src/ykphone_places", {
    is_open_channel: (stream_id) => subs.get(stream_id)?.subscribed === true,
    describe(place) {
        if (place.kind === "dm") {
            return place.user_ids.every((id) => valid_user_ids.has(id))
                ? {key: `dm:${place.user_ids}`, hash: `#narrow/dm/${place.user_ids}`}
                : undefined;
        }
        if (subs.get(place.stream_id)?.subscribed !== true) {
            return undefined;
        }
        const topic = place.kind === "thread" ? place.topic : "";
        return {
            key: `${place.kind}:${place.stream_id}:${topic}`,
            hash: `#narrow/channel/${place.stream_id}/topic/${topic}`,
        };
    },
    place_for_filter: (filter) => filter.place,
    place_key: (place) => JSON.stringify(place),
});
mock_esm("../src/ykphone_recents", {
    recent_entries: () => recent_places.map((place) => ({place, visited_at: 0})),
});
const ykphone_split_view = mock_esm("../src/ykphone_split_view", {
    is_open: () => false,
});
mock_esm("../src/ykphone_unread_badges", {
    channel_has_unread_general_chat: (stream_id) => unread_stream_ids.has(stream_id),
});

const ykphone_flags = zrequire("ykphone_flags");
const ykphone_home = zrequire("ykphone_home");

function add_sub(stream_id, opts = {}) {
    // An archived channel is not one the user can open either.
    subs.set(stream_id, {stream_id, subscribed: true, ...opts});
    if (opts.is_archived === true) {
        subs.set(stream_id, {stream_id, subscribed: false, is_archived: true});
    }
}

function reset() {
    ykphone_flags.set_channels_open_in_general_chat(true);
    recent_places = [];
    sidebar_stream_ids = [];
    unread_stream_ids = new Set();
    subs.clear();
    current_filter = undefined;
}

run_test("home_hash", () => {
    reset();
    // Nothing to go to: upstream's home view.
    assert.equal(ykphone_home.home_hash(), undefined);

    // A new user: the first channel in the sidebar ...
    add_sub(3);
    add_sub(4);
    add_sub(9, {subscribed: false});
    sidebar_stream_ids = [9, 3, 4];
    assert.equal(ykphone_home.home_hash(), "#narrow/channel/3/topic/");
    // ... or the first one with unread messages in its conversation.
    unread_stream_ids = new Set([9, 4]);
    assert.equal(ykphone_home.home_hash(), "#narrow/channel/4/topic/");

    // The last conversation viewed, skipping pages, channels the user
    // left or that were archived, and people who are gone.
    add_sub(5, {is_archived: true});
    recent_places = [
        {kind: "page", page: "activity"},
        {kind: "channel", stream_id: 9},
        {kind: "thread", stream_id: 5, topic: "old"},
        {kind: "channel", stream_id: 42},
        {kind: "dm", user_ids: [7, 99]},
        {kind: "thread", stream_id: 3, topic: "Plans"},
        {kind: "dm", user_ids: [7]},
    ];
    assert.equal(ykphone_home.home_hash(), "#narrow/channel/3/topic/Plans");
    recent_places.splice(5, 1);
    assert.equal(ykphone_home.home_hash(), "#narrow/dm/7");

    // Upstream's home view without the fork's layout.
    ykphone_flags.set_channels_open_in_general_chat(false);
    assert.equal(ykphone_home.home_hash(), undefined);
});

run_test("narrow_terms", () => {
    assert.deepEqual(ykphone_home.narrow_terms({kind: "dm", user_ids: [7, 8]}), [
        {operator: "dm", operand: [7, 8]},
    ]);
    assert.deepEqual(ykphone_home.narrow_terms({kind: "channel", stream_id: 3}), [
        {operator: "channel", operand: "3"},
        {operator: "topic", operand: ""},
    ]);
    assert.deepEqual(ykphone_home.narrow_terms({kind: "thread", stream_id: 3, topic: "Plans"}), [
        {operator: "channel", operand: "3"},
        {operator: "topic", operand: "Plans"},
    ]);
});

run_test("show_home_view", () => {
    reset();
    const shown = [];
    const replaced = [];
    const show_narrow = (terms, opts) => shown.push({terms, opts});
    set_global("window", {
        location: {hash: ""},
        history: {
            replaceState(_state, _title, url) {
                replaced.push(url);
            },
        },
    });

    assert.equal(ykphone_home.show_home_view(show_narrow, undefined), false);
    assert.deepEqual(shown, []);

    add_sub(3);
    sidebar_stream_ids = [3];
    // An empty URL takes the conversation's without a history entry.
    assert.equal(
        ykphone_home.show_home_view(show_narrow, {trigger: "hash change", then_select_id: 12}),
        true,
    );
    assert.deepEqual(replaced, ["http://zulip.test/#narrow/channel/3/topic/"]);
    assert.deepEqual(shown, [
        {
            terms: [
                {operator: "channel", operand: "3"},
                {operator: "topic", operand: ""},
            ],
            opts: {trigger: "hash change", then_select_id: 12, change_hash: false},
        },
    ]);

    // Behind an overlay opened by its URL, the URL stays.
    window.location.hash = "#settings";
    shown.length = 0;
    assert.equal(ykphone_home.show_home_view(show_narrow, undefined), true);
    assert.equal(replaced.length, 1);
    assert.deepEqual(shown[0].opts, {trigger: "ykphone home", change_hash: false});

    window.location.hash = "#";
    assert.equal(ykphone_home.show_home_view(show_narrow, undefined), true);
    assert.equal(replaced.length, 2);
});

run_test("go_home", ({override}) => {
    reset();
    const visited = [];
    const go_to_location = (hash) => visited.push(hash);

    assert.equal(ykphone_home.go_home(go_to_location), false);

    add_sub(3);
    recent_places = [{kind: "channel", stream_id: 3}];
    assert.equal(ykphone_home.go_home(go_to_location), true);
    assert.deepEqual(visited, ["#narrow/channel/3/topic/"]);

    // Already there: nothing to do, and no second history entry.
    current_filter = {place: {kind: "channel", stream_id: 3}};
    assert.equal(ykphone_home.go_home(go_to_location), true);
    assert.equal(visited.length, 1);

    // The same conversation inside a split page is not Home.
    override(ykphone_split_view, "is_open", () => true);
    assert.equal(ykphone_home.go_home(go_to_location), true);
    assert.equal(visited.length, 2);
    override(ykphone_split_view, "is_open", () => false);

    // Elsewhere (a search, a feed), Home is a navigation.
    current_filter = {place: undefined};
    assert.equal(ykphone_home.go_home(go_to_location), true);
    assert.equal(visited.length, 3);
});
