"use strict";

const assert = require("node:assert/strict");

const {run_test} = require("./lib/test.cjs");

const quick_reactions = [
    {
        emoji_name: "check",
        emoji_code: "2705",
        is_realm_emoji: false,
        label: "React with :check:",
        emoji_alt_code: false,
    },
    {
        emoji_name: "party_parrot",
        emoji_code: "101",
        is_realm_emoji: true,
        url: "/emoji/parrot.gif",
        label: "React with :party_parrot:",
        emoji_alt_code: false,
    },
];

function render(msg, extra = {}) {
    return require("../templates/message_controls.hbs")({
        msg,
        ykphone_quick_reactions: quick_reactions,
        ...extra,
    });
}

function control_classes(html) {
    return [...html.matchAll(/<div class="([\w-]+)[^"]*message_control_button/g)].map(
        (match) => match[1],
    );
}

run_test("the hover toolbar", () => {
    // Slack shows the same toolbar on every message, so that its
    // width and its left edge do not depend on who sent the message:
    // upstream leaves the emoji-reaction button off one's own
    // messages and prepends an edit/move pair to them instead.
    // Editing moved to the ⋮ menu (and the "e" hotkey); moving a
    // message is gone with the topics it exists for.
    let previous;
    for (const sent_by_me of [true, false]) {
        const html = render(
            {sent_by_me, starred: false, locally_echoed: false},
            {ykphone_can_thread: true},
        );
        assert.ok(!html.includes("edit_content_button"));
        assert.ok(!html.includes("move_message_button"));
        // Left to right: one-click reactions, the emoji picker, reply
        // in thread, forward, save, and the ⋮ menu last.
        assert.deepEqual(control_classes(html), [
            "ykphone-quick-reaction",
            "ykphone-quick-reaction",
            "reaction_button",
            "ykphone-thread-button",
            "ykphone-forward-button",
            "star_container",
            "actions_hover",
        ]);
        if (previous !== undefined) {
            assert.equal(html, previous);
        }
        previous = html;
    }

    // The one-click reactions: a sprite, or a custom emoji's image.
    const html = render({starred: false});
    assert.ok(html.includes('data-emoji-name="check"'));
    assert.ok(html.includes('class="emoji emoji-2705"'));
    assert.ok(html.includes('<img src="/emoji/parrot.gif" class="emoji"'));
    assert.ok(html.includes('aria-label="React with :check:"'));
    // Direct messages have no thread button.
    assert.ok(!html.includes("ykphone-thread-button"));
    const text_emoji = render(
        {starred: false},
        {ykphone_quick_reactions: [{...quick_reactions[0], emoji_alt_code: true}]},
    );
    assert.ok(text_emoji.includes('<span class="emoji_alt_code">:check:</span>'));

    // An archived conversation has no reactions of either kind.
    const archived = render({sent_by_me: true}, {is_archived: true});
    assert.ok(!archived.includes("reaction_button"));
    assert.ok(!archived.includes("ykphone-quick-reaction"));

    // A message still being sent has no id the server knows, so none of
    // the buttons that act on one are live yet; their slots keep the
    // toolbar's width (upstream showed no reaction button on one's own
    // messages at all, and every echo is one's own).
    const echoed = render({locally_echoed: true});
    assert.deepEqual(control_classes(echoed), control_classes(render({})));
    assert.ok(!echoed.includes("zulip-icon-forward-message"));
    assert.ok(!echoed.includes("ykphone-quick-reaction-emoji"));
    assert.ok(!echoed.includes("emoji-2705"));
    assert.ok(!echoed.includes("zulip-icon-smile"));
    assert.ok(!echoed.includes("zulip-icon-bookmark"));

    // Zulip's star is the fork's "saved messages" bookmark.
    assert.ok(render({starred: false}).includes("zulip-icon-bookmark"));
    assert.ok(render({starred: true}).includes("zulip-icon-bookmark-filled"));
});
