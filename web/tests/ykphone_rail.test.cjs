"use strict";

const assert = require("node:assert/strict");

const {make_realm} = require("./lib/example_realm.cjs");
const {make_user, Role} = require("./lib/example_user.cjs");
const {mock_esm, set_global, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const $ = require("./lib/zjquery.cjs");

const left_sidebar_navigation_area = mock_esm("../src/left_sidebar_navigation_area");

const {set_current_user, set_realm} = zrequire("state_data");
const ykphone_rail = zrequire("ykphone_rail");

set_realm(make_realm({realm_name: "옆커폰"}));

const member = make_user({user_id: 7, avatar_url_medium: "/avatar/7/medium"});
const admin = make_user({user_id: 8, role: Role.ADMINISTRATOR});

function item_ids() {
    return ykphone_rail.rail_items().map((item) => item.id);
}

run_test("items", () => {
    set_current_user(member);
    assert.deepEqual(item_ids(), ["home", "dm", "activity", "files"]);
    const [home, dm, activity, files] = ykphone_rail.rail_items();
    assert.equal(home.label, "translated: Home");
    // Home is the last conversation, resolved from the empty URL.
    assert.equal(home.href, "#");
    assert.equal(dm.href, "#ykphone/dms");
    assert.equal(dm.icon, "ykphone-rail-dm");
    assert.equal(dm.filled_icon, "ykphone-rail-dm-filled");
    assert.equal(activity.href, "#ykphone/activity");
    assert.equal(activity.icon, "ykphone-rail-bell");
    assert.equal(files.href, "#narrow/has/attachment");
    assert.equal(files.label, "translated: Files");

    // The admin panel is only offered to administrators.
    set_current_user(admin);
    assert.deepEqual(item_ids(), ["home", "dm", "activity", "files", "admin"]);
    assert.equal(ykphone_rail.rail_items()[4].href, "#organization");
});

run_test("active_item_id", () => {
    set_current_user(admin);
    // Every conversation is in Home, as is upstream's Inbox.
    assert.equal(ykphone_rail.active_item_id("#inbox"), "home");
    assert.equal(ykphone_rail.active_item_id("#narrow/channel/3-Verona/topic/"), "home");
    assert.equal(ykphone_rail.active_item_id("#narrow/stream/3-Verona"), "home");
    assert.equal(ykphone_rail.active_item_id("#narrow/dm/7-user"), "home");
    assert.equal(ykphone_rail.active_item_id("#narrow/pm-with/7-user"), "home");
    assert.equal(ykphone_rail.active_item_id("#ykphone/dms"), "dm");
    assert.equal(ykphone_rail.active_item_id("#ykphone/dms/7,9"), "dm");
    // Upstream's direct message feed is not the DM page.
    assert.equal(ykphone_rail.active_item_id("#narrow/is/dm"), undefined);
    assert.equal(ykphone_rail.active_item_id("#ykphone/activity"), "activity");
    assert.equal(ykphone_rail.active_item_id("#narrow/has/attachment"), "files");
    // The mention narrow is no longer a rail view.
    assert.equal(ykphone_rail.active_item_id("#narrow/is/mentioned"), undefined);
    // Overlays are matched by prefix, so any settings section counts.
    assert.equal(ykphone_rail.active_item_id("#organization/users"), "admin");
    assert.equal(ykphone_rail.active_item_id("#recent"), undefined);

    // The empty hash means Home.
    assert.equal(ykphone_rail.active_item_id(""), "home");
    assert.equal(ykphone_rail.active_item_id("#"), "home");

    // Without the admin item nothing is active on the admin pages.
    set_current_user(member);
    assert.equal(ykphone_rail.active_item_id("#organization"), undefined);
});

run_test("update_active_item", () => {
    set_current_user(member);
    $.clear_all_elements();
    // The collection selector resolves to the same elements as the
    // per-item selectors, as in the browser, so clearing through the
    // collection is observable on each item.
    const items = Object.fromEntries(
        ["home", "dm", "activity"].map((id) => [
            id,
            $.create(`#ykphone-rail .ykphone-rail-item[data-rail-item="${id}"]`),
        ]),
    );
    $.create("#ykphone-rail .ykphone-rail-item", {
        elements: Object.values(items).map(($item) => $item[0]),
    });
    const active_ids = () =>
        Object.entries(items)
            .filter(([, $item]) => $item.hasClass("active"))
            .map(([id]) => id);

    ykphone_rail.update_active_item("#ykphone/dms");
    assert.deepEqual(active_ids(), ["dm"]);
    assert.equal(items.dm.attr("aria-current"), "page");
    assert.equal(items.home.attr("aria-current"), undefined);

    ykphone_rail.update_active_item("#inbox");
    assert.deepEqual(active_ids(), ["home"]);
    assert.equal(items.dm.attr("aria-current"), undefined);
    assert.equal(items.home.attr("aria-current"), "page");

    ykphone_rail.update_active_item("#recent");
    assert.deepEqual(active_ids(), []);
});

run_test("mount", ({override, mock_template}) => {
    set_current_user(member);
    $.clear_all_elements();
    set_global("window", {
        location: {hash: "#ykphone/dms"},
        to_$: () => $("window-stub"),
    });

    let rail_html;
    mock_template("ykphone_rail.hbs", true, (data, html) => {
        assert.deepEqual(
            data.items.map((item) => item.id),
            ["home", "dm", "activity", "files"],
        );
        assert.equal(data.avatar_url, "/avatar/7/medium");
        rail_html = html;
        return html;
    });
    let header_html;
    mock_template("ykphone_sidebar_header.hbs", true, (data, html) => {
        assert.equal(data.realm_name, "옆커폰");
        header_html = html;
        return html;
    });
    let history_html;
    mock_template("ykphone_navbar_history.hbs", true, (_data, html) => {
        history_html = html;
        return html;
    });
    let navbar_left_child;
    $.create("#top_navbar .column-left", {
        elements: [
            {
                append(node) {
                    navbar_left_child = node;
                },
            },
        ],
    });

    const prepended = new Map();
    for (const container of ["#left-sidebar-container", "#left-sidebar-search"]) {
        $.create(container, {
            elements: [
                {
                    prepend(node) {
                        prepended.set(container, node);
                    },
                },
            ],
        });
    }
    let logo_child;
    $.create("#ykphone-rail .ykphone-rail-logo", {
        elements: [
            {
                append(node) {
                    logo_child = node;
                },
            },
        ],
    });
    const $brand = $("#top_navbar .column-left .brand");
    const $search_input = $(".left-sidebar-search-input");
    let views_expanded = 0;
    override(left_sidebar_navigation_area, "force_expand_views", () => {
        views_expanded += 1;
    });
    const $dm = $('#ykphone-rail .ykphone-rail-item[data-rail-item="dm"]');
    const $home = $('#ykphone-rail .ykphone-rail-item[data-rail-item="home"]');
    const $threads_icon = $(".top_left_recent_view .zulip-icon-recent");
    $threads_icon.addClass("zulip-icon-recent");
    const $threads_link = $(".top_left_recent_view .left-sidebar-navigation-label-container");
    $threads_link.attr("href", "#recent");

    ykphone_rail.mount();

    assert.ok(rail_html.includes('data-rail-item="dm"'));
    // Each item carries the outline glyph and its filled twin.
    assert.ok(
        rail_html.includes(
            "zulip-icon-ykphone-rail-bell ykphone-rail-glyph ykphone-rail-glyph-outline",
        ),
    );
    assert.ok(
        rail_html.includes(
            "zulip-icon-ykphone-rail-bell-filled ykphone-rail-glyph ykphone-rail-glyph-filled",
        ),
    );
    assert.ok(rail_html.includes("zulip-icon-ykphone-rail-file "));
    // The sidebar's Threads row shares the thread pill's icon and leads
    // to the Threads page.
    assert.ok(!$threads_icon.hasClass("zulip-icon-recent"));
    assert.ok($threads_icon.hasClass("zulip-icon-threads"));
    assert.equal($threads_link.attr("href"), "#ykphone/threads");
    assert.ok(!rail_html.includes('data-rail-item="admin"'));
    assert.equal(prepended.get("#left-sidebar-container"), $(rail_html)[0]);
    assert.ok(header_html.includes("옆커폰"));
    assert.equal(prepended.get("#left-sidebar-search"), $(header_html)[0]);
    // The navbar logo is moved into the rail and points at the home
    // view, with its own tooltip.
    assert.equal(logo_child, $brand[0]);
    assert.equal($brand.attr("href"), "#");
    assert.ok($brand.hasClass("tippy-zulip-tooltip"));
    assert.equal($brand.attr("data-tippy-content"), "translated: Home");
    // The VIEWS header is hidden, so the section is kept expanded.
    assert.equal(views_expanded, 1);
    assert.equal($search_input.attr("placeholder"), "translated: Find a conversation…");
    // Slack's history controls take the navbar's left column, and the
    // search box names the organization.
    assert.equal(navbar_left_child, $(history_html)[0]);
    assert.ok(history_html.includes("ykphone-navbar-back"));
    assert.ok(history_html.includes("ykphone-navbar-forward"));
    // The clock opens the History dropdown rather than a view.
    assert.ok(history_html.includes("ykphone-navbar-history-menu"));
    assert.ok(!history_html.includes('href="#recent"'));
    assert.equal($("#search_query").attr("data-placeholder-text"), "translated: Search 옆커폰");
    assert.ok($dm.hasClass("active"));

    // Later hash changes and narrows update the active item.
    window.location.hash = "#inbox";
    $("window-stub").trigger("hashchange");
    assert.ok($home.hasClass("active"));
    window.location.hash = "#narrow/is/dm";
    ykphone_rail.handle_narrow_activated();
    assert.ok($dm.hasClass("active"));

    // Escaping: the organization name is rendered as text. (This
    // realm has presence turned off, so the rail's avatar has no dot.)
    $.clear_all_elements();
    set_realm(make_realm({realm_name: "<b>x</b>", realm_presence_disabled: true}));
    mock_template("ykphone_rail.hbs", false, (data) => {
        assert.equal(data.user_circle_class, undefined);
        return "<nav></nav>";
    });
    mock_template("ykphone_sidebar_header.hbs", true, (_data, html) => {
        assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"));
        return html;
    });
    for (const container of ["#left-sidebar-container", "#left-sidebar-search"]) {
        $.create(container, {elements: [{prepend() {}}]});
    }
    $.create("#ykphone-rail .ykphone-rail-logo", {elements: [{append() {}}]});
    ykphone_rail.mount();
});
