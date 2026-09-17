"use strict";

const assert = require("node:assert/strict");

const {make_user} = require("./lib/example_user.cjs");
const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const {page_params} = require("./lib/zpage_params.cjs");

// ykphone_places is real: its schema and keys are what is stored and
// read back.
const {localstorage} = zrequire("localstorage");
const {set_current_user} = zrequire("state_data");
const ykphone_recents = zrequire("ykphone_recents");

function fake_filter(term_types) {
    return {
        is_conversation_view: () => false,
        sorted_term_types: () => term_types,
    };
}

const me = make_user({user_id: 5});
const other = make_user({user_id: 6});

function places() {
    return ykphone_recents.recent_entries().map((entry) => entry.place);
}

run_test("note_visit", () => {
    set_current_user(me);
    window.localStorage.clear();
    assert.deepEqual(ykphone_recents.recent_entries(), []);

    ykphone_recents.note_visit({kind: "channel", stream_id: 3}, 1000);
    ykphone_recents.note_visit({kind: "page", page: "activity"}, 2000);
    ykphone_recents.note_visit({kind: "thread", stream_id: 3, topic: "Plans"}, 3000);
    // Visiting a place again moves it to the top rather than adding it
    // twice; a thread's topic is compared without case.
    ykphone_recents.note_visit({kind: "channel", stream_id: 3}, 4000);
    ykphone_recents.note_visit({kind: "thread", stream_id: 3, topic: "plans"}, 5000);
    assert.deepEqual(ykphone_recents.recent_entries(), [
        {place: {kind: "thread", stream_id: 3, topic: "plans"}, visited_at: 5000},
        {place: {kind: "channel", stream_id: 3}, visited_at: 4000},
        {place: {kind: "page", page: "activity"}, visited_at: 2000},
    ]);

    // Each user has a history of their own.
    set_current_user(other);
    assert.deepEqual(ykphone_recents.recent_entries(), []);
    set_current_user(me);

    // The oldest go once there are more than the limit.
    for (let stream_id = 100; stream_id < 100 + ykphone_recents.MAX_RECENT_PLACES; stream_id += 1) {
        ykphone_recents.note_visit({kind: "channel", stream_id});
    }
    assert.equal(places().length, ykphone_recents.MAX_RECENT_PLACES);
    assert.deepEqual(places()[0], {
        kind: "channel",
        stream_id: 100 + ykphone_recents.MAX_RECENT_PLACES - 1,
    });
    assert.ok(!places().some((place) => place.kind === "thread"));
});

run_test("unreadable storage", () => {
    set_current_user(me);
    window.localStorage.clear();
    localstorage().set("ykphone-recent-places-5", {not: "a list"});
    assert.deepEqual(ykphone_recents.recent_entries(), []);

    // An entry from another version is skipped, the rest kept.
    localstorage().set("ykphone-recent-places-5", [
        {place: {kind: "page", page: "inbox"}, visited_at: 1},
        {place: {kind: "dm", user_ids: [7]}, visited_at: 2},
    ]);
    assert.deepEqual(places(), [{kind: "dm", user_ids: [7]}]);
});

run_test("note_narrow", () => {
    set_current_user(me);
    window.localStorage.clear();
    ykphone_recents.note_narrow(undefined);
    // A search is not a place.
    ykphone_recents.note_narrow(fake_filter(["search"]));
    assert.deepEqual(places(), []);

    ykphone_recents.note_narrow(fake_filter(["has-attachment"]));
    assert.deepEqual(places(), [{kind: "page", page: "files"}]);

    // Spectators have no history.
    page_params.is_spectator = true;
    ykphone_recents.note_narrow(fake_filter(["is-starred"]));
    assert.deepEqual(places(), [{kind: "page", page: "files"}]);
    page_params.is_spectator = false;
});
