"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const $ = require("./lib/zjquery.cjs");
const {page_params} = require("./lib/zpage_params.cjs");

const verona = {
    stream_id: 3,
    name: "Verona",
    rendered_description: "<p>Plans for <em>Verona</em></p>",
    is_archived: false,
};
const archived = {
    stream_id: 4,
    name: "Old news",
    rendered_description: "",
    is_archived: true,
};

mock_esm("../src/hash_util", {
    channels_settings_edit_url: (sub, section) => `#channels/${sub.stream_id}/${section}`,
    channel_url_by_user_setting: (stream_id) => `#narrow/channel/${stream_id}-x/topic/`,
    search_terms_to_hash: (terms) =>
        "#narrow/" + terms.map((term) => `${term.operator}/${term.operand}`).join("/"),
});
const inbox_util = mock_esm("../src/inbox_util", {
    is_visible: () => false,
    is_channel_view: () => false,
});
const narrow_state = mock_esm("../src/narrow_state");
const peer_data = mock_esm("../src/peer_data", {
    has_full_subscriber_data: () => false,
    get_subscriber_count: (stream_id) => (stream_id === verona.stream_id ? 11 : 0),
});
mock_esm("../src/people", {
    is_valid_bot_user: (user_id) => user_id === 99,
    small_avatar_url_for_user_id: (user_id) => `/avatar/${user_id}`,
});
mock_esm("../src/presence", {
    get_status: (user_id) => (user_id === 7 ? "active" : "offline"),
});
const recent_view_util = mock_esm("../src/recent_view_util", {
    is_visible: () => false,
});
mock_esm("../src/stream_data", {
    get_sub_by_id_string(stream_id_string) {
        return [verona, archived].find((sub) => sub.stream_id.toString() === stream_id_string);
    },
});
const ui_util = mock_esm("../src/ui_util", {
    matches_viewport_state: () => true,
});
const ykphone_pins = mock_esm("../src/ykphone_pins", {
    pin_count: (stream_id) => (stream_id === verona.stream_id ? 2 : 0),
    get_panel_stream_id: () => undefined,
});

const ykphone_pane_header = zrequire("ykphone_pane_header");

// A stand-in for Filter with the handful of methods the header reads.
function fake_filter({terms, title, common = true, in_home = false, icon}) {
    return {
        is_in_home: () => in_home,
        is_common_narrow: () => common,
        get_title: () => title,
        add_icon_data: (context) => ({...context, ...icon}),
        has_operator: (operator) => terms.some((term) => term.operator === operator),
        terms_with_operator: (operator) => terms.filter((term) => term.operator === operator),
        sorted_term_types: () =>
            terms
                .map((term) => (term.operator === "has" ? `has-${term.operand}` : term.operator))
                .toSorted(),
    };
}

const verona_filter = fake_filter({
    terms: [{operator: "channel", operand: "3"}],
    title: "Verona",
    icon: {zulip_icon: "hashtag"},
});

const verona_tabs = {
    active: "messages",
    messages_url: "#narrow/channel/3-x/topic/",
    files_url: "#narrow/channel/3/has/attachment",
    pin_count: 2,
    has_pins: true,
};

