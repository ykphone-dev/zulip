"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const $ = require("./lib/zjquery.cjs");

const compose_state = mock_esm("../src/compose_state");
const compose_ui = mock_esm("../src/compose_ui");
const narrow_state = mock_esm("../src/narrow_state");

const ykphone_compose = zrequire("ykphone_compose");

function fake_child(matches) {
    return {
        matches(selector) {
            assert.equal(selector, ".compose-control-buttons-container");
            return matches;
        },
    };
}

run_test("mount", ({mock_template}) => {
    window.localStorage.clear();
    $.clear_all_elements();
    ykphone_compose.clear_for_testing();

    let controls_html;
    mock_template("ykphone_compose_controls.hbs", true, (_data, html) => {
        controls_html = html;
        return html;
    });

    // The bar holds the insert tools directly and the formatting
    // buttons in two nested groups.
    const upload = fake_child(false);
    const group_1 = fake_child(true);
    const group_2 = fake_child(true);
    const emoji = fake_child(false);
    let bar_prepended;
    $.create("#compose .compose-scrollable-buttons", {
        elements: [
            {
                children: [upload, group_1, group_2, emoji],
                prepend(node) {
                    bar_prepended = node;
                },
            },
        ],
    });
    // The new row is built from a fresh div; only its append is
    // observed.
    let row_children;
    const row_attributes = new Map();
    const row_classes = new Set();
    const $row = $.create("<div>", {
        elements: [
            {
                append(...nodes) {
                    row_children = nodes;
                },
                setAttribute(name, value) {
                    row_attributes.set(name, value);
                },
                getAttribute(name) {
                    return row_attributes.get(name) ?? null;
                },
                classList: {
                    add(...names) {
                        for (const name of names) {
                            row_classes.add(name);
                        }
                    },
                    contains: (name) => row_classes.has(name),
                },
            },
        ],
    });
    let messagebox_prepended;
    $.create("#compose .messagebox", {
        elements: [
            {
                prepend(node) {
                    messagebox_prepended = node;
                },
            },
        ],
    });
    const $upload_button = $("#compose .compose_upload_file");
    $upload_button.addClass("zulip-icon-attachment");
    const $send_later_icon = $("#send_later .zulip-icon");
    $send_later_icon.addClass("zulip-icon-more-vertical");
    const $toggle = $("#compose .ykphone-compose-formatting-toggle");
    const $more = $("#compose .ykphone-compose-more");

    ykphone_compose.mount();

    // The formatting groups move into a row of their own at the top of
    // the message box; the insert tools stay in the bar.
    assert.deepEqual(row_children, [group_1, group_2]);
    assert.equal(messagebox_prepended, $row[0]);
    assert.equal($row.attr("id"), "ykphone-compose-formatting-row");
    assert.ok($row.hasClass("ykphone-compose-formatting-row"));
    // The extra controls go to the front of the bar.
    assert.equal(bar_prepended, $(controls_html)[0]);
    assert.ok(controls_html.includes("ykphone-compose-formatting-toggle"));
    assert.ok(controls_html.includes("zulip-icon-at-sign"));
    assert.ok(controls_html.includes("ykphone-compose-more"));
    // Slack's icons for attach and send options.
    assert.ok($upload_button.hasClass("zulip-icon-plus"));
    assert.ok(!$upload_button.hasClass("zulip-icon-attachment"));
    assert.ok($send_later_icon.hasClass("zulip-icon-chevron-down"));
    assert.ok(!$send_later_icon.hasClass("zulip-icon-more-vertical"));
    // The row starts visible for a fresh profile, the extras hidden.
    assert.equal(ykphone_compose.is_formatting_row_hidden(), false);
    assert.ok(!$("#compose").hasClass("ykphone-compose-formatting-hidden"));
    assert.ok($toggle.hasClass("active"));
    assert.equal($toggle.attr("aria-pressed"), "true");
    assert.equal(ykphone_compose.are_extras_open(), false);
    assert.ok(!$("#compose").hasClass("ykphone-compose-extras-open"));
    assert.equal($more.attr("aria-expanded"), "false");
});

run_test("toggle_formatting_row", () => {
    window.localStorage.clear();
    $.clear_all_elements();
    const $compose = $("#compose");
    const $toggle = $("#compose .ykphone-compose-formatting-toggle");

    ykphone_compose.toggle_formatting_row();
    assert.equal(ykphone_compose.is_formatting_row_hidden(), true);
    assert.ok($compose.hasClass("ykphone-compose-formatting-hidden"));
    assert.ok(!$toggle.hasClass("active"));
    assert.equal($toggle.attr("aria-pressed"), "false");

    ykphone_compose.toggle_formatting_row();
    assert.equal(ykphone_compose.is_formatting_row_hidden(), false);
    assert.ok(!$compose.hasClass("ykphone-compose-formatting-hidden"));
    assert.ok($toggle.hasClass("active"));
    assert.equal($toggle.attr("aria-pressed"), "true");
});

run_test("toggle_extras", () => {
    $.clear_all_elements();
    ykphone_compose.clear_for_testing();
    const $compose = $("#compose");
    const $more = $("#compose .ykphone-compose-more");

    ykphone_compose.toggle_extras();
    assert.equal(ykphone_compose.are_extras_open(), true);
    assert.ok($compose.hasClass("ykphone-compose-extras-open"));
    assert.ok($more.hasClass("active"));
    assert.equal($more.attr("aria-expanded"), "true");

    ykphone_compose.toggle_extras();
    assert.equal(ykphone_compose.are_extras_open(), false);
    assert.ok(!$compose.hasClass("ykphone-compose-extras-open"));
    assert.ok(!$more.hasClass("active"));
    assert.equal($more.attr("aria-expanded"), "false");
});

