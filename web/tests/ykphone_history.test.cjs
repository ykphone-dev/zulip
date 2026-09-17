"use strict";

const assert = require("node:assert/strict");

const {mock_esm, set_global, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const $ = require("./lib/zjquery.cjs");

let recent_entries = [];
mock_esm("../src/timerender", {
    relative_time_string_from_date: (date) => `at ${date.getTime()}`,
});
mock_esm("../src/ykphone_places", {
    describe: (place) =>
        place.stream_id === 42
            ? undefined
            : {key: `channel:${place.stream_id}`, title: `channel ${place.stream_id}`},
    place_key: (place) => `channel:${place.stream_id}`,
});
mock_esm("../src/ykphone_recents", {
    recent_entries: () => recent_entries,
});

const ykphone_history = zrequire("ykphone_history");

function button_state() {
    return {
        back: !$(".ykphone-navbar-back").prop("disabled"),
        forward: !$(".ykphone-navbar-forward").prop("disabled"),
    };
}

run_test("hashchange fallback", () => {
    ykphone_history.clear_for_testing();
    $.clear_all_elements();
    const traversals = [];
    // No Navigation API: an old browser.
    set_global("window", {
        history: {
            back() {
                traversals.push("back");
            },
            forward() {
                traversals.push("forward");
            },
        },
        to_$: () => $("window-stub"),
    });

    ykphone_history.initialize();
    // A fresh load has nowhere to go; Back never leaves the app.
    assert.deepEqual(button_state(), {back: false, forward: false});
    assert.equal($(".ykphone-navbar-back").attr("aria-disabled"), "true");
    ykphone_history.go_back();
    ykphone_history.go_forward();
    assert.deepEqual(traversals, []);

    // Two in-app navigations.
    $("window-stub").trigger("hashchange");
    $("window-stub").trigger("hashchange");
    assert.deepEqual(button_state(), {back: true, forward: false});
    assert.equal($(".ykphone-navbar-back").attr("aria-disabled"), "false");

    // Back, then Forward, through the browser history.
    ykphone_history.go_back();
    assert.deepEqual(traversals, ["back"]);
    $("window-stub").trigger("hashchange");
    assert.deepEqual(button_state(), {back: true, forward: true});
    ykphone_history.go_back();
    $("window-stub").trigger("hashchange");
    assert.deepEqual(button_state(), {back: false, forward: true});
    ykphone_history.go_forward();
    assert.deepEqual(traversals, ["back", "back", "forward"]);
    $("window-stub").trigger("hashchange");
    assert.deepEqual(button_state(), {back: true, forward: true});

    // A new navigation drops the forward entries.
    $("window-stub").trigger("hashchange");
    assert.deepEqual(button_state(), {back: true, forward: false});
});

run_test("navigation api", () => {
    ykphone_history.clear_for_testing();
    $.clear_all_elements();
    const traversals = [];
    let listener;
    // The login page, two app entries, another site.
    const entries = [
        {sameDocument: false},
        {sameDocument: true},
        {sameDocument: true},
        {sameDocument: false},
    ];
    const navigation = {
        currentEntry: {index: 1},
        entries: () => entries,
        addEventListener(type, f) {
            assert.equal(type, "currententrychange");
            listener = f;
        },
    };
    set_global("window", {
        navigation,
        history: {
            back() {
                traversals.push("back");
            },
            forward() {
                traversals.push("forward");
            },
        },
    });

    ykphone_history.initialize();
    // Behind the first app entry is the login page: no Back.
    assert.deepEqual(button_state(), {back: false, forward: true});
    ykphone_history.go_back();
    assert.deepEqual(traversals, []);
    ykphone_history.go_forward();
    assert.deepEqual(traversals, ["forward"]);

    navigation.currentEntry = {index: 2};
    listener();
    // Ahead is another site: no Forward.
    assert.deepEqual(button_state(), {back: true, forward: false});
    ykphone_history.go_forward();
    assert.deepEqual(traversals, ["forward"]);
    ykphone_history.go_back();
    assert.deepEqual(traversals, ["forward", "back"]);

    // Before the first entry has settled there is no current entry.
    navigation.currentEntry = null;
    listener();
    assert.deepEqual(button_state(), {back: false, forward: false});
});

run_test("menu_items", () => {
    recent_entries = [
        {place: {kind: "channel", stream_id: 3}, visited_at: 3000},
        // A channel that is gone is left out.
        {place: {kind: "channel", stream_id: 42}, visited_at: 2000},
        {place: {kind: "channel", stream_id: 4}, visited_at: 1000},
    ];
    assert.deepEqual(ykphone_history.menu_items({kind: "channel", stream_id: 4}), [
        {key: "channel:3", title: "channel 3", time_label: "at 3000", is_current: false},
        {key: "channel:4", title: "channel 4", time_label: "at 1000", is_current: true},
    ]);
    assert.deepEqual(
        ykphone_history.menu_items(undefined).map((item) => item.is_current),
        [false, false],
    );
});
