"use strict";

const assert = require("node:assert/strict");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const hooks = zrequire("ykphone_rich_hooks");

const compose_textarea = {id: "compose-textarea"};
const edit_textarea = {className: "message_edit_content"};
const other_edit_textarea = {className: "message_edit_content"};

function handlers(textarea, calls, {focused = false, error} = {}) {
    return {
        textarea,
        has_focus: () => focused,
        flush() {
            calls.push([textarea, "flush"]);
        },
        send_error: (show_banner) => (show_banner ? error : undefined),
        format_text(type, inserted_content) {
            calls.push([textarea, "format_text", type, inserted_content]);
            return type === "bold";
        },
        replace_syntax(old_syntax, new_syntax) {
            calls.push([textarea, "replace_syntax", old_syntax, new_syntax]);
            return true;
        },
        insert_text(content, replace_all, keep_undo) {
            calls.push([textarea, "insert_text", content, replace_all, keep_undo]);
        },
    };
}

run_test("upstream's compose code reaches the composer, and only its own box", () => {
    const calls = [];
    hooks.register(handlers(compose_textarea, calls, {focused: true, error: "cannot send"}));

    assert.ok(hooks.has_focus());
    assert.ok(hooks.editor_has_focus());
    // Upstream reads the focused editor's textarea written up to date.
    assert.equal(hooks.focused_element(null), compose_textarea);
    assert.deepEqual(calls.splice(0), [[compose_textarea, "flush"]]);
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
    assert.deepEqual(
        calls.map((call) => call.slice(1)),
        [
            ["format_text", "bold", undefined],
            ["format_text", "bulleted", undefined],
            ["replace_syntax", "old", "new"],
            ["insert_text", "text", false, true],
            ["insert_text", "all", true, true],
            ["insert_text", "draft", true, false],
        ],
    );

    // A message edit box with no editor of its own is not the
    // composer's, and neither is a missing one.
    assert.ok(!hooks.format_text(edit_textarea, "bold", undefined));
    assert.equal(hooks.replace_syntax(edit_textarea, "old", "new"), undefined);
    assert.ok(!hooks.insert_text(edit_textarea, "text", false, false));
    assert.equal(hooks.send_error_for(edit_textarea, true), undefined);
    assert.ok(!hooks.format_text(undefined, "bold", undefined));
    assert.equal(calls.length, 6);
});

run_test("edit forms and the thread panel have editors of their own", () => {
    const calls = [];
    hooks.register(handlers(compose_textarea, calls));
    const unregister_edit = hooks.register_editor(
        handlers(edit_textarea, calls, {focused: true, error: "lossy edit"}),
    );
    const unregister_other = hooks.register_editor(handlers(other_edit_textarea, calls));

    // Focus in an edit form is typing, but not focus in the compose box.
    assert.ok(!hooks.has_focus());
    assert.ok(hooks.editor_has_focus());
    const active = {className: "ProseMirror"};
    assert.equal(hooks.focused_element(active), edit_textarea);
    assert.equal(hooks.registered_editor_count(), 2);
    assert.deepEqual(calls.splice(0), [[edit_textarea, "flush"]]);
    // The compose box's own check is not the edit form's.
    assert.equal(hooks.send_error(true), undefined);
    assert.equal(hooks.send_error_for(edit_textarea, true), "lossy edit");
    assert.equal(hooks.send_error_for(other_edit_textarea, true), undefined);

    // Each call reaches the editor owning the textarea it names.
    assert.ok(hooks.format_text(other_edit_textarea, "bold", undefined));
    assert.equal(hooks.replace_syntax(edit_textarea, "old", "new"), true);
    assert.ok(hooks.insert_text(other_edit_textarea, "text", false, false));
    assert.deepEqual(calls, [
        [other_edit_textarea, "format_text", "bold", undefined],
        [edit_textarea, "replace_syntax", "old", "new"],
        [other_edit_textarea, "insert_text", "text", false, true],
    ]);

    unregister_edit();
    assert.ok(!hooks.editor_has_focus());
    assert.equal(hooks.focused_element(active), active);
    assert.ok(!hooks.format_text(edit_textarea, "bold", undefined));
    unregister_other();
    assert.ok(!hooks.insert_text(other_edit_textarea, "text", false, false));
    assert.equal(hooks.registered_editor_count(), 0);
});

run_test("an editor's recipient answers for compose_state while its typeahead runs", () => {
    const thread_input = {name: "thread shadow"};
    const snippet_input = {name: "snippet shadow"};
    const banners = {name: "panel banners"};
    const thread = {message_type: "stream", stream_id: 5, topic: "plans", banners};
    const snippet = {message_type: undefined, stream_id: undefined, topic: "", banners: undefined};
    hooks.set_recipient(thread_input, thread);
    hooks.set_recipient(snippet_input, snippet);

    assert.equal(hooks.recipient_for(thread_input), thread);
    assert.equal(hooks.recipient_for(undefined), undefined);
    // The compose box's own shadow has no recipient of its own.
    assert.equal(hooks.recipient_for(compose_textarea), undefined);

    assert.equal(hooks.current_recipient(), undefined);
    const seen = hooks.with_recipient_of(thread_input, () => {
        // Nested, the inner editor's recipient answers, then the outer's
        // again.
        const inner = hooks.with_recipient_of(snippet_input, () => hooks.current_recipient());
        return [inner, hooks.current_recipient()];
    });
    assert.deepEqual(seen, [snippet, thread]);
    assert.equal(hooks.current_recipient(), undefined);
    // An input without a recipient leaves compose_state to itself.
    assert.equal(
        hooks.with_recipient_of(compose_textarea, () => hooks.current_recipient()),
        undefined,
    );
    // Also when upstream's code throws.
    assert.throws(() =>
        hooks.with_recipient_of(thread_input, () => {
            throw new Error("upstream failed");
        }),
    );
    assert.equal(hooks.current_recipient(), undefined);
});

run_test("fields holding message Markdown get an editor where one can be made", () => {
    const mounted = [];
    // Before the editors are set up, nothing happens.
    hooks.mount_plain_editor(edit_textarea);
    hooks.set_plain_editor_mounter((textarea) => {
        mounted.push(textarea);
    });
    hooks.mount_plain_editor(edit_textarea);
    // A field that is not in the page is left alone.
    hooks.mount_plain_editor(undefined);
    assert.deepEqual(mounted, [edit_textarea]);
    hooks.set_plain_editor_mounter(undefined);
});

run_test("with no editor mounted, upstream keeps its own behavior", () => {
    hooks.register(undefined);
    const unregister = hooks.register_editor(handlers(edit_textarea, []));
    unregister();
    assert.ok(!hooks.has_focus());
    assert.ok(!hooks.editor_has_focus());
    assert.equal(hooks.focused_element(null), null);
    assert.equal(hooks.send_error(true), undefined);
    assert.ok(!hooks.format_text(compose_textarea, "bold", undefined));
    assert.equal(hooks.replace_syntax(compose_textarea, "old", "new"), undefined);
    assert.ok(!hooks.insert_text(compose_textarea, "text", false, false));
});