run_test("get_context views", ({override}) => {
    page_params.is_spectator = false;
    // Without a filter the header falls back to the combined feed,
    // like upstream while the initial narrow is unknown. Views carry
    // no description line.
    assert.deepEqual(ykphone_pane_header.get_context(undefined), {
        title: "translated: Combined feed",
        zulip_icon: "all-messages",
    });
    assert.deepEqual(ykphone_pane_header.get_context(fake_filter({terms: [], in_home: true})), {
        title: "translated: Combined feed",
        zulip_icon: "all-messages",
    });

    override(recent_view_util, "is_visible", () => true);
    assert.deepEqual(ykphone_pane_header.get_context(undefined), {
        title: "translated: Threads",
        zulip_icon: "recent",
    });
    override(recent_view_util, "is_visible", () => false);

    override(inbox_util, "is_visible", () => true);
    assert.deepEqual(ykphone_pane_header.get_context(undefined), {
        title: "translated: Inbox",
        zulip_icon: "inbox",
    });
    // The inbox's channel view is a narrow, not the inbox.
    override(inbox_util, "is_channel_view", () => true);
    assert.equal(ykphone_pane_header.get_context(undefined).title, "translated: Combined feed");
    override(inbox_util, "is_visible", () => false);

    // A search narrow has no navbar title upstream (the search bar
    // opens instead); the pane says what it is.
    const search = fake_filter({terms: [{operator: "search", operand: "x"}], common: false});
    assert.deepEqual(ykphone_pane_header.get_context(search), {
        title: "translated: Search results",
        zulip_icon: "search",
    });

    // Other common narrows take upstream's title and icon, without
    // the tooltip-style description; the Later view's star becomes
    // the bookmark its sidebar row shows.
    const starred = fake_filter({
        terms: [{operator: "is", operand: "starred"}],
        title: "translated: Later",
        icon: {zulip_icon: "star"},
    });
    assert.deepEqual(ykphone_pane_header.get_context(starred), {
        title: "translated: Later",
        zulip_icon: "bookmark",
        icon: undefined,
    });
    const resolved = fake_filter({
        terms: [{operator: "is", operand: "resolved"}],
        title: "Resolved topics",
        icon: {icon: "check"},
    });
    assert.deepEqual(ykphone_pane_header.get_context(resolved), {
        title: "Resolved topics",
        zulip_icon: undefined,
        icon: "check",
    });
});

run_test("get_context channel", ({override}) => {
    page_params.is_spectator = false;
    // Before the subscriber list is loaded the button shows the count
    // alone. A channel's own view carries the tab row.
    assert.deepEqual(ykphone_pane_header.get_context(verona_filter), {
        title: "Verona",
        zulip_icon: "hashtag",
        icon: undefined,
        channel: {
            stream_id: 3,
            settings_url: "#channels/3/general",
            member_count: 11,
            avatar_urls: [],
            has_avatars: false,
            is_archived: false,
        },
        tabs: verona_tabs,
    });

    // With subscribers known, the first three humans (by id) supply
    // the stacked avatars; bots are skipped.
    override(peer_data, "has_full_subscriber_data", (stream_id) => stream_id === 3);
    override(peer_data, "get_subscriber_ids_assert_loaded", () => [30, 99, 10, 20, 40]);
    assert.deepEqual(ykphone_pane_header.get_context(verona_filter).channel.avatar_urls, [
        "/avatar/10",
        "/avatar/20",
        "/avatar/30",
    ]);

    const archived_filter = fake_filter({
        terms: [{operator: "channel", operand: "4"}],
        title: "Old news",
        icon: {zulip_icon: "archive"},
    });
    const archived_context = ykphone_pane_header.get_context(archived_filter);
    assert.equal(archived_context.channel.is_archived, true);
    assert.equal(archived_context.channel.member_count, 0);
    assert.equal(archived_context.tabs.pin_count, 0);
    assert.equal(archived_context.tabs.has_pins, false);
    assert.equal(ykphone_pane_header.get_context(verona_filter).channel.has_avatars, true);

    // A thread's full view names the thread after the channel and has
    // no tabs; the empty topic is the channel's general chat.
    const topic_filter = fake_filter({
        terms: [
            {operator: "channel", operand: "3"},
            {operator: "topic", operand: "Shall we ship on Friday?"},
        ],
        title: "Verona",
        icon: {zulip_icon: "hashtag"},
    });
    const topic_context = ykphone_pane_header.get_context(topic_filter);
    assert.equal(topic_context.topic, "Shall we ship on Friday?");
    assert.equal(topic_context.tabs, undefined);
    const general_chat = fake_filter({
        terms: [
            {operator: "channel", operand: "3"},
            {operator: "topic", operand: ""},
        ],
        title: "Verona",
        icon: {zulip_icon: "hashtag"},
    });
    const general_context = ykphone_pane_header.get_context(general_chat);
    assert.equal(general_context.topic, undefined);
    assert.deepEqual(general_context.tabs, verona_tabs);

    // The Pins tab is active while the panel shows this channel.
    override(ykphone_pins, "get_panel_stream_id", () => 3);
    assert.equal(ykphone_pane_header.get_context(general_chat).tabs.active, "pins");
    assert.equal(ykphone_pane_header.get_context(archived_filter).tabs.active, "messages");
    override(ykphone_pins, "get_panel_stream_id", () => undefined);

    // Spectators cannot fetch pins, so their count is unknown.
    page_params.is_spectator = true;
    assert.equal(ykphone_pane_header.get_context(verona_filter).tabs.pin_count, undefined);
    assert.equal(ykphone_pane_header.get_context(verona_filter).tabs.has_pins, false);
    page_params.is_spectator = false;

    // A channel the user cannot see keeps upstream's title and gets
    // no channel controls.
    const unknown = fake_filter({
        terms: [{operator: "channel", operand: "5"}],
        title: "translated: Unknown channel",
        icon: {icon: "question-circle-o"},
    });
    assert.deepEqual(ykphone_pane_header.get_context(unknown), {
        title: "translated: Unknown channel",
        zulip_icon: undefined,
        icon: "question-circle-o",
    });
});

