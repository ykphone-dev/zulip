"use strict";

const assert = require("node:assert/strict");

const {JSDOM} = require("jsdom");
const {history, undo} = require("prosemirror-history");
const {EditorState, TextSelection} = require("prosemirror-state");

const {clock, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const md = zrequire("ykphone_rich_markdown");
const {schema} = zrequire("ykphone_rich_schema");
const sync_module = zrequire("ykphone_rich_sync");

const dom = new JSDOM("<textarea id='compose-textarea'></textarea>");
global.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
global.Event = dom.window.Event;

const context = {
    ...md.default_context,
    is_user_mention: (name) => ["Iago", "Iago|11"].includes(name),
    is_stream: (name) => name === "Verona",
    is_emoji: (name) => name === "smile",
};

// An editor without a DOM: the sync only needs the state, the ability to
// apply transactions, and to know whether an IME is composing.
function make_editor(markdown = "") {
    const textarea = dom.window.document.createElement("textarea");
    dom.window.document.body.append(textarea);
    const create_state = (doc) => EditorState.create({doc, plugins: [history()]});
    const view = {
        state: create_state(md.parse_markdown(markdown, context)),
        composing: false,
        dispatch(tr) {
            this.state = this.state.apply(tr);
            sync.after_transaction(tr);
        },
        updateState(state) {
            this.state = state;
        },
    };
    const inputs = [];
    textarea.addEventListener("input", () => {
        inputs.push(textarea.value);
    });
    const lossy = [];
    const flushes = [];
    const sync = sync_module.create_sync({
        view,
        textarea,
        context: () => context,
        create_state,
        on_lossy: (value) => lossy.push(value),
        on_flush: (value) => flushes.push(value),
    });
    const type = (value, at) => {
        const {from, to} = view.state.selection;
        const start = at ?? from;
        view.dispatch(view.state.tr.insertText(value, start, at ?? to));
    };
    return {view, textarea, sync, inputs, lossy, flushes, type, create_state};
}

// Lets the microtask the sync uses to follow the textarea's cursor run;
// the test harness fakes timers, so it has to be asked for.
const settle = () => {
    clock.runMicrotasks();
};

run_test("the editor writes Markdown to the textarea", () => {
    const {view, textarea, sync, inputs, type} = make_editor();
    type("hello");
    assert.equal(textarea.value, "hello");
    assert.deepEqual(inputs, ["hello"]);
    assert.deepEqual(sync.selection_offsets(), {start: 5, end: 5});
    assert.equal(textarea.selectionStart, 5);

    // Formatting is written as Markdown, and the selection as the
    // offsets of the text it holds, not of the syntax around it.
    const tr = view.state.tr.addMark(1, 6, schema.marks.strong.create());
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 1, 6)));
    assert.equal(textarea.value, "**hello**");
    assert.equal(sync.markdown(), "**hello**");
    assert.deepEqual(sync.selection_offsets(), {start: 2, end: 7});
    settle();
});

run_test("what upstream writes to the textarea reaches the editor", () => {
    const {view, textarea, sync, type} = make_editor();
    type("draft");
    // Setting the value is how upstream clears the box and restores a
    // draft; the editor takes it as a new document, undo history and
    // all, like a textarea.
    textarea.value = "restored @**Iago** text";
    assert.equal(view.state.doc.toString(), 'doc(paragraph("restored ", mention, " text"))');
    assert.equal(sync.markdown(), "restored @**Iago** text");
    undo(view.state, view.dispatch);
    assert.equal(sync.markdown(), "restored @**Iago** text");

    // text-field-edit changes the value in place and fires "input".
    textarea.value = "restored @**Iago** text!";
    textarea.dispatchEvent(new dom.window.Event("input"));
    assert.equal(sync.markdown(), "restored @**Iago** text!");

    // Upstream moves the textarea's cursor after changing its text (a
    // list toggled, a placeholder selected); the editor follows.
    textarea.value = "restored @**Iago** text!!";
    textarea.setSelectionRange(3, 3);
    settle();
    assert.equal(view.state.selection.from, 4);
});

