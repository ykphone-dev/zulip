"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

mock_esm("../src/compose_paste", {
    paste_handler_converter: (html) => `converted(${html})`,
});
mock_esm("../src/compose_reply", {
    generate_replace_content: ({quoted_message, raw_markdown, forward_message}) =>
        `upstream(${quoted_message.id},${raw_markdown},${forward_message})`,
});
mock_esm("../src/hash_util", {
    by_conversation_and_time_url: (message) => `/near/${message.id}`,
});
mock_esm("../src/people", {
    small_avatar_url: (message) => `/avatar/${message.sender_id}`,
});
mock_esm("../src/sub_store", {
    maybe_get_stream_name: (stream_id) => (stream_id === 5 ? "devel" : undefined),
});
mock_esm("../src/timerender", {
    get_localized_date_or_time_for_format: (date, format) => `${format}(${date.getTime()})`,
});

const ykphone_forward_ui = zrequire("ykphone_forward_ui");

function channel_message(overrides = {}) {
    return {
        id: 11,
        type: "stream",
        stream_id: 5,
        topic: "lunch",
        sender_id: 7,
        sender_full_name: "Cordelia",
        timestamp: 1_700_000_000,
        content: "<p>hello</p>",
        ...overrides,
    };
}

run_test("card_context", () => {
    assert.deepEqual(ykphone_forward_ui.card_context(channel_message()), {
        message_id: 11,
        sender_name: "Cordelia",
        avatar_url: "/avatar/7",
        time_label: "dayofyear_time(1700000000000)",
        content: "<p>hello</p>",
    });
});

run_test("quote_markdown", () => {
    // A message in a topic goes through upstream's generator unchanged.
    assert.equal(
        ykphone_forward_ui.quote_markdown(channel_message(), "**hi**"),
        "upstream(11,**hi**,true)",
    );

    // A channel's general chat is the empty topic, which upstream's
    // header renders as a dangling "#devel > "; the fork names the
    // channel alone.
    assert.equal(
        ykphone_forward_ui.quote_markdown(channel_message({topic: ""}), "**hi**"),
        "translated: @_**Cordelia|7** [said](/near/11) in #**devel**:\n```quote\n**hi**\n```",
    );

    // A channel the user can no longer resolve leaves the link out
    // rather than naming "undefined".
    assert.equal(
        ykphone_forward_ui.quote_markdown(channel_message({topic: "", stream_id: 9}), "**hi**"),
        "translated: @_**Cordelia|7** [said](/near/11) in :\n```quote\n**hi**\n```",
    );

    // A fence long enough to clear the content is chosen.
    assert.ok(
        ykphone_forward_ui
            .quote_markdown(channel_message({topic: ""}), "```quote\nnested\n```")
            .includes("````quote"),
    );
});

run_test("fallback_markdown", () => {
    // The sender's own markdown when the store has it, the rendered
    // HTML converted back otherwise — upstream's own fallback.
    assert.equal(
        ykphone_forward_ui.fallback_markdown(channel_message({raw_content: "**hi**"})),
        "**hi**",
    );
    assert.equal(
        ykphone_forward_ui.fallback_markdown(channel_message()),
        "converted(<p>hello</p>)",
    );
});
