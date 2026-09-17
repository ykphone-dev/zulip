"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

// The people in the dev-like realm of these tests.
const iago = {user_id: 11, full_name: "Iago", email: "iago@zulip.com"};
const othello = {user_id: 12, full_name: "Othello", email: "othello@zulip.com"};
const cordelia = {user_id: 10, full_name: "Cordelia", email: "cordelia@zulip.com"};
const people_by_id = new Map([
    [iago.user_id, iago],
    [othello.user_id, othello],
    [cordelia.user_id, cordelia],
]);

let subscriber_ids = [iago.user_id, othello.user_id, cordelia.user_id];
let has_full_data = true;
let notifications = {
    desktop_notifications: false,
    audible_notifications: false,
    push_notifications: false,
    email_notifications: false,
    wildcard_mentions_notify: false,
};
let permissions = {
    content: true,
    metadata: true,
    toggle_subscription: true,
    archive: true,
    unsubscribe_others: true,
    subscribe_others: true,
};
const subs_by_name = new Map();

mock_esm("../src/peer_data", {
    has_full_subscriber_data: () => has_full_data,
    get_subscriber_ids_assert_loaded: () => [...subscriber_ids],
    get_subscriber_count: () => subscriber_ids.length,
});
mock_esm("../src/people", {
    maybe_get_user_by_id: (user_id) => people_by_id.get(user_id),
    is_my_user_id: (user_id) => user_id === iago.user_id,
    my_current_user_id: () => iago.user_id,
    small_avatar_url_for_person: (person) => `/avatar/${person.user_id}`,
    get_user_type: (user_id) => (user_id === iago.user_id ? "Organization owner" : "Member"),
    get_realm_users: () => [iago, othello, cordelia, {user_id: 99, full_name: "Zoe"}],
});
mock_esm("../src/stream_data", {
    can_change_permissions_requiring_content_access: () => permissions.content,
    can_change_permissions_requiring_metadata_access: () => permissions.metadata,
    can_toggle_subscription: () => permissions.toggle_subscription,
    can_archive_stream: () => permissions.archive,
    can_unsubscribe_others: () => permissions.unsubscribe_others,
    can_subscribe_others: () => permissions.subscribe_others,
    receives_notifications: (_stream_id, name) => notifications[name],
    get_sub: (name) => subs_by_name.get(name),
});
mock_esm("../src/timerender", {
    get_localized_date_or_time_for_format: () => "Sep 1, 2026",
});

const ykphone_channel_details = zrequire("ykphone_channel_details");

function make_sub(overrides = {}) {
    return {
        stream_id: 7,
        name: "devel",
        description: "Development talk",
        rendered_description: "<p>Development talk</p>",
        invite_only: false,
        is_web_public: false,
        is_archived: false,
        subscribed: true,
        is_muted: false,
        creator_id: iago.user_id,
        date_created: 1_756_684_800,
        ...overrides,
    };
}

function reset() {
    subscriber_ids = [iago.user_id, othello.user_id, cordelia.user_id];
    has_full_data = true;
    notifications = {
        desktop_notifications: false,
        audible_notifications: false,
        push_notifications: false,
        email_notifications: false,
        wildcard_mentions_notify: false,
    };
    permissions = {
        content: true,
        metadata: true,
        toggle_subscription: true,
        archive: true,
        unsubscribe_others: true,
        subscribe_others: true,
    };
    subs_by_name.clear();
    ykphone_channel_details.clear_for_testing();
}

run_test("privacy of a channel", () => {
    reset();
    assert.equal(ykphone_channel_details.privacy_label(make_sub()), "translated: Public channel");
    assert.equal(
        ykphone_channel_details.privacy_label(make_sub({invite_only: true})),
        "translated: Private channel",
    );
    assert.equal(
        ykphone_channel_details.privacy_label(make_sub({is_web_public: true})),
        "translated: Web-public channel",
    );
    assert.equal(
        ykphone_channel_details.privacy_label(make_sub({is_archived: true})),
        "translated: Archived channel",
    );
    // The icon follows the same four cases.
    assert.equal(ykphone_channel_details.info_context(make_sub()).privacy_icon, "hashtag");
    assert.equal(
        ykphone_channel_details.info_context(make_sub({invite_only: true})).privacy_icon,
        "lock",
    );
    assert.equal(
        ykphone_channel_details.info_context(make_sub({is_web_public: true})).privacy_icon,
        "globe",
    );
    assert.equal(
        ykphone_channel_details.info_context(make_sub({is_archived: true})).privacy_icon,
        "archive",
    );
});