run_test("inserting at the cursor, and replacing syntax", () => {
    const {view, textarea, sync, inputs, type} = make_editor();
    type("note: ");
    // What compose_ui.insert_and_scroll_into_view does for an upload,
    // a call link or a snippet.
    sync.insert_text("[Uploading a.png…]()", false, true);
    assert.equal(sync.markdown(), "note: [Uploading a.png…]()");
    assert.equal(view.state.doc.toString(), 'doc(paragraph("note: ", upload))');
    assert.equal(view.state.selection.from, 8);

    assert.ok(sync.replace_syntax("[Uploading a.png…]()", "![a.png](/user_uploads/1/a.png)"));
    assert.equal(sync.markdown(), "note: ![a.png](/user_uploads/1/a.png)");
    // Nothing to replace: the composer says so, as upstream's does.
    assert.equal(sync.replace_syntax("[Uploading b.png…]()", "x"), false);

    // Replacing everything, the way a draft is restored.
    sync.insert_text("fresh start", true, false);
    assert.equal(sync.markdown(), "fresh start");
    assert.equal(view.state.selection.from, 12);
    assert.ok(inputs.includes("fresh start"));

    sync.set_markdown("@**Iago** hi", 9);
    assert.equal(view.state.selection.from, 2);
    sync.select_offsets(0, 9);
    assert.deepEqual(sync.selection_offsets(), {start: 0, end: 9});
    settle();
});

run_test("a composition is not interrupted", () => {
    const {view, textarea, sync, type} = make_editor();
    type("한");
    view.composing = true;
    textarea.setSelectionRange(0, 0);
    textarea.value = "한글";
    settle();
    // The document follows the textarea, but the cursor is left where
    // the composition is.
    assert.equal(sync.markdown(), "한글");
    assert.equal(view.state.selection.from, 3);
    view.composing = false;
});

run_test("the textarea's cursor is followed only where it went", () => {
    const {view, textarea, sync} = make_editor();
    // Setting the value leaves the cursor at the end of the text, where
    // the editor's cursor is too; there is nothing to follow.
    textarea.value = "abc";
    assert.equal(textarea.selectionStart, 3);
    assert.deepEqual(sync.selection_offsets(), {start: 3, end: 3});
    const cursor = view.state.selection.from;
    settle();
    assert.equal(view.state.selection.from, cursor);
});

run_test("a change that leaves the Markdown alone is not written back", () => {
    const {view, textarea, inputs, sync, type} = make_editor();
    type("ab");
    sync.flush();
    const written = inputs.length;
    // A character typed and taken back again in one transaction.
    view.dispatch(view.state.tr.insertText("x", 1).delete(1, 2));
    assert.equal(textarea.value, "ab");
    assert.equal(inputs.length, written);
});

run_test("formatting Markdown cannot hold is reported", () => {
    const {view, lossy, sync} = make_editor();
    view.dispatch(
        view.state.tr.replaceWith(0, view.state.doc.content.size, [
            schema.node("paragraph", null, [
                schema.text("a", [schema.marks.em.create()]),
                schema.text("b", [schema.marks.strong.create()]),
            ]),
        ]),
    );
    sync.flush();
    assert.equal(lossy.length, 1);
});

run_test("the textarea is left as it was found", () => {
    const {textarea, sync} = make_editor("hello");
    assert.equal(textarea.value, "");
    sync.destroy();
    textarea.value = "plain";
    assert.equal(textarea.value, "plain");
    assert.ok(!Object.hasOwn(textarea, "value"));
});