run_test("get_context files tab", () => {
    page_params.is_spectator = false;
    // The Files tab is a search narrow upstream would call "Search
    // results"; the header keeps the channel with that tab active.
    const files = fake_filter({
        terms: [
            {operator: "channel", operand: "3"},
            {operator: "has", operand: "attachment"},
        ],
        common: false,
        icon: {zulip_icon: "hashtag"},
    });
    const context = ykphone_pane_header.get_context(files);
    assert.equal(context.title, "Verona");
    assert.equal(context.zulip_icon, "hashtag");
    assert.equal(context.channel.stream_id, 3);
    assert.deepEqual(context.tabs, {...verona_tabs, active: "files"});
    assert.equal(ykphone_pane_header.files_url(3), "#narrow/channel/3/has/attachment");

    // An unknown channel's files are a plain search.
    const unknown_files = fake_filter({
        terms: [
            {operator: "channel", operand: "5"},
            {operator: "has", operand: "attachment"},
        ],
        common: false,
    });
    assert.equal(
        ykphone_pane_header.get_context(unknown_files).title,
        "translated: Search results",
    );
});

run_test("get_context direct messages", () => {
    // One-to-one conversations show the other person's avatar and
    // presence.
    const one_to_one = fake_filter({
        terms: [{operator: "dm", operand: [7]}],
        title: "Cordelia",
        icon: {zulip_icon: "user"},
    });
    assert.deepEqual(ykphone_pane_header.get_context(one_to_one), {
        title: "Cordelia",
        zulip_icon: "user",
        icon: undefined,
        user_circle_class: "user-circle-active",
        dm_avatar_url: "/avatar/7",
    });

    // Group conversations keep the icon.
    const group = fake_filter({
        terms: [{operator: "dm", operand: [7, 8]}],
        title: "Cordelia and Hamlet",
        icon: {zulip_icon: "user"},
    });
    assert.equal(ykphone_pane_header.get_context(group).user_circle_class, undefined);
    assert.equal(ykphone_pane_header.get_context(group).dm_avatar_url, undefined);
    assert.equal(ykphone_pane_header.get_context(group).title, "Cordelia and Hamlet");
});

run_test("members button label", ({override}) => {
    $.clear_all_elements();
    const $body = $("body");
    const $column = $(".app-main .column-right");

    // Wide screens: the persisted toggle.
    override(ui_util, "matches_viewport_state", (state) => state === "gte_xl_min");
    $body.addClass("hide-right-sidebar");
    assert.equal(ykphone_pane_header.members_button_label(), "translated: Show members");
    $body.removeClass("hide-right-sidebar");
    assert.equal(ykphone_pane_header.members_button_label(), "translated: Hide members");

    // Narrower: the overlay's state.
    override(ui_util, "matches_viewport_state", () => false);
    assert.equal(ykphone_pane_header.members_button_label(), "translated: Show members");
    $column.addClass("expanded");
    assert.equal(ykphone_pane_header.members_button_label(), "translated: Hide members");

    // Updating the button refreshes both the label and an existing
    // tooltip; without a button (a view) there is nothing to do.
    const $button = $("#ykphone-pane-header .ykphone-pane-header-members");
    let tooltip_content;
    $button[0]._tippy = {
        setContent(content) {
            tooltip_content = content;
        },
    };
    ykphone_pane_header.update_members_button();
    assert.equal($button.attr("aria-label"), "translated: Hide members");
    assert.equal($button.attr("data-tippy-content"), "translated: Hide members");
    assert.equal(tooltip_content, "translated: Hide members");
    $button[0]._tippy = undefined;
    $column.removeClass("expanded");
    ykphone_pane_header.update_members_button();
    assert.equal($button.attr("aria-label"), "translated: Show members");

    $.clear_all_elements();
    $.create("#ykphone-pane-header .ykphone-pane-header-members", {elements: []});
    ykphone_pane_header.update_members_button();
});

