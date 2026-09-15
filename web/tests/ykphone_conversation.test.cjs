"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const $ = require("./lib/zjquery.cjs");

const verona = {
    stream_id: 3,
    name: "Verona",
    invite_only: false,
    is_web_public: false,
    is_archived: false,
    rendered_description: "<p>Plans</p>",
    date_created: 1_700_000_000,
    creator_id: 7,
};

mock_esm("../src/hash_util", {
    channels_settings_edit_url: (sub, section) => `#channels/${sub.stream_id}/${section}`,
});
mock_esm("../src/message_store", {
    get_pm_full_names: (user_ids) => user_ids.map((user_id) => `User ${user_id}`).join(", "),
});
const narrow_state = mock_esm("../src/narrow_state");
mock_esm("../src/people", {
    maybe_get_user_by_id: (user_id) =>
        user_id === 7 ? {user_id: 7, full_name: "Cordelia"} : undefined,
    sorted_other_user_ids: (user_ids) => user_ids.filter((user_id) => user_id !== 1),
    get_by_user_id: (user_id) => ({user_id}),
    medium_avatar_url_for_person: (person) => `/avatar/${person.user_id}/medium`,
});
const rendered_markdown = mock_esm("../src/rendered_markdown");
mock_esm("../src/stream_data", {
    get_sub_by_id: (stream_id) => (stream_id === verona.stream_id ? verona : undefined),
});
mock_esm("../src/timerender", {
    get_localized_date_or_time_for_format: (date, format) => `${format}:${date.getTime() / 1000}`,
});

const ykphone_conversation = zrequire("ykphone_conversation");

function fake_filter({term_types, conversation = true}) {
    return {
        is_conversation_view: () => conversation,
        sorted_term_types: () => term_types,
    };
}

run_test("narrow classification", () => {
    assert.equal(ykphone_conversation.is_conversation(undefined), false);
    assert.equal(
        ykphone_conversation.is_conversation(fake_filter({term_types: ["channel", "topic"]})),
        true,
    );
    const files = fake_filter({term_types: ["channel", "has-attachment"], conversation: false});
    assert.equal(ykphone_conversation.is_channel_files_narrow(files), true);
    assert.equal(
        ykphone_conversation.is_channel_files_narrow(fake_filter({term_types: ["channel"]})),
        false,
    );
    assert.deepEqual(ykphone_conversation.empty_narrow_banner(files), {
        title: "translated: No files have been shared in this channel yet.",
    });
    assert.equal(
        ykphone_conversation.empty_narrow_banner(fake_filter({term_types: ["channel"]})),
        undefined,
    );
});

run_test("body class", ({override}) => {
    const $body = $("body");
    let filter = fake_filter({term_types: ["dm"]});
    override(narrow_state, "filter", () => filter);
    ykphone_conversation.handle_narrow_activated();
    assert.ok($body.hasClass("ykphone-conversation"));

    filter = fake_filter({term_types: ["channel"], conversation: false});
    ykphone_conversation.update_body_class();
    assert.ok(!$body.hasClass("ykphone-conversation"));
});

