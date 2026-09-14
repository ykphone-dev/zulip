"use strict";

const assert = require("node:assert/strict");

const {make_realm} = require("./lib/example_realm.cjs");
const {make_user, Role} = require("./lib/example_user.cjs");
const {mock_esm, set_global, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const $ = require("./lib/zjquery.cjs");

const browser_history = mock_esm("../src/browser_history", {
    get_home_view_hash: () => "#inbox",
});
const channel = mock_esm("../src/channel", {
    xhr_error_message: (message, xhr) => `${message} ${xhr.responseJSON.msg}`,
});
const feedback_widget = mock_esm("../src/feedback_widget");
const left_sidebar_navigation_area = mock_esm("../src/left_sidebar_navigation_area");
const settings_data = mock_esm("../src/settings_data");

const {set_current_user, set_realm} = zrequire("state_data");
const {initialize_user_settings} = zrequire("user_settings");
const ykphone_rail = zrequire("ykphone_rail");

const user_settings = {color_scheme: 1};
initialize_user_settings({user_settings});

set_realm(make_realm({realm_name: "옆커폰"}));

const member = make_user({user_id: 7, avatar_url_medium: "/avatar/7/medium"});
const admin = make_user({user_id: 8, role: Role.ADMINISTRATOR});

function item_ids() {
    return ykphone_rail.rail_items().map((item) => item.id);
}

run_test("items", () => {
    set_current_user(member);
    assert.deepEqual(item_ids(), ["home", "dm", "activity"]);
    const [home, dm, activity] = ykphone_rail.rail_items();
    assert.equal(home.label, "translated: Home");
    assert.equal(home.href, "#inbox");
    assert.equal(dm.href, "#narrow/is/dm");
    assert.equal(activity.href, "#narrow/is/mentioned");

    // The admin panel is only offered to administrators.
    set_current_user(admin);
    assert.deepEqual(item_ids(), ["home", "dm", "activity", "admin"]);
    assert.equal(ykphone_rail.rail_items()[3].href, "#organization");
});

run_test("active_item_id", ({override}) => {
    set_current_user(admin);
    assert.equal(ykphone_rail.active_item_id("#inbox"), "home");
    assert.equal(ykphone_rail.active_item_id("#narrow/is/dm"), "dm");
    // A direct message conversation belongs to the DM tab too.
    assert.equal(ykphone_rail.active_item_id("#narrow/dm/7-user"), "dm");
    assert.equal(ykphone_rail.active_item_id("#narrow/is/mentioned"), "activity");
    // Overlays are matched by prefix, so any settings section counts.
    assert.equal(ykphone_rail.active_item_id("#organization/users"), "admin");
    assert.equal(ykphone_rail.active_item_id("#recent"), undefined);
    assert.equal(ykphone_rail.active_item_id("#narrow/channel/3-Verona"), undefined);

    // The empty hash means the home view, whatever it is set to.
    assert.equal(ykphone_rail.active_item_id(""), "home");
    assert.equal(ykphone_rail.active_item_id("#"), "home");
    override(browser_history, "get_home_view_hash", () => "#recent");
    assert.equal(ykphone_rail.active_item_id(""), undefined);

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

    ykphone_rail.update_active_item("#narrow/is/dm");
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

run_test("toggle_color_scheme", ({override}) => {
    ykphone_rail.clear_for_testing();
    const patches = [];
    override(channel, "patch", (opts) => {
        patches.push(opts);
    });
    const toasts = [];
    override(feedback_widget, "show", (opts) => {
        const $container = $.create(`toast-${toasts.length}`);
        opts.populate($container);
        toasts.push($container.text());
    });

    // 3 is the light theme, 2 the dark one (settings_config).
    override(settings_data, "using_dark_theme", () => true);
    ykphone_rail.toggle_color_scheme();
    assert.equal(patches[0].url, "/json/settings");
    assert.deepEqual(patches[0].data, {color_scheme: 3});

    // A second click before the server answers toggles back rather
    // than repeating the request, since the setting has not caught up.
    ykphone_rail.toggle_color_scheme();
    assert.deepEqual(patches[1].data, {color_scheme: 2});

    // Only the latest request's answer counts; it primes the setting
    // for the next click before the event arrives.
    user_settings.color_scheme = 2;
    patches[0].success();
    assert.equal(user_settings.color_scheme, 2);
    patches[1].success();
    assert.equal(user_settings.color_scheme, 2);
    override(settings_data, "using_dark_theme", () => false);
    ykphone_rail.toggle_color_scheme();
    assert.deepEqual(patches[2].data, {color_scheme: 2});

    // A failure is reported and forgotten, so the next click starts
    // again from the real setting.
    patches[2].error({responseJSON: {msg: "Server down"}});
    assert.deepEqual(toasts, ["translated: Failed to change the theme. Server down"]);
    ykphone_rail.toggle_color_scheme();
    assert.deepEqual(patches[3].data, {color_scheme: 2});

    // A stale failure (after a newer click) does not clear the newer request.
    ykphone_rail.toggle_color_scheme();
    assert.deepEqual(patches[4].data, {color_scheme: 3});
    patches[3].error({responseJSON: {msg: "Late"}});
    assert.equal(toasts.length, 2);
    ykphone_rail.toggle_color_scheme();
    assert.deepEqual(patches[5].data, {color_scheme: 2});
    ykphone_rail.clear_for_testing();
});

run_test("mount", ({override, mock_template}) => {
    set_current_user(member);
    $.clear_all_elements();
    set_global("window", {
        location: {hash: "#narrow/is/dm"},
        to_$: () => $("window-stub"),
    });

    let rail_html;
    mock_template("ykphone_rail.hbs", true, (data, html) => {
        assert.deepEqual(
            data.items.map((item) => item.id),
            ["home", "dm", "activity"],
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

    ykphone_rail.mount();

    assert.ok(rail_html.includes('data-rail-item="dm"'));
    assert.ok(rail_html.includes("zulip-icon-at-sign"));
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
    assert.ok($dm.hasClass("active"));

    // Later hash changes and narrows update the active item.
    window.location.hash = "#inbox";
    $("window-stub").trigger("hashchange");
    assert.ok($home.hasClass("active"));
    window.location.hash = "#narrow/is/dm";
    ykphone_rail.handle_narrow_activated();
    assert.ok($dm.hasClass("active"));

    // Escaping: the organization name is rendered as text.
    $.clear_all_elements();
    set_realm(make_realm({realm_name: "<b>x</b>"}));
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
