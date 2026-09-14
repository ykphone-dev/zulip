"use strict";

const assert = require("node:assert/strict");

const {set_global, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const $ = require("./lib/zjquery.cjs");

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