run_test("intro_context", ({override}) => {
    // Not a conversation: nothing.
    assert.equal(ykphone_conversation.intro_context(undefined), undefined);

    // A channel's general chat: the channel intro.
    const channel_filter = fake_filter({term_types: ["channel", "topic"]});
    override(narrow_state, "stream_id", () => verona.stream_id);
    override(narrow_state, "topic", () => "");
    assert.deepEqual(ykphone_conversation.intro_context(channel_filter), {
        channel: {
            name: "Verona",
            invite_only: false,
            is_web_public: false,
            is_archived: false,
            description_html: "<p>Plans</p>",
            created_label: "translated: Created by Cordelia on dayofyear_year:1700000000.",
            settings_url: "#channels/3/general",
        },
    });

    // A thread's full view has no intro, nor does an unknown channel.
    override(narrow_state, "topic", () => "Shall we ship?");
    assert.equal(ykphone_conversation.intro_context(channel_filter), undefined);
    override(narrow_state, "topic", () => "");
    override(narrow_state, "stream_id", () => 99);
    assert.equal(ykphone_conversation.intro_context(channel_filter), undefined);

    // The creator may be gone.
    override(narrow_state, "stream_id", () => verona.stream_id);
    verona.creator_id = null;
    assert.equal(
        ykphone_conversation.intro_context(channel_filter).channel.created_label,
        "translated: Created on dayofyear_year:1700000000.",
    );
    verona.creator_id = 8;
    assert.equal(
        ykphone_conversation.intro_context(channel_filter).channel.created_label,
        "translated: Created on dayofyear_year:1700000000.",
    );

    // Direct messages: the other people's avatars and names; a
    // conversation with yourself shows your own.
    const dm_filter = fake_filter({term_types: ["dm"]});
    override(narrow_state, "stream_id", () => undefined);
    override(narrow_state, "pm_ids_set", () => new Set([1, 7]));
    assert.deepEqual(ykphone_conversation.intro_context(dm_filter), {
        dm: {avatar_urls: ["/avatar/7/medium"], names: "User 1, User 7", is_self: false},
    });
    override(narrow_state, "pm_ids_set", () => new Set([1]));
    assert.deepEqual(ykphone_conversation.intro_context(dm_filter), {
        dm: {avatar_urls: ["/avatar/1/medium"], names: "User 1", is_self: true},
    });
    override(narrow_state, "pm_ids_set", () => new Set());
    assert.equal(ykphone_conversation.intro_context(dm_filter), undefined);
});

run_test("update_intro", ({override, mock_template}) => {
    $.clear_all_elements();
    const $intro = $("#ykphone-conversation-intro");
    const $markdown = $.create("intro-markdown");
    $intro.set_find_results(".rendered_markdown", $markdown);
    let rendered;
    mock_template("ykphone_conversation_intro.hbs", false, (data) => {
        rendered = data;
        return "<intro>";
    });
    const updated = [];
    override(rendered_markdown, "update_elements", ($elements) => {
        updated.push($elements);
    });

    let found_oldest = true;
    let history_limited = false;
    const msg_list = {
        data: {
            fetch_status: {
                has_found_oldest: () => found_oldest,
                history_limited: () => history_limited,
            },
        },
    };
    const channel_filter = fake_filter({term_types: ["channel", "topic"]});
    override(narrow_state, "filter", () => channel_filter);
    override(narrow_state, "stream_id", () => verona.stream_id);
    override(narrow_state, "topic", () => "");

    // Shown once the list reaches the start of the history.
    ykphone_conversation.update_intro(msg_list);
    assert.equal(rendered.channel.name, "Verona");
    assert.equal($intro.html(), "<intro>");
    assert.ok($intro.visible());
    assert.equal(updated.length, 1);
    assert.equal(updated[0][0], $markdown[0]);

    // Hidden while older messages may still exist, when the history
    // is limited by the plan, and outside conversations.
    found_oldest = false;
    ykphone_conversation.update_intro(msg_list);
    assert.ok(!$intro.visible());
    found_oldest = true;
    history_limited = true;
    ykphone_conversation.update_intro(msg_list);
    assert.ok(!$intro.visible());
    history_limited = false;
    override(narrow_state, "filter", () =>
        fake_filter({term_types: ["is-starred"], conversation: false}),
    );
    ykphone_conversation.update_intro(msg_list);
    assert.ok(!$intro.visible());

    // Direct messages have no markdown to post-process.
    updated.length = 0;
    override(narrow_state, "filter", () => fake_filter({term_types: ["dm"]}));
    override(narrow_state, "stream_id", () => undefined);
    override(narrow_state, "pm_ids_set", () => new Set([7]));
    ykphone_conversation.update_intro(msg_list);
    assert.deepEqual(rendered.dm.avatar_urls, ["/avatar/7/medium"]);
    assert.ok($intro.visible());
    assert.equal(updated.length, 0);

    ykphone_conversation.hide_intro();
    assert.ok(!$intro.visible());
});