run_test("the info tab", () => {
    reset();
    const context = ykphone_channel_details.info_context(make_sub());
    assert.deepEqual(context, {
        stream_id: 7,
        name: "devel",
        description: "Development talk",
        rendered_description: "<p>Development talk</p>",
        has_description: true,
        can_edit_description: true,
        privacy_label: "translated: Public channel",
        privacy_icon: "hashtag",
        created_by: "Iago",
        created_date: "Sep 1, 2026",
        member_count: 3,
        is_archived: false,
        can_leave: true,
        can_archive: true,
    });
    assert.equal(
        ykphone_channel_details.created_by_line(context),
        "translated: Created by Iago on Sep 1, 2026",
    );

    // The description follows the permission the server enforces:
    // metadata access, not content access (the rename uses the same).
    permissions.content = false;
    assert.equal(ykphone_channel_details.info_context(make_sub()).can_edit_description, true);
    permissions.metadata = false;
    assert.equal(ykphone_channel_details.info_context(make_sub()).can_edit_description, false);
    reset();

    // An archived channel is not edited and cannot be archived again;
    // a channel the user has left cannot be left.
    const archived = ykphone_channel_details.info_context(make_sub({is_archived: true}));
    assert.equal(archived.can_edit_description, false);
    permissions.archive = false;
    permissions.toggle_subscription = false;
    const unsubscribed = ykphone_channel_details.info_context(make_sub({subscribed: false}));
    assert.equal(unsubscribed.can_leave, false);
    assert.equal(unsubscribed.can_archive, false);

    // A channel with no description, and one whose creator is unknown
    // or gone.
    const empty = ykphone_channel_details.info_context(make_sub({description: ""}));
    assert.equal(empty.has_description, false);
    const no_creator = ykphone_channel_details.info_context(make_sub({creator_id: null}));
    assert.equal(no_creator.created_by, undefined);
    assert.equal(
        ykphone_channel_details.created_by_line(no_creator),
        "translated: Created on Sep 1, 2026",
    );
    assert.equal(
        ykphone_channel_details.info_context(make_sub({creator_id: 404})).created_by,
        undefined,
    );

    // Without the subscriber list the count comes from peer_data all
    // the same; the member rows are what waits for it.
    has_full_data = false;
    assert.equal(ykphone_channel_details.info_context(make_sub()).member_count, 3);
});

run_test("the member list", () => {
    reset();
    const rows = ykphone_channel_details.member_rows(make_sub(), "");
    assert.deepEqual(
        rows.map((row) => row.full_name),
        ["Cordelia", "Iago", "Othello"],
    );
    assert.deepEqual(rows[1], {
        user_id: iago.user_id,
        full_name: "Iago",
        avatar_url: "/avatar/11",
        role: "Organization owner",
        is_me: true,
        can_remove: true,
    });

    // The search matches a name or an email, ignoring case and the
    // space around what was typed.
    assert.deepEqual(
        ykphone_channel_details.member_rows(make_sub(), "ot hello").map((row) => row.full_name),
        [],
    );
    assert.deepEqual(
        ykphone_channel_details.member_rows(make_sub(), " OTH ").map((row) => row.full_name),
        ["Othello"],
    );
    assert.deepEqual(
        ykphone_channel_details
            .member_rows(make_sub(), "cordelia@zulip")
            .map((row) => row.full_name),
        ["Cordelia"],
    );

    // Somebody the client does not know is left out.
    subscriber_ids = [iago.user_id, 404];
    assert.deepEqual(
        ykphone_channel_details.member_rows(make_sub(), "").map((row) => row.full_name),
        ["Iago"],
    );

    // Removing: yourself while you may leave, others with permission,
    // nobody in an archived channel.
    reset();
    permissions.unsubscribe_others = false;
    const limited = ykphone_channel_details.member_rows(make_sub(), "");
    assert.deepEqual(
        limited.map((row) => row.can_remove),
        [false, true, false],
    );
    permissions.toggle_subscription = false;
    assert.equal(ykphone_channel_details.member_rows(make_sub(), "")[1].can_remove, false);
    reset();
    assert.deepEqual(
        ykphone_channel_details
            .member_rows(make_sub({is_archived: true}), "")
            .map((row) => row.can_remove),
        [false, false, false],
    );
});

run_test("the member tab's context", () => {
    reset();
    const context = ykphone_channel_details.members_context(make_sub(), "");
    assert.equal(context.stream_id, 7);
    assert.equal(context.rows.length, 3);
    assert.equal(context.loading, false);
    assert.equal(context.can_add, true);
    assert.equal(context.no_results, false);

    // A search with no hits says so; a list that has not arrived says
    // it is loading instead.
    assert.equal(ykphone_channel_details.members_context(make_sub(), "nobody").no_results, true);
    has_full_data = false;
    const loading = ykphone_channel_details.members_context(make_sub(), "");
    assert.equal(loading.loading, true);
    assert.equal(loading.no_results, false);

    // Nobody is added to an archived channel, or without permission.
    has_full_data = true;
    assert.equal(
        ykphone_channel_details.members_context(make_sub({is_archived: true}), "").can_add,
        false,
    );
    permissions.subscribe_others = false;
    assert.equal(ykphone_channel_details.members_context(make_sub(), "").can_add, false);
});

