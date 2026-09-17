"use strict";

const assert = require("node:assert/strict");

const {make_realm} = require("./lib/example_realm.cjs");
const {make_user} = require("./lib/example_user.cjs");
const {mock_esm, set_global, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const {page_params} = require("./lib/zpage_params.cjs");

const me = make_user({user_id: 5});
// 8 is a guest.
let human_user_ids = [me.user_id, 7, 8, 9];
let can_create_public = true;
let can_create_private = true;
let folders = [];
const subs_by_lower_name = new Map();
const navigations = [];
const timers = [];

mock_esm("../src/browser_history", {
    go_to_location(hash) {
        navigations.push(hash);
    },
});
mock_esm("../src/channel_folders", {
    get_channel_folders: () => folders,
});
mock_esm("../src/hash_util", {
    channel_url_by_user_setting: (stream_id) => `#narrow/channel/${stream_id}/topic/`,
});
mock_esm("../src/people", {
    get_realm_active_human_user_ids: () => [...human_user_ids],
    get_by_user_id: (user_id) => ({user_id, is_guest: user_id === 8}),
});
mock_esm("../src/settings_data", {
    user_can_create_public_streams: () => can_create_public,
    user_can_create_private_streams: () => can_create_private,
});
mock_esm("../src/stream_data", {
    // Like stream_data's FoldDict: names match regardless of case.
    get_sub: (name) => subs_by_lower_name.get(name.toLowerCase()),
});
// Fake timers for the tests that wait for a subscription event. They
// are installed per test: the instrumenter keeps timers of its own.
function fake_timers() {
    set_global("setTimeout", (f, delay) => {
        timers.push({f, delay, cleared: false});
        return timers.length - 1;
    });
    set_global("clearTimeout", (id) => {
        timers[id].cleared = true;
    });
}

const {set_current_user, set_realm} = zrequire("state_data");
const ykphone_channel_create = zrequire("ykphone_channel_create");

set_current_user(me);
set_realm(make_realm({max_stream_name_length: 60, max_stream_description_length: 1024}));

function reset() {
    ykphone_channel_create.clear_for_testing();
    page_params.is_spectator = false;
    can_create_public = true;
    can_create_private = true;
    folders = [];
    human_user_ids = [me.user_id, 7, 8, 9];
    subs_by_lower_name.clear();
    navigations.length = 0;
    timers.length = 0;
}

run_test("permissions", () => {
    reset();
    assert.deepEqual(ykphone_channel_create.permissions(), {
        can_create_public: true,
        can_create_private: true,
    });
    assert.equal(ykphone_channel_create.can_create(), true);

    can_create_private = false;
    assert.deepEqual(ykphone_channel_create.permissions(), {
        can_create_public: true,
        can_create_private: false,
    });
    assert.equal(ykphone_channel_create.can_create(), true);

    can_create_public = false;
    assert.equal(ykphone_channel_create.can_create(), false);

    // A spectator can create nothing, whatever the groups say.
    can_create_public = true;
    can_create_private = true;
    page_params.is_spectator = true;
    assert.deepEqual(ykphone_channel_create.permissions(), {
        can_create_public: false,
        can_create_private: false,
    });
    assert.equal(ykphone_channel_create.can_create(), false);
});

run_test("form_context", () => {
    reset();
    folders = [
        {id: 3, name: "Engineering", description: "", is_archived: false, order: 0},
        {id: 4, name: "Sales", description: "", is_archived: false, order: 1},
    ];

    // The folder whose "+" was clicked is preselected.
    assert.deepEqual(ykphone_channel_create.form_context(4), {
        can_create_public: true,
        can_create_private: true,
        invite_only: false,
        has_folders: true,
        folders: [
            {id: 3, name: "Engineering", selected: false},
            {id: 4, name: "Sales", selected: true},
        ],
        max_stream_name_length: 60,
        max_stream_description_length: 1024,
    });

    // The "Add channels" row and an unknown folder preselect nothing.
    assert.deepEqual(
        ykphone_channel_create.form_context(undefined).folders.map((folder) => folder.selected),
        [false, false],
    );
    assert.deepEqual(
        ykphone_channel_create.form_context(99).folders.map((folder) => folder.selected),
        [false, false],
    );

    // Public is the default unless only private channels are allowed.
    can_create_public = false;
    folders = [];
    const context = ykphone_channel_create.form_context(undefined);
    assert.equal(context.has_folders, false);
    assert.equal(context.can_create_public, false);
    assert.equal(context.can_create_private, true);
    assert.equal(context.invite_only, true);
});

// A real render of both templates: Zulip's strict Handlebars helpers
// reject arrays and numbers in {{#if}}, which a mocked template would
// not catch.
run_test("templates render", () => {
    reset();
    folders = [{id: 3, name: "Engineering", description: "", is_archived: false, order: 0}];
    const render_modal = require("../templates/ykphone_channel_create_modal.hbs");
    const render_menu = require("../templates/ykphone_channel_menu.hbs");

    let html = render_modal(ykphone_channel_create.form_context(3));
    assert.ok(html.includes('<option value="3" selected>Engineering</option>'));
    assert.ok(html.includes('value="public" checked'));
    assert.ok(html.includes("translated: Anyone in the organization can see this channel."));
    assert.ok(html.includes('class="ykphone-channel-open-existing" hidden'));
    assert.ok(html.includes('class="ykphone-channel-step ykphone-channel-step-2" hidden'));

    can_create_private = false;
    folders = [];
    html = render_modal(ykphone_channel_create.form_context(undefined));
    assert.ok(!html.includes("ykphone-channel-folder"));
    assert.ok(html.includes('value="private" disabled'));
    assert.ok(html.includes("translated: You do not have permission to create private channels."));

    html = render_menu();
    assert.ok(html.includes("translated: Create a channel"));
    assert.ok(html.includes('href="#channels/all"'));
});

run_test("check_name and conflicts", ({mock_template}) => {
    reset();
    subs_by_lower_name.set("verona", {stream_id: 3, name: "Verona", is_archived: false});
    subs_by_lower_name.set("old", {stream_id: 9, name: "old", is_archived: true});

    // Nothing typed yet: the button stays disabled, no message.
    assert.deepEqual(ykphone_channel_create.check_name(""), {valid: false});
    assert.deepEqual(ykphone_channel_create.check_name("   "), {valid: false});

    assert.deepEqual(ykphone_channel_create.check_name(" design "), {valid: true});

    // A taken name, in any case, gets upstream's conflict message as
    // plain text (its link would close the modal), and a way to the
    // channel when it can be opened.
    let rendered_data;
    mock_template("stream_settings/channel_name_conflict_error.hbs", false, (data) => {
        rendered_data = data;
        return "<conflict>";
    });
    assert.deepEqual(ykphone_channel_create.check_name("VERONA"), {
        valid: false,
        error_html: "<conflict>",
        existing_stream_id: 3,
    });
    assert.deepEqual(rendered_data, {
        stream_id: 3,
        is_archived: false,
        show_rename: false,
        can_view_channel: false,
    });
    // An archived channel is named but not offered.
    assert.deepEqual(ykphone_channel_create.check_name("Old"), {
        valid: false,
        error_html: "<conflict>",
    });
    assert.equal(rendered_data.is_archived, true);
    // A conflict the client learnt of from the server, for a channel
    // it does not know.
    assert.deepEqual(ykphone_channel_create.conflict(undefined), {
        valid: false,
        error_html: "<conflict>",
    });
    assert.deepEqual(rendered_data, {
        stream_id: undefined,
        is_archived: false,
        show_rename: false,
        can_view_channel: false,
    });
});

run_test("server checks", () => {
    reset();
    const streams = {
        streams: [
            {name: "Verona", stream_id: 3},
            {name: "design", stream_id: 4},
        ],
    };
    assert.equal(ykphone_channel_create.name_taken_on_server("verona", streams), true);
    assert.equal(ykphone_channel_create.name_taken_on_server(" Design ", streams), true);
    assert.equal(ykphone_channel_create.name_taken_on_server("sales", streams), false);
    // An unexpected answer blocks nothing; the response and the event
    // still guard the creation.
    assert.equal(ykphone_channel_create.name_taken_on_server("verona", {result: "success"}), false);

    const created = {subscribed: {5: ["design"]}, already_subscribed: {}};
    assert.equal(ykphone_channel_create.response_conflict(created, "Design"), undefined);
    const already = {subscribed: {}, already_subscribed: {5: ["Design"]}};
    assert.equal(ykphone_channel_create.response_conflict(already, "design"), "already_subscribed");
    const neither = {subscribed: {5: ["other"]}, already_subscribed: {}};
    assert.equal(ykphone_channel_create.response_conflict(neither, "design"), "not_subscribed");
    assert.equal(ykphone_channel_create.response_conflict({}, "design"), "not_subscribed");
});

run_test("requests", () => {
    reset();
    assert.deepEqual(
        ykphone_channel_create.create_request_data({
            name: "design",
            description: "Mockups",
            invite_only: true,
            folder_id: undefined,
        }),
        {
            subscriptions: JSON.stringify([{name: "design", description: "Mockups"}]),
            invite_only: "true",
            announce: "false",
        },
    );
    assert.deepEqual(
        ykphone_channel_create.create_request_data({
            name: "design",
            description: "",
            invite_only: false,
            folder_id: 4,
        }),
        {
            subscriptions: JSON.stringify([{name: "design", description: ""}]),
            invite_only: "false",
            announce: "false",
            folder_id: "4",
        },
    );
    assert.deepEqual(ykphone_channel_create.add_request_data("design", [7, 8]), {
        subscriptions: JSON.stringify([{name: "design"}]),
        principals: "[7,8]",
    });
    assert.deepEqual(ykphone_channel_create.leave_request_data("design"), {
        subscriptions: '["design"]',
    });
    assert.equal(
        ykphone_channel_create.add_people_title("design"),
        "translated: Add people to #design",
    );
});

run_test("people to add", () => {
    reset();
    // Members only: no guests (8), and not the creator (5).
    assert.deepEqual(ykphone_channel_create.everyone_user_ids(), [7, 9]);
    assert.equal(ykphone_channel_create.everyone_count(), 2);
    assert.equal(ykphone_channel_create.can_add_everyone(false), true);
    // Never for a private channel.
    assert.equal(ykphone_channel_create.can_add_everyone(true), false);
    // Nor for an organization too big for it to be a shortcut.
    human_user_ids = Array.from(
        {length: ykphone_channel_create.ADD_EVERYONE_LIMIT + 2},
        (_, i) => i + 10,
    );
    assert.equal(ykphone_channel_create.can_add_everyone(false), false);
    human_user_ids.pop();
    human_user_ids.pop();
    human_user_ids.push(me.user_id, 8);
    assert.equal(ykphone_channel_create.can_add_everyone(false), true);

    human_user_ids = [me.user_id, 7, 8, 9];
    // The creator is already in the channel; duplicates from a group
    // and a user pill collapse. A guest picked by name is added.
    assert.deepEqual(
        ykphone_channel_create.principals_to_add({
            add_everyone: false,
            pill_user_ids: [7, me.user_id, 7, 8],
        }),
        [7, 8],
    );
    assert.deepEqual(
        ykphone_channel_create.principals_to_add({add_everyone: false, pill_user_ids: []}),
        [],
    );
    assert.deepEqual(
        ykphone_channel_create.principals_to_add({add_everyone: true, pill_user_ids: [7]}),
        [7, 9],
    );
});

run_test("navigation waits for the event and the modal", () => {
    reset();
    fake_timers();
    const design = {stream_id: 21, name: "Design", creator_id: me.user_id};
    const other = {stream_id: 22, name: "Other", creator_id: me.user_id};
    const conflicts = [];
    const on_conflict = (sub) => {
        conflicts.push(sub.stream_id);
    };

    // Nothing pending: subscription events and closes are ignored.
    ykphone_channel_create.on_subscribed(design);
    ykphone_channel_create.on_modal_closed();
    assert.deepEqual(navigations, []);
    assert.equal(ykphone_channel_create.is_creating("design"), false);

    // The event lands while the modal is still on "Add people".
    ykphone_channel_create.begin_creation("design", on_conflict);
    assert.equal(ykphone_channel_create.is_creating(" Design "), true);
    assert.equal(ykphone_channel_create.is_creating("other"), false);
    ykphone_channel_create.on_subscribed(other);
    assert.deepEqual(navigations, []);
    ykphone_channel_create.on_subscribed(design);
    assert.deepEqual(navigations, []);
    // A second event for the same name changes nothing.
    ykphone_channel_create.on_subscribed({stream_id: 23, name: "design", creator_id: 99});
    ykphone_channel_create.on_modal_closed();
    assert.deepEqual(navigations, ["#narrow/channel/21/topic/"]);
    assert.deepEqual(timers, []);
    assert.equal(ykphone_channel_create.is_creating("design"), false);
    // Closed and navigated: later events are for something else.
    ykphone_channel_create.on_subscribed(design);
    ykphone_channel_create.on_modal_closed();
    assert.deepEqual(navigations, ["#narrow/channel/21/topic/"]);

    // The modal is closed (skipped, or dismissed during the request)
    // before the event lands: the event is waited for a while.
    navigations.length = 0;
    ykphone_channel_create.begin_creation("Design", on_conflict);
    ykphone_channel_create.on_modal_closed();
    assert.deepEqual(navigations, []);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, ykphone_channel_create.PENDING_TIMEOUT_MS);
    ykphone_channel_create.on_subscribed(design);
    assert.deepEqual(navigations, ["#narrow/channel/21/topic/"]);
    assert.equal(timers[0].cleared, true);

    // ...but not for ever: after the timeout a channel of that name is
    // somebody else's business.
    navigations.length = 0;
    ykphone_channel_create.begin_creation("design", on_conflict);
    ykphone_channel_create.on_modal_closed();
    timers[1].f();
    ykphone_channel_create.on_subscribed(design);
    assert.deepEqual(navigations, []);
    assert.deepEqual(conflicts, []);

    // A failed creation is abandoned: its name no longer matches.
    ykphone_channel_create.begin_creation("design", on_conflict);
    ykphone_channel_create.abandon_creation();
    ykphone_channel_create.on_subscribed(design);
    ykphone_channel_create.on_modal_closed();
    assert.deepEqual(navigations, []);

    // Beginning again replaces a creation still waiting for its event.
    ykphone_channel_create.begin_creation("design", on_conflict);
    ykphone_channel_create.on_modal_closed();
    const stale_timer = timers.length - 1;
    ykphone_channel_create.begin_creation("sales", on_conflict);
    assert.equal(timers[stale_timer].cleared, true);
    ykphone_channel_create.on_subscribed(design);
    assert.deepEqual(navigations, []);
});