run_test("render before mount", ({override, mock_template}) => {
    $.clear_all_elements();
    override(narrow_state, "filter", () => undefined);
    override(recent_view_util, "is_visible", () => true);
    let rendered;
    mock_template("ykphone_pane_header.hbs", true, (data, html) => {
        rendered = {data, html};
        return html;
    });
    // Nothing is mounted yet (ui_init renders the title area before
    // our mount); rendering is harmless and fetches nothing.
    ykphone_pane_header.render();
    assert.equal(rendered.data.title, "translated: Threads");
    assert.ok(rendered.html.includes("zulip-icon-recent"));
    assert.ok(!rendered.html.includes("ykphone-pane-header-tabs"));
});

run_test("spectators never fetch subscribers or pins", ({override, mock_template}) => {
    ykphone_pane_header.clear_for_testing();
    $.clear_all_elements();
    page_params.is_spectator = true;
    override(narrow_state, "filter", () => verona_filter);
    // peer_data's mock has no get_subscribers_with_possible_fetch and
    // ykphone_pins's no load_stream_pins: an attempt would throw.
    let rendered;
    mock_template("ykphone_pane_header.hbs", true, (data, html) => {
        rendered = {data, html};
        return html;
    });

    ykphone_pane_header.render();
    assert.equal(rendered.data.title, "Verona");
    // The count still renders (the button is hidden for spectators
    // by upstream's CSS class); the Pins tab shows no count.
    assert.ok(rendered.html.includes("hidden-for-spectators"));
    assert.ok(rendered.html.includes(">11<"));
    assert.ok(rendered.html.includes("ykphone-pane-header-pins-tab"));
    assert.ok(!rendered.html.includes("ykphone-pane-header-tab-count"));
    page_params.is_spectator = false;
});

