"use strict";

const assert = require("node:assert/strict");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const hooks = zrequire("ykphone_rich_hooks");

const compose_textarea = {id: "compose-textarea"};
const edit_textarea = {id: "message-edit"};

function register(calls) {
    hooks.register({
        owns: (textarea) => textarea === compose_textarea,
        has_focus: () => true,
        send_error: (show_banner) => (show_banner ? "cannot send" : undefined),
        format_text(type, inserted_content) {
            calls.push(["format_text", type, inserted_content]);
            return type === "bold";
        },
        replace_syntax(old_syntax, new_syntax) {
            calls.push(["replace_syntax", old_syntax, new_syntax]);
            return true;
        },
        insert_text(content, replace_all, keep_undo) {
            calls.push(["insert_text", content, replace_all, keep_undo]);
        },
    });
}

run_test("upstream's compose code reaches the composer, and only its own box", () => {
    const calls = [];
    register(calls);

    assert.ok(hooks.has_focus());
    assert.equal(hooks.send_error(true), "cannot send");
    assert.equal(hooks.send_error(false), undefined);
    assert.ok(hooks.format_text(compose_textarea, "bold", undefined));
    // A type the composer leaves to upstream.
    assert.ok(!hooks.format_text(compose_textarea, "bulleted", undefined));
    assert.equal(hooks.replace_syntax(compose_textarea, "old", "new"), true);
    assert.ok(hooks.insert_text(compose_textarea, "text", false, false));
    // replace_all and the undo-less variant both replace everything;
    // only the second one starts the history afresh.
    hooks.insert_text(compose_textarea, "all", true, false);
    hooks.insert_text(compose_textarea, "draft", false, true);
    assert.deepEqual(calls, [
        ["format_text", "bold", undefined],
        ["format_text", "bulleted", undefined],
        ["replace_syntax", "old", "new"],
        ["insert_text", "text", false, true],
        ["insert_text", "all", true, true],
        ["insert_text", "draft", true, false],
    ]);

    // The message edit box is not the composer's, and neither is a
    // missing one.
    assert.ok(!hooks.format_text(edit_textarea, "bold", undefined));
    assert.equal(hooks.replace_syntax(edit_textarea, "old", "new"), undefined);
    assert.ok(!hooks.insert_text(edit_textarea, "text", false, false));
    assert.ok(!hooks.format_text(undefined, "bold", undefined));
    assert.equal(calls.length, 6);
});

run_test("with no composer mounted, upstream keeps its own behavior", () => {
    hooks.register(undefined);
    assert.ok(!hooks.has_focus());
    assert.equal(hooks.send_error(true), undefined);
    assert.ok(!hooks.format_text(compose_textarea, "bold", undefined));
    assert.equal(hooks.replace_syntax(compose_textarea, "old", "new"), undefined);
    assert.ok(!hooks.insert_text(compose_textarea, "text", false, false));
});
