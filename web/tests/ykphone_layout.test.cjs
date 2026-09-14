"use strict";

const assert = require("node:assert/strict");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const $ = require("./lib/zjquery.cjs");
const {page_params} = require("./lib/zpage_params.cjs");

const {localstorage} = zrequire("localstorage");
const ykphone_layout = zrequire("ykphone_layout");

run_test("pane_header_height", () => {
    $.clear_all_elements();
    // Before the header is mounted there is nothing to add.
    assert.equal(ykphone_layout.pane_header_height(), 0);

    $("#ykphone-pane-header").set_height(46);
    assert.equal(ykphone_layout.pane_header_height(), 46);
});

run_test("reorder_left_sidebar_sections", () => {
    $.clear_all_elements();
    const $streams_list = $("#streams_list");
    let moved_before_dm_header;
    $.create("#direct-messages-section-header", {
        elements: [
            {
                before(node) {
                    moved_before_dm_header = node;
                },
            },
        ],
    });

    ykphone_layout.reorder_left_sidebar_sections();
    assert.equal(moved_before_dm_header, $streams_list[0]);
});

run_test("hide_member_list_by_default", () => {
    const ls = localstorage();
    const $body = $("body");

    function reset() {
        window.localStorage.clear();
        $body.removeClass("hide-right-sidebar");
    }

    // A user who has never toggled the member list starts without it.
    reset();
    page_params.is_spectator = false;
    ykphone_layout.hide_member_list_by_default();
    assert.ok($body.hasClass("hide-right-sidebar"));

    // Either saved choice is left alone.
    for (const saved of [true, false]) {
        reset();
        ls.set("right-sidebar", saved);
        ykphone_layout.hide_member_list_by_default();
        assert.equal($body.hasClass("hide-right-sidebar"), false);
    }

    // Spectators never see the member list; upstream ignores the key
    // for them, and so does the default.
    reset();
    page_params.is_spectator = true;
    ykphone_layout.hide_member_list_by_default();
    assert.equal($body.hasClass("hide-right-sidebar"), false);
    page_params.is_spectator = false;
});
