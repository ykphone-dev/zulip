"use strict";

const assert = require("node:assert/strict");

const {set_global, zrequire} = require("./lib/namespace.cjs");
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

run_test("track_feed_bottom", () => {
    const set_properties = [];
    let compose_height = 84.5;
    let banner_height = 0;
    const compose = {
        getBoundingClientRect: () => ({height: compose_height}),
    };
    const banner = {
        getBoundingClientRect: () => ({height: banner_height}),
    };
    // Enough content to scroll, with the window resting at the end of
    // it — what a reader who has just opened a conversation sees.
    const root = {
        scrollTop: 100,
        clientHeight: 900,
        scrollHeight: 1000,
        style: {
            setProperty(name, value) {
                set_properties.push([name, value]);
            },
        },
    };
    const elements = new Map([
        ["#compose", compose],
        ["#mark_read_on_scroll_state_banner", banner],
    ]);
    const fire = new Map();
    set_global("document", {
        querySelector: (selector) => elements.get(selector) ?? null,
        documentElement: root,
    });
    set_global(
        "ResizeObserver",
        class ResizeObserver {
            constructor(callback) {
                this.callback = callback;
            }

            observe(element) {
                fire.set(element, () => {
                    this.callback();
                });
                // The observer fires once when it starts observing.
                this.callback();
            }
        },
    );

    ykphone_layout.track_feed_bottom();
    assert.deepEqual(set_properties, [["--yk-compose-height", "84.5px"]]);
    // The first measurement is the page as it loaded, not growth: a
    // reader near the end is not pushed down by the box's height.
    assert.equal(root.scrollTop, 100);
    root.scrollTop = 184.5;

    // Typing another line grows the box and the document with it; the
    // window follows again.
    compose_height = 104.5;
    root.scrollHeight = 1020;
    root.scrollTop = 184.5;
    fire.get(compose)();
    assert.equal(root.scrollTop, 204.5);

    // A reader who has scrolled up to read is left where they are.
    compose_height = 124.5;
    root.scrollHeight = 1040;
    root.scrollTop = 0;
    fire.get(compose)();
    assert.equal(root.scrollTop, 0);

    // Deleting the text again shrinks the box; the browser clamps the
    // scroll position on its own, so there is nothing to follow.
    compose_height = 84.5;
    root.scrollTop = 50;
    fire.get(compose)();
    assert.equal(root.scrollTop, 50);
    assert.deepEqual(set_properties.at(-1), ["--yk-compose-height", "84.5px"]);

    // The mark-as-read banner appearing under a reader at the bottom
    // takes the window along too, without touching the compose height.
    const properties_before_banner = set_properties.length;
    banner_height = 62;
    root.scrollHeight = 1062;
    root.scrollTop = 100;
    fire.get(banner)();
    assert.equal(root.scrollTop, 162);
    assert.equal(set_properties.length, properties_before_banner);

    // A page without the banner still tracks the compose box.
    elements.delete("#mark_read_on_scroll_state_banner");
    ykphone_layout.track_feed_bottom();
    assert.equal(set_properties.length, properties_before_banner + 1);

    // A browser without ResizeObserver, and a page whose compose box
    // is not mounted, both leave the theme's own value standing.
    const before = set_properties.length;
    set_global("ResizeObserver", undefined);
    ykphone_layout.track_feed_bottom();
    set_global("document", {querySelector: () => null});
    ykphone_layout.track_feed_bottom();
    assert.equal(set_properties.length, before);
});

run_test("keep_feed_end_in_place", () => {
    // A long conversation scrolled to its end: an intro of 214px goes in
    // above it, and the window moves with the content it was showing.
    let writes = 0;
    let scroll_top = 57;
    const root = {
        scrollHeight: 957,
        get scrollTop() {
            return scroll_top;
        },
        set scrollTop(value) {
            writes += 1;
            scroll_top = value;
        },
    };
    set_global("document", {documentElement: root});
    ykphone_layout.keep_feed_end_in_place(() => {
        root.scrollHeight += 214;
    });
    assert.equal(root.scrollTop, 271);
    assert.equal(writes, 1);

    // A change that does not alter the document's height (a short
    // conversation, where the spacer absorbs it, or a header re-rendered
    // for a count) does not touch the scroll position at all.
    ykphone_layout.keep_feed_end_in_place(() => {});
    assert.equal(root.scrollTop, 271);
    assert.equal(writes, 1);
});