run_test("insert_mention", ({override}) => {
    const inserted = [];
    override(compose_ui, "insert_syntax_and_focus", (syntax) => {
        inserted.push(syntax);
    });
    ykphone_compose.insert_mention();
    assert.deepEqual(inserted, ["@"]);
});

function narrow(opts) {
    return {
        filter: () =>
            opts.filter === undefined
                ? undefined
                : {is_conversation_view: () => opts.conversation ?? false},
        narrowed_by_stream_reply: () => opts.stream_reply ?? false,
        stream_id: () => opts.stream_id,
        topic: () => opts.topic,
        pm_ids_set: () => opts.pm_ids ?? new Set(),
    };
}

function set_narrow(override, opts) {
    for (const [name, f] of Object.entries(narrow(opts))) {
        override(narrow_state, name, f, {unused: false});
    }
}

run_test("channel_narrow_target", ({override}) => {
    // No narrow, or one that is not a single channel conversation.
    set_narrow(override, {filter: undefined});
    assert.equal(ykphone_compose.channel_narrow_target(), undefined);
    set_narrow(override, {filter: {}, stream_id: 3, topic: ""});
    assert.equal(ykphone_compose.channel_narrow_target(), undefined);

    // A channel narrow is its general chat; a conversation view with a
    // channel (a topic, with or without near/with) is that topic.
    set_narrow(override, {filter: {}, stream_reply: true, stream_id: 3, topic: undefined});
    assert.deepEqual(ykphone_compose.channel_narrow_target(), {stream_id: 3, topic: ""});
    set_narrow(override, {filter: {}, conversation: true, stream_id: 3, topic: "Friday"});
    assert.deepEqual(ykphone_compose.channel_narrow_target(), {stream_id: 3, topic: "Friday"});

    // A direct message conversation, or an unknown channel id, has no
    // channel target.
    set_narrow(override, {filter: {}, conversation: true, stream_id: undefined, topic: undefined});
    assert.equal(ykphone_compose.channel_narrow_target(), undefined);
});

run_test("composer_belongs_to_narrow and the recipient row", ({override}) => {
    $.clear_all_elements();
    const $compose = $("#compose");
    let composing = true;
    let message_type = "stream";
    let compose_stream_id = 3;
    let compose_topic = "";
    let recipient_ids = [];
    override(compose_state, "composing", () => composing);
    override(compose_state, "get_message_type", () => message_type);
    override(compose_state, "stream_id", () => compose_stream_id);
    override(compose_state, "topic", () => compose_topic);
    override(compose_state, "private_message_recipient_ids", () => recipient_ids);

    // A closed box belongs nowhere.
    composing = false;
    set_narrow(override, {filter: {}, stream_reply: true, stream_id: 3, topic: undefined});
    assert.equal(ykphone_compose.composer_belongs_to_narrow(), false);
    ykphone_compose.update_recipient_row();
    assert.ok(!$compose.hasClass("ykphone-compose-recipient-implied"));

    // The channel's general chat, with the topic compared loosely.
    composing = true;
    assert.equal(ykphone_compose.composer_belongs_to_narrow(), true);
    ykphone_compose.update_recipient_row();
    assert.ok($compose.hasClass("ykphone-compose-recipient-implied"));
    set_narrow(override, {filter: {}, conversation: true, stream_id: 3, topic: "Friday"});
    compose_topic = "friday";
    assert.equal(ykphone_compose.composer_belongs_to_narrow(), true);

    // Another channel or topic in the box: the row shows.
    compose_stream_id = 4;
    assert.equal(ykphone_compose.composer_belongs_to_narrow(), false);
    ykphone_compose.update_recipient_row();
    assert.ok(!$compose.hasClass("ykphone-compose-recipient-implied"));
    compose_stream_id = 3;
    compose_topic = "Monday";
    assert.equal(ykphone_compose.composer_belongs_to_narrow(), false);

    // Direct messages: the same set of people.
    message_type = "private";
    set_narrow(override, {filter: {}, pm_ids: new Set([7, 8])});
    recipient_ids = [8, 7];
    assert.equal(ykphone_compose.composer_belongs_to_narrow(), true);
    recipient_ids = [8];
    assert.equal(ykphone_compose.composer_belongs_to_narrow(), false);
    set_narrow(override, {filter: {}, pm_ids: new Set()});
    recipient_ids = [];
    assert.equal(ykphone_compose.composer_belongs_to_narrow(), false);

    // No recipient chosen yet (the compose hotkey).
    message_type = undefined;
    assert.equal(ykphone_compose.composer_belongs_to_narrow(), false);
});

run_test("handle_dismiss", ({override}) => {
    $.clear_all_elements();
    let blurred = 0;
    const $focused = $.create("focused-input");
    $focused.on("blur", () => {
        blurred += 1;
    });
    $("#compose").set_find_results(":focus", $focused);

    override(compose_state, "composing", () => true);
    override(compose_state, "get_message_type", () => "stream");
    override(compose_state, "stream_id", () => 3);
    override(compose_state, "topic", () => "");
    set_narrow(override, {filter: {}, stream_reply: true, stream_id: 3, topic: undefined});

    // A box addressed to the conversation only loses focus.
    assert.equal(ykphone_compose.handle_dismiss(), true);
    assert.equal(blurred, 1);

    // Any other box is left to upstream, which closes it.
    set_narrow(override, {filter: {}, stream_reply: true, stream_id: 4, topic: undefined});
    assert.equal(ykphone_compose.handle_dismiss(), false);
    assert.equal(blurred, 1);
});