run_test("render and mount", ({override, mock_template}) => {
    ykphone_pane_header.clear_for_testing();
    $.clear_all_elements();
    page_params.is_spectator = false;
    override(narrow_state, "filter", () => verona_filter);
    override(narrow_state, "stream_id", () => 3);
    $("body").addClass("hide-right-sidebar");

    let rendered;
    let render_count = 0;
    mock_template("ykphone_pane_header.hbs", true, (data, html) => {
        rendered = {data, html};
        render_count += 1;
        return html;
    });
    const $header = $("#ykphone-pane-header");
    const pin_loads = [];
    override(ykphone_pins, "load_stream_pins", (stream_id) => {
        pin_loads.push(stream_id);
    });

    // The first render finds no subscriber data and asks for it once;
    // the answer re-renders the header while the channel is still up.
    let fetches = [];
    let settle_fetch;
    override(peer_data, "get_subscribers_with_possible_fetch", (stream_id) => {
        fetches.push(stream_id);
        return new Promise((resolve, reject) => {
            settle_fetch = {resolve, reject};
        });
    });
    let prepended;
    $.create(".app-main .column-middle-inner", {
        elements: [
            {
                prepend(node) {
                    prepended = node;
                },
            },
        ],
    });

    ykphone_pane_header.mount();

    assert.equal(prepended, $("<div>")[0]);
    assert.equal($("<div>").attr("id"), "ykphone-pane-header");
    assert.equal(rendered.data.title, "Verona");
    assert.equal(rendered.data.members_label, "translated: Show members");
    assert.ok(rendered.html.includes("zulip-icon-hashtag"));
    assert.ok(rendered.html.includes('href="#channels/3/general"'));
    assert.ok(rendered.html.includes('data-stream-id="3"'));
    assert.ok(rendered.html.includes("zulip-icon-chevron-down"));
    assert.ok(rendered.html.includes("no-auto-hide-right-sidebar-overlay"));
    assert.ok(rendered.html.includes('aria-label="translated: Show members"'));
    // No avatars yet: the member button shows the list icon and count.
    assert.ok(rendered.html.includes("zulip-icon-user-list"));
    assert.ok(rendered.html.includes(">11<"));
    assert.ok(!rendered.html.includes("ykphone-pane-header-topic"));
    // The tab row: Messages active, Files a link, Pins with its count.
    assert.ok(rendered.html.includes('href="#narrow/channel/3-x/topic/" aria-current="page"'));
    assert.ok(rendered.html.includes('href="#narrow/channel/3/has/attachment"'));
    assert.ok(rendered.html.includes('<span class="ykphone-pane-header-tab-count">2</span>'));
    assert.ok(!rendered.html.includes('aria-current="true"'));
    assert.equal($header.html(), rendered.html);
    assert.deepEqual(fetches, [3]);
    assert.deepEqual(pin_loads, [3]);

    // A second render while the fetch is in flight does not fetch
    // subscribers again (pins are cheap to ask for; the cache dedupes).
    ykphone_pane_header.render();
    assert.deepEqual(fetches, [3]);

    return (async () => {
        override(peer_data, "has_full_subscriber_data", () => true);
        override(peer_data, "get_subscriber_ids_assert_loaded", () => [10, 20]);
        settle_fetch.resolve();
        await Promise.resolve();
        await Promise.resolve();
        assert.ok(rendered.html.includes('src="/avatar/10"'));
        assert.ok(rendered.html.includes('src="/avatar/20"'));
        assert.ok(!rendered.html.includes("zulip-icon-user-list"));

        // A fetch that fails is forgotten, so the next render tries
        // again rather than staying without avatars for the session.
        ykphone_pane_header.clear_for_testing();
        override(peer_data, "has_full_subscriber_data", () => false);
        fetches = [];
        ykphone_pane_header.render();
        assert.deepEqual(fetches, [3]);
        settle_fetch.reject(new Error("network"));
        await Promise.resolve();
        await Promise.resolve();
        ykphone_pane_header.render();
        assert.deepEqual(fetches, [3, 3]);

        // A fetch that finishes after the user moved on renders nothing
        // for the old channel.
        const render_count_before = render_count;
        override(narrow_state, "stream_id", () => 4);
        settle_fetch.resolve();
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(render_count, render_count_before);

        // A thread's full view shows the thread after the channel and
        // no tabs.
        override(narrow_state, "filter", () =>
            fake_filter({
                terms: [
                    {operator: "channel", operand: "3"},
                    {operator: "topic", operand: "Shall we <ship>?"},
                ],
                title: "Verona",
                icon: {zulip_icon: "hashtag"},
            }),
        );
        ykphone_pane_header.render();
        assert.ok(
            rendered.html.includes(
                '<span class="ykphone-pane-header-topic">Shall we &lt;ship&gt;?</span>',
            ),
        );
        assert.ok(!rendered.html.includes("ykphone-pane-header-tabs"));

        // Views render without tabs, a member button or a fetch.
        override(recent_view_util, "is_visible", () => true);
        ykphone_pane_header.render();
        assert.equal(rendered.data.title, "translated: Threads");
        assert.ok(rendered.html.includes("zulip-icon-recent"));
        assert.ok(!rendered.html.includes("ykphone-pane-header-tabs"));
        assert.ok(!rendered.html.includes("ykphone-pane-header-members"));
        override(recent_view_util, "is_visible", () => false);

        // A one-to-one direct message shows the avatar with the
        // presence dot on it.
        override(narrow_state, "filter", () =>
            fake_filter({
                terms: [{operator: "dm", operand: [7]}],
                title: "Cordelia",
                icon: {zulip_icon: "user"},
            }),
        );
        ykphone_pane_header.render();
        assert.ok(rendered.html.includes('class="ykphone-pane-header-dm-avatar" src="/avatar/7"'));
        assert.ok(rendered.html.includes("user-circle-active"));
        assert.ok(!rendered.html.includes("zulip-icon-user "));
        assert.ok(!rendered.html.includes("ykphone-pane-header-members"));

        // Escaping: titles are rendered as text.
        override(narrow_state, "filter", () =>
            fake_filter({
                terms: [{operator: "is", operand: "resolved"}],
                title: "<b>x</b>",
                icon: {icon: "check"},
            }),
        );
        ykphone_pane_header.render();
        assert.ok(rendered.html.includes("&lt;b&gt;x&lt;/b&gt;"));
        assert.ok(rendered.html.includes("fa-check"));
    })();
});
