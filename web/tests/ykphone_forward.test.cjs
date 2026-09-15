"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const $ = require("./lib/zjquery.cjs");

mock_esm("../src/compose_ui", {
    autosize_textarea() {},
});
mock_esm("../src/rendered_markdown", {
    update_elements() {},
});

let compose_content = "";
mock_esm("../src/compose_state", {
    message_content(value) {
        if (value !== undefined) {
            compose_content = value;
        }
        return compose_content;
    },
});

const {localstorage} = zrequire("localstorage");
const ykphone_forward = zrequire("ykphone_forward");

function make_forward(message_id = 11, markdown = "quote(11)") {
    return {
        card: {
            message_id,
            sender_name: "Cordelia",
            avatar_url: "/avatar/7",
            time_label: "3:21",
            content: "<p>hello</p>",
        },
        markdown,
    };
}

function setup() {
    // The card lives in the compose box; here only its container is
    // real, so that the rendered card can be read back.
    $.clear_all_elements();
    $.create("#ykphone-forward-card-container");
    $.set_results("#ykphone-forward-card", []);
    $.set_results("#ykphone-forward-card .ykphone-forward-card-content", []);
    localstorage().set("ykphone-forwards", {});
    compose_content = "";
    ykphone_forward.clear_for_testing();
}

run_test("nothing is stored before the first draft is saved", () => {
    $.clear_all_elements();
    $.create("#ykphone-forward-card-container");
    ykphone_forward.restore_for_draft("d0");
    assert.equal(ykphone_forward.pending_message_id(), undefined);
});

run_test("the quote is folded in just before the send", () => {
    setup();
    assert.equal(ykphone_forward.pending_message_id(), undefined);
    ykphone_forward.arm(make_forward());
    assert.equal(ykphone_forward.pending_message_id(), 11);
    // The card names the message being forwarded.
    const card_html = $("#ykphone-forward-card-container").html();
    assert.ok(card_html.includes("Cordelia"));
    assert.ok(card_html.includes('data-message-id="11"'));

    // Without a note of their own, the user forwards the quote alone.
    ykphone_forward.apply_to_compose();
    assert.equal(compose_content, "quote(11)");
    assert.equal(ykphone_forward.pending_message_id(), undefined);

    // The forward is spent: clear() (which every successful send runs
    // through compose.clear_compose_box) drops it for good.
    ykphone_forward.clear();
    ykphone_forward.apply_to_compose();
    assert.equal(compose_content, "quote(11)");

    // With a note, the quote goes in front of it.
    ykphone_forward.arm(make_forward());
    compose_content = "look at this";
    ykphone_forward.apply_to_compose();
    assert.equal(compose_content, "quote(11)\n\nlook at this");
});

run_test("a message that is not sent keeps its card", () => {
    setup();
    // Forwarding opens the recipient picker, so pressing send before
    // choosing one is an ordinary mistake: the note and the card come
    // back rather than a box full of quote markdown.
    ykphone_forward.arm(make_forward());
    compose_content = "look at this";
    ykphone_forward.apply_to_compose();
    assert.equal(compose_content, "quote(11)\n\nlook at this");
    ykphone_forward.restore();
    assert.equal(compose_content, "look at this");
    assert.equal(ykphone_forward.pending_message_id(), 11);

    // Sending again folds it exactly once.
    ykphone_forward.apply_to_compose();
    assert.equal(compose_content, "quote(11)\n\nlook at this");

    // Restoring a send that carried no forward changes nothing.
    ykphone_forward.clear();
    compose_content = "plain";
    ykphone_forward.restore();
    assert.equal(compose_content, "plain");
});

run_test("the raw markdown arrives after the card is up", () => {
    setup();
    ykphone_forward.arm(make_forward(11, "fallback(11)"));
    // A late answer for a superseded forward is dropped.
    ykphone_forward.set_markdown(12, "quote(12)");
    ykphone_forward.apply_to_compose();
    assert.equal(compose_content, "fallback(11)");

    setup();
    ykphone_forward.arm(make_forward(11, "fallback(11)"));
    ykphone_forward.set_markdown(11, "quote(11)");
    ykphone_forward.apply_to_compose();
    assert.equal(compose_content, "quote(11)");
});

run_test("the compose box being replaced drops the forward", () => {
    setup();
    ykphone_forward.arm(make_forward());
    ykphone_forward.clear();
    assert.equal(ykphone_forward.pending_message_id(), undefined);
    ykphone_forward.apply_to_compose();
    assert.equal(compose_content, "");
});

run_test("a forward rides along with its draft", () => {
    setup();
    ykphone_forward.arm(make_forward());
    ykphone_forward.remember_for_draft("d1");
    // Closing the box (or a reload) drops the in-memory forward…
    ykphone_forward.clear();
    assert.equal(ykphone_forward.pending_message_id(), undefined);
    // …and restoring the draft brings the card and the quote back.
    ykphone_forward.restore_for_draft("d1");
    assert.equal(ykphone_forward.pending_message_id(), 11);
    ykphone_forward.apply_to_compose();
    assert.equal(compose_content, "quote(11)");

    // A draft with no forward of its own restores nothing.
    ykphone_forward.clear();
    ykphone_forward.restore_for_draft("d2");
    assert.equal(ykphone_forward.pending_message_id(), undefined);

    // Saving the same draft without a forward clears its entry, so a
    // later restore cannot resurrect one; doing it twice is a no-op.
    ykphone_forward.remember_for_draft("d1");
    ykphone_forward.remember_for_draft("d1");
    ykphone_forward.restore_for_draft("d1");
    assert.equal(ykphone_forward.pending_message_id(), undefined);
});

run_test("a deleted draft takes its forward with it", () => {
    setup();
    ykphone_forward.arm(make_forward());
    ykphone_forward.remember_for_draft("d1");
    ykphone_forward.clear();

    // Deleting other drafts leaves it alone.
    ykphone_forward.forget_drafts(["d2", "d3"]);
    ykphone_forward.restore_for_draft("d1");
    assert.equal(ykphone_forward.pending_message_id(), 11);

    ykphone_forward.clear();
    ykphone_forward.forget_drafts(["d1"]);
    ykphone_forward.restore_for_draft("d1");
    assert.equal(ykphone_forward.pending_message_id(), undefined);
});

run_test("stored forwards are bounded and validated", () => {
    setup();
    ykphone_forward.arm(make_forward());
    for (let i = 0; i < 25; i += 1) {
        ykphone_forward.remember_for_draft(`d${i}`);
    }
    const stored = localstorage().get("ykphone-forwards");
    assert.equal(Object.keys(stored).length, 20);
    assert.equal(stored.d0, undefined);
    assert.ok(stored.d24 !== undefined);

    // Anything else in that key is ignored rather than trusted.
    localstorage().set("ykphone-forwards", {d1: {nonsense: true}});
    ykphone_forward.clear();
    ykphone_forward.restore_for_draft("d1");
    assert.equal(ykphone_forward.pending_message_id(), undefined);
    ykphone_forward.arm(make_forward());
    ykphone_forward.remember_for_draft("d1");
    assert.equal(Object.keys(localstorage().get("ykphone-forwards")).length, 1);
});