run_test("only the part of the document that changed is replaced", () => {
    const state = EditorState.create({doc: md.parse_markdown("one\ntwo\nthree", context)});
    const doc = md.parse_markdown("one\nTWO\nthree", context);
    const tr = sync_module.replace_changed(state, doc);
    assert.ok(tr.doc.eq(doc));
    assert.deepEqual(
        tr.steps.map((step) => step.toJSON().stepType),
        ["replace"],
    );
    assert.equal(tr.steps[0].toJSON().from, 5);
    // Nothing to do when the documents are the same.
    assert.equal(sync_module.replace_changed(state, state.doc).steps.length, 0);

    // Text that only got shorter leaves the two ends of the difference
    // crossed over; the replaced range covers both.
    const shorter = sync_module.replace_changed(
        EditorState.create({doc: md.parse_markdown("aa", context)}),
        md.parse_markdown("a", context),
    );
    assert.ok(shorter.doc.eq(md.parse_markdown("a", context)));

    // Whatever the two documents are, replacing the part that differs
    // gives the second one exactly.
    const documents = [
        "",
        "a",
        "a\nb",
        "# h",
        "## hh",
        "- a",
        "- a\n- b",
        "- a\n  - b",
        "1. a\n2. b",
        "```quote\nx\n```",
        "```python\ncode\n```",
        "```spoiler h\na\n```",
        "**bold** t",
        "| a | b |\n|---|---|\n| 1 | 2 |",
        "---",
    ];
    for (const before of documents) {
        for (const after of documents) {
            const doc_after = md.parse_markdown(after, context);
            const changed = sync_module.replace_changed(
                EditorState.create({doc: md.parse_markdown(before, context)}),
                doc_after,
            );
            assert.ok(changed.doc.eq(doc_after), `${before} -> ${after}`);
        }
    }
});

run_test("serialisation is cached per document", () => {
    const doc = md.parse_markdown("cached", context);
    const first = sync_module.serialize_cached(doc, context);
    assert.equal(sync_module.serialize_cached(doc, context), first);
    assert.equal(first.markdown, "cached");
});

run_test("offsets of a selection sit inside the formatting", () => {
    const doc = md.parse_markdown("a **b** c", context);
    const {anchors} = md.serialize_markdown(doc, context);
    assert.deepEqual(sync_module.offsets_for_selection(anchors, 3, 4), {start: 4, end: 5});
    assert.deepEqual(sync_module.offsets_for_selection(anchors, 3, 3), {start: 4, end: 4});
    // A selection ending in the middle of a word, where no formatting
    // starts or ends, counts the characters up to there.
    const plain = md.serialize_markdown(md.parse_markdown("hello", context), context);
    assert.deepEqual(sync_module.offsets_for_selection(plain.anchors, 1, 3), {start: 0, end: 2});
});

// The textarea's value as it is, without the composer writing to it
// first (which reading the property does).
function raw_value(textarea) {
    return Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
    ).get.call(textarea);
}

run_test("the textarea is written a moment after typing, or when it is read", () => {
    const {view, textarea, sync, inputs, type} = make_editor();
    type("a");
    assert.equal(raw_value(textarea), "");
    assert.deepEqual(inputs, []);
    clock.tick(sync_module.WRITE_DELAY_MS);
    assert.equal(raw_value(textarea), "a");
    assert.deepEqual(inputs, ["a"]);
    // Reading the value writes it first, so upstream never sees stale
    // text; a burst of typing is written once.
    type("b");
    type("c");
    assert.equal(textarea.value, "abc");
    assert.deepEqual(inputs, ["a", "abc"]);
    // Flushing with nothing pending does nothing.
    sync.flush();
    assert.equal(inputs.length, 2);
    // Moving the cursor while a write is pending waits for the write.
    type("d");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    assert.equal(textarea.selectionStart, 3);
    sync.flush();
    assert.equal(textarea.selectionStart, 0);
    assert.equal(raw_value(textarea), "abcd");
    // What upstream writes replaces an edit not yet written, as it
    // would replace typing in a textarea.
    type("e");
    textarea.value = "fresh";
    assert.equal(sync.markdown(), "fresh");
    clock.tick(sync_module.WRITE_DELAY_MS);
    assert.equal(raw_value(textarea), "fresh");
    assert.ok(!sync.is_lossy());
});

run_test("the composer knows when the document cannot be sent as shown", () => {
    const {view, sync, lossy, flushes} = make_editor();
    view.dispatch(
        view.state.tr.replaceWith(0, view.state.doc.content.size, [
            schema.node("paragraph", null, [schema.text("a`", [schema.marks.code.create()])]),
        ]),
    );
    assert.ok(sync.is_lossy());
    sync.flush();
    assert.equal(lossy.length, 1);
    assert.deepEqual(flushes, [true]);
});
