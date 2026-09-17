"use strict";

const assert = require("node:assert/strict");

const {run_test} = require("./lib/test.cjs");

function render(msg, extra = {}) {
    return require("../templates/message_controls.hbs")({msg, ...extra});
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
        const html = render({sent_by_me, starred: false, locally_echoed: false});
        assert.ok(html.includes("reaction_button"));
        assert.ok(html.includes("actions_hover"));
        assert.ok(html.includes("star_container"));
        assert.ok(!html.includes("edit_content_button"));
        assert.ok(!html.includes("move_message_button"));
        if (previous !== undefined) {
            assert.equal(html, previous);
        }
        previous = html;
    }

    // An archived conversation has no reaction button.
    const archived = render({sent_by_me: true}, {is_archived: true});
    assert.ok(!archived.includes("reaction_button"));

    // Zulip's star is the fork's "saved messages" bookmark.
    assert.ok(render({starred: false}).includes("zulip-icon-bookmark"));
    assert.ok(render({starred: true}).includes("zulip-icon-bookmark-filled"));
});