run_test("people the pill may offer", () => {
    reset();
    assert.deepEqual(
        ykphone_channel_details.potential_members(make_sub()).map((user) => user.user_id),
        [99],
    );
    has_full_data = false;
    assert.deepEqual(
        ykphone_channel_details.potential_members(make_sub()).map((user) => user.user_id),
        [11, 12, 10, 99],
    );
});

run_test("the three notification choices", () => {
    reset();
    // Nothing notifies: "없음".
    assert.equal(ykphone_channel_details.notification_choice(make_sub()), "none");
    // Only @channel mentions: "멘션만".
    notifications.wildcard_mentions_notify = true;
    assert.equal(ykphone_channel_details.notification_choice(make_sub()), "mentions");
    // Any of the four message notifications, email included: "모든 새
    // 메시지".
    for (const property of [
        "desktop_notifications",
        "audible_notifications",
        "push_notifications",
        "email_notifications",
    ]) {
        reset();
        notifications[property] = true;
        assert.equal(ykphone_channel_details.notification_choice(make_sub()), "all");
    }

    // What each choice writes: the four message settings as a group,
    // and the @channel one.
    assert.deepEqual(ykphone_channel_details.notification_sub_data(7, "all"), [
        {stream_id: 7, property: "desktop_notifications", value: true},
        {stream_id: 7, property: "audible_notifications", value: true},
        {stream_id: 7, property: "push_notifications", value: true},
        {stream_id: 7, property: "email_notifications", value: true},
        {stream_id: 7, property: "wildcard_mentions_notify", value: true},
    ]);
    assert.deepEqual(
        ykphone_channel_details
            .notification_sub_data(7, "mentions")
            .map((data) => [data.property, data.value]),
        [
            ["desktop_notifications", false],
            ["audible_notifications", false],
            ["push_notifications", false],
            ["email_notifications", false],
            ["wildcard_mentions_notify", true],
        ],
    );
    assert.deepEqual(
        ykphone_channel_details
            .notification_sub_data(7, "none")
            .map((data) => data.value)
            .filter(Boolean),
        [],
    );
});

run_test("the settings tab", () => {
    reset();
    notifications.push_notifications = true;
    assert.deepEqual(ykphone_channel_details.settings_context(make_sub({is_muted: true})), {
        stream_id: 7,
        name: "devel",
        can_rename: true,
        is_subscribed: true,
        notification_choice: "all",
        is_muted: true,
        is_archived: false,
    });

    // An archived channel is neither renamed nor configured.
    const archived = ykphone_channel_details.settings_context(make_sub({is_archived: true}));
    assert.equal(archived.can_rename, false);
    assert.equal(archived.is_subscribed, false);
    assert.equal(ykphone_channel_details.has_settings(make_sub({is_archived: true})), false);

    // An unsubscribed administrator can still rename; a member who is
    // not subscribed has nothing on the tab.
    assert.equal(ykphone_channel_details.has_settings(make_sub({subscribed: false})), true);
    permissions.metadata = false;
    assert.equal(ykphone_channel_details.has_settings(make_sub({subscribed: false})), false);
    assert.equal(ykphone_channel_details.has_settings(make_sub()), true);
});

run_test("renaming rules", () => {
    reset();
    const sub = make_sub();
    assert.equal(
        ykphone_channel_details.name_error("   ", sub),
        "translated: Channel name is required.",
    );
    // The channel's own name is not a conflict.
    assert.equal(ykphone_channel_details.name_error(" devel ", sub), undefined);
    subs_by_name.set("verona", make_sub({stream_id: 8, name: "verona"}));
    assert.equal(
        ykphone_channel_details.name_error("verona", sub),
        "translated: A channel with this name already exists.",
    );
    assert.equal(ykphone_channel_details.name_error("new name", sub), undefined);
    assert.deepEqual(ykphone_channel_details.rename_request_data(" new name "), {
        new_name: "new name",
    });
});

run_test("request bodies", () => {
    reset();
    assert.deepEqual(ykphone_channel_details.description_request_data("  hello  "), {
        description: "hello",
    });
    // Subscribing and unsubscribing go through upstream's
    // subscriber_api, so this module has no payloads of its own for
    // them.
});

run_test("what the confirmations say", () => {
    reset();
    assert.equal(
        ykphone_channel_details.leave_confirm_html(make_sub()),
        "translated: You will no longer receive messages from #devel. You can join it again later.",
    );
    assert.equal(
        ykphone_channel_details.private_leave_confirm_html(make_sub({invite_only: true})),
        "translated: #devel is private. Once you leave, you will need an invitation to join it again.",
    );
});

run_test("the dialog hears of changes", () => {
    reset();
    const seen = [];
    ykphone_channel_details.on_stream_changed((stream_id) => {
        seen.push(stream_id);
    });
    ykphone_channel_details.notify_stream_changed(7);
    ykphone_channel_details.notify_stream_changed(8);
    assert.deepEqual(seen, [7, 8]);
    // Cleared between tests, so a listener never outlives its dialog.
    ykphone_channel_details.clear_for_testing();
    ykphone_channel_details.notify_stream_changed(9);
    assert.deepEqual(seen, [7, 8]);
});