run_test("a channel somebody else created is a conflict", () => {
    reset();
    fake_timers();
    const theirs = {stream_id: 31, name: "design", creator_id: 7};
    const conflicts = [];
    const on_conflict = (sub) => {
        conflicts.push(sub.stream_id);
    };

    // The request subscribed the user to an existing channel: the
    // dialog is told, and nothing navigates when it closes.
    ykphone_channel_create.begin_creation("Design", on_conflict);
    ykphone_channel_create.on_subscribed(theirs);
    assert.deepEqual(conflicts, [31]);
    assert.equal(ykphone_channel_create.is_creating("design"), false);
    ykphone_channel_create.on_modal_closed();
    assert.deepEqual(navigations, []);
    assert.deepEqual(timers, []);

    // The same after the modal was closed during the request: the
    // dialog handler still runs (it unsubscribes), and the wait ends.
    ykphone_channel_create.begin_creation("design", on_conflict);
    ykphone_channel_create.on_modal_closed();
    ykphone_channel_create.on_subscribed(theirs);
    assert.deepEqual(conflicts, [31, 31]);
    assert.equal(timers.at(-1).cleared, true);
    assert.deepEqual(navigations, []);

    // A channel with no recorded creator is old, hence not ours.
    ykphone_channel_create.begin_creation("design", on_conflict);
    ykphone_channel_create.on_subscribed({stream_id: 32, name: "design", creator_id: null});
    assert.deepEqual(conflicts, [31, 31, 32]);
});
