"use strict";

const assert = require("node:assert/strict");

const {run_test} = require("./lib/test.cjs");

function render(msg, extra = {}) {
    return require("../templates/message_controls.hbs")({msg, ...extra});
}

run_test("the hover toolbar", () => {
    // Upstream leaves the emoji-reaction button off one's own
    // messages; Slack offers it on every message, one's own included.
    for (const sent_by_me of [true, false]) {
        const html = render({sent_by_me, starred: false, locally_echoed: false});
        assert.ok(html.includes("reaction_button"));
        assert.ok(html.includes("actions_hover"));
        assert.ok(html.includes("star_container"));
        // The edit/move pair stays the sender's own.
        assert.equal(html.includes("edit_content_button"), sent_by_me);
    }

    // An archived conversation has neither.
    const archived = render({sent_by_me: true}, {is_archived: true});
    assert.ok(!archived.includes("reaction_button"));
    assert.ok(!archived.includes("edit_content_button"));

    // Zulip's star is the fork's "saved messages" bookmark.
    assert.ok(render({starred: false}).includes("zulip-icon-bookmark"));
    assert.ok(render({starred: true}).includes("zulip-icon-bookmark-filled"));
});
