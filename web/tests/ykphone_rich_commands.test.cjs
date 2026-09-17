"use strict";

const assert = require("node:assert/strict");

const {EditorState, NodeSelection, TextSelection} = require("prosemirror-state");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const commands = zrequire("ykphone_rich_commands");
const md = zrequire("ykphone_rich_markdown");
const {schema} = zrequire("ykphone_rich_schema");

const context = {
    ...md.default_context,
    is_user_mention: (name) => name === "Iago",
    is_stream: (name) => name === "Verona",
    is_emoji: (name) => name === "smile",
};

const rules_plugin = commands.markdown_input_rules(() => context);

// A state holding `markdown`, with the cursor (or the selection) where
// the given offsets into that Markdown are.
function make_state(markdown, from, to = from) {
    const doc = md.parse_markdown(markdown, context);
    const {anchors} = md.serialize_markdown(doc, context);
    const state = EditorState.create({doc, plugins: [rules_plugin]});
    return state.apply(
        state.tr.setSelection(
            TextSelection.create(
                doc,
                md.offset_to_pos(anchors, from),
                md.offset_to_pos(anchors, to),
            ),
        ),
    );
}

// Runs a command and returns the Markdown of the result, or undefined
// when the command declines.
function run(state, command) {
    let next;
    const handled = command(state, (tr) => {
        next = state.apply(tr);
    });
    if (!handled) {
        return undefined;
    }
    assert.ok(next !== undefined);
    return {markdown: md.serialize_markdown(next.doc, context).markdown, state: next};
}

// Types `text` at the cursor, letting the input rules see it as the
// editor does.
function type(state, text) {
    const {from, to} = state.selection;
    const rule = rules_plugin.props.handleTextInput;
    let next;
    const view = {
        state,
        dispatch(tr) {
            next = state.apply(tr);
        },
        get composing() {
            return false;
        },
        someProp(name, f) {
            return name === "handleTextInput" ? f(rule) : undefined;
        },
    };
    const handled = rule.call(rules_plugin, view, from, to, text);
    if (!handled) {
        next = state.apply(state.tr.insertText(text, from, to));
    }
    return next;
}

// A state whose paragraph holds `text` as the user typed it (a newline
// is a line break), with the cursor after `cursor` characters of it.
function typed_state(text, cursor) {
    const nodes = [];
    for (const [index, line] of text.split("\n").entries()) {
        if (index > 0) {
            nodes.push(schema.node("hard_break"));
        }
        if (line !== "") {
            nodes.push(schema.text(line));
        }
    }
    const doc = schema.node("doc", null, [schema.node("paragraph", null, nodes)]);
    const state = EditorState.create({doc, plugins: [rules_plugin]});
    return state.apply(state.tr.setSelection(TextSelection.create(doc, cursor + 1)));
}

// A state holding `doc` with the cursor at the end of it.
function state_at_end(doc) {
    const state = EditorState.create({doc, plugins: [rules_plugin]});
    return state.apply(
        state.tr.setSelection(TextSelection.near(doc.resolve(doc.content.size), -1)),
    );
}

// Types every character of `text` in turn, as a user would.
function type_all(text) {
    let state = typed_state("", 0);
    for (const character of text) {
        state = type(state, character);
    }
    return state;
}

function markdown_of(state) {
    return md.serialize_markdown(state.doc, context).markdown;
}

run_test("formatting marks", () => {
    // "before abc after", with "abc" selected.
    const state = make_state("before abc after", 7, 10);
    assert.equal(run(state, commands.toggle_format("strong")).markdown, "before **abc** after");
    assert.equal(run(state, commands.toggle_format("em")).markdown, "before *abc* after");
    assert.equal(run(state, commands.toggle_format("strike")).markdown, "before ~~abc~~ after");
    assert.equal(run(state, commands.toggle_format("code")).markdown, "before `abc` after");
    assert.equal(run(state, commands.toggle_format("math")).markdown, "before $$abc$$ after");
    // Formatting the whole of something already formatted removes it.
    const bold = make_state("before **abc** after", 9, 12);
    assert.equal(run(bold, commands.toggle_format("strong")).markdown, "before abc after");
    // Not inside a code block.
    const code = make_state("```\nabc\n```", 5);
    assert.equal(run(code, commands.toggle_format("strong")), undefined);
    assert.ok(commands.in_code(code));
    assert.ok(!commands.is_single_line_selection(code));
    assert.ok(commands.is_single_line_selection(state));
    // A selection that crosses a line break is not one line.
    assert.ok(!commands.is_single_line_selection(make_state("a\nb", 0, 3)));
});

run_test("links", () => {
    const state = make_state("before abc after", 7, 10);
    const linked = run(state, commands.apply_link("https://ex.com"));
    assert.equal(linked.markdown, "before [abc](https://ex.com) after");
    // The cursor lands after the link, so what is typed next is not
    // swallowed by it.
    assert.equal(linked.state.selection.from, 11);
    assert.deepEqual(linked.state.selection.$from.marks(), []);
    // With nothing selected, the address becomes the link's text unless
    // one is given.
    const empty = make_state("", 0);
    assert.equal(
        run(empty, commands.apply_link("https://ex.com")).markdown,
        "[https://ex.com](https://ex.com)",
    );
    assert.equal(
        run(empty, commands.apply_link("https://ex.com", "site")).markdown,
        "[site](https://ex.com)",
    );
    // An address of nothing is not a link.
    assert.equal(run(state, commands.apply_link("  ")), undefined);

    // The cursor inside a link finds the whole link.
    const inside = make_state("see [text](https://ex.com) here", 7);
    const link = commands.link_at_selection(inside);
    assert.deepEqual(link, {href: "https://ex.com", from: 5, to: 9});
    const changed = run(inside, commands.apply_link("https://other.example"));
    assert.equal(changed.markdown, "see [text](https://other.example) here");
    // The cursor lands after the link here too.
    assert.equal(changed.state.selection.from, 9);
    assert.ok(changed.state.selection.empty);
    assert.equal(run(inside, commands.remove_link).markdown, "see text here");
    assert.equal(commands.link_at_selection(make_state("plain", 2)), undefined);
    // A link does not take in what is typed at its end, so the text
    // after it is plain; inside it, the text is part of the link.
    const at_end = make_state("[ab](https://ex.com)", 3);
    assert.deepEqual(at_end.selection.$from.marks(), []);
    assert.equal(
        markdown_of(at_end.apply(at_end.tr.insertText("!", at_end.selection.from))),
        "[ab](https://ex.com)!",
    );
    const within = make_state("[ab](https://ex.com)", 2);
    assert.equal(
        markdown_of(within.apply(within.tr.insertText("!", within.selection.from))),
        "[a!b](https://ex.com)",
    );

    // Two links next to each other are two links.
    const pair = make_state("[ab](https://one.example)[cd](https://two.example)", 27);
    assert.equal(commands.link_at_selection(pair).href, "https://two.example");
    assert.equal(run(make_state("plain", 2), commands.remove_link), undefined);
});

run_test("what the link form makes of what was typed", () => {
    const submit = commands.link_form_submission;
    // A URL in the link field is the link, with the text as typed.
    assert.deepEqual(submit("site", "https://ex.com"), {href: "https://ex.com", text: "site"});
    assert.deepEqual(submit(undefined, " https://ex.com "), {
        href: "https://ex.com",
        text: undefined,
    });
    // With nothing selected and only a URL typed as the text, Enter
    // takes it as the link.
    assert.deepEqual(submit("https://www.yeopkerphone.co.kr", ""), {
        href: "https://www.yeopkerphone.co.kr",
        text: undefined,
    });
    // With the link field empty and text that is no address, there is
    // no link yet.
    assert.equal(submit("just words", ""), undefined);
    assert.equal(submit(undefined, ""), undefined);
    assert.equal(submit("https://ex.com", "not a link"), undefined);
    // Addresses without a scheme get one; paths on this server stay.
    assert.equal(commands.normalize_href("www.ex.com/a?b=1"), "https://www.ex.com/a?b=1");
    assert.equal(commands.normalize_href("ex.co.kr"), "https://ex.co.kr");
    assert.equal(commands.normalize_href("/user_uploads/1/a.png"), "/user_uploads/1/a.png");
    assert.equal(commands.normalize_href("mailto:a@ex.com"), "mailto:a@ex.com");
    assert.equal(commands.normalize_href("ftp://ex.com/f"), "ftp://ex.com/f");
    assert.equal(commands.normalize_href("/a path"), undefined);
    assert.equal(commands.normalize_href("https://ex .com"), undefined);
    assert.equal(commands.normalize_href("word"), undefined);
});

run_test("Enter without sending", () => {
    // In a paragraph it is a line break, as a newline in the textarea is.
    assert.equal(run(make_state("a", 1), commands.enter_without_sending).markdown, "a\n");
    // In a list it starts the next item, numbering it as upstream does.
    assert.equal(run(make_state("- one", 5), commands.enter_without_sending).markdown, "- one\n- ");
    assert.equal(
        run(make_state("1. one", 6), commands.enter_without_sending).markdown,
        "1. one\n2. ",
    );
    // An empty item at the end of a list ends the list.
    assert.equal(
        run(make_state("- one\n- ", 8), commands.enter_without_sending).markdown,
        "- one\n",
    );
    // In code it is a newline in the code.
    assert.equal(
        run(make_state("```\nabc\n```", 6), commands.enter_without_sending).markdown,
        "```\nab\nc\n```",
    );
    // After a heading, a paragraph.
    assert.equal(
        run(make_state("# Title", 7), commands.enter_without_sending).markdown,
        "# Title\n",
    );
    // On the empty last line of a quote, out of the quote.
    assert.equal(
        run(make_state("```quote\nq\n\n```", 12), commands.enter_without_sending).markdown,
        "```quote\nq\n```\n",
    );
    // From a spoiler's header into its contents.
    const spoiler = make_state("```spoiler H\nbody\n```", 12);
    const moved = run(spoiler, commands.enter_without_sending);
    assert.equal(moved.markdown, "```spoiler H\nbody\n```");
    assert.equal(moved.state.selection.from, 5);
});

run_test("a command asked whether it does something changes nothing", () => {
    // Every command is also run without a way to dispatch, to tell the
    // editor whether the key it is bound to is taken.
    const state = make_state("before abc after", 7, 10);
    assert.ok(commands.apply_link("https://ex.com")(state, undefined));
    assert.ok(commands.toggle_format("strong")(state, undefined));
    assert.ok(commands.remove_link(make_state("see [text](https://ex.com)", 7), undefined));
    assert.ok(commands.enter_without_sending(state, undefined));
    assert.ok(commands.enter_without_sending(make_state("# Title", 7), undefined));
    assert.ok(commands.enter_without_sending(make_state("```spoiler H\nbody\n```", 12), undefined));
    assert.ok(commands.enter_without_sending(make_state("```quote\n- a\n\n```", 13), undefined));
    assert.ok(commands.leave_block_at_end(make_state("```quote\nq\n```", 10), undefined));
    assert.ok(commands.enter_after_fence(typed_state("```python", 9), undefined));
    assert.equal(markdown_of(state), "before abc after");
});

run_test("Enter on the last line of a quote or spoiler", () => {
    // The empty line is removed and the cursor lands after the block.
    assert.equal(
        run(make_state("```quote\n- a\n\n```", 13), commands.enter_without_sending).markdown,
        "```quote\n- a\n```\n",
    );
    assert.equal(
        run(make_state("```spoiler H\n- a\n\n```", 17), commands.enter_without_sending).markdown,
        "```spoiler H\n- a\n```\n",
    );
    // With nothing but that line in the block there is nothing to leave
    // behind, so Enter is a line break, as it is in the middle of a line.
    assert.equal(
        run(make_state("```quote\n\n```", 9), commands.enter_without_sending).markdown,
        "```quote\n\n\n```",
    );
    assert.equal(
        run(make_state("```spoiler H\n\n```", 13), commands.enter_without_sending).markdown,
        "```spoiler H\n\n\n```",
    );
    assert.equal(
        run(make_state("```quote\nq\n```", 10), commands.enter_without_sending).markdown,
        "```quote\nq\n\n```",
    );
});

run_test("Tab indents and unindents list items", () => {
    const state = make_state("- one\n- two", 10);
    const indented = run(state, commands.indent_list_item);
    assert.equal(indented.markdown, "- one\n  - two");
    assert.equal(run(indented.state, commands.outdent_list_item).markdown, "- one\n- two");
    // Only in a list.
    assert.equal(run(make_state("plain", 2), commands.indent_list_item), undefined);
});

run_test("moving on from a block at the end of the message", () => {
    const quote = make_state("```quote\nq\n```", 10);
    assert.equal(run(quote, commands.leave_block_at_end).markdown, "```quote\nq\n```\n");
    // Not in the middle of the message, and not from a paragraph.
    assert.equal(
        run(make_state("```quote\nq\n```\nafter", 10), commands.leave_block_at_end),
        undefined,
    );
    assert.equal(run(make_state("text", 4), commands.leave_block_at_end), undefined);
    // Not from the middle of a line, and not from an item with items
    // after it.
    assert.equal(run(make_state("```quote\nq\n```", 9), commands.leave_block_at_end), undefined);
    assert.equal(run(make_state("- one\n- two", 5), commands.leave_block_at_end), undefined);
});

run_test("typed Markdown becomes formatting", () => {
    // Typed inline syntax is shown as formatting as soon as it means
    // something, and the Markdown is what was typed.
    const bold = type_all("hi **bold**");
    assert.equal(markdown_of(bold), "hi **bold**");
    assert.equal(bold.doc.toString(), 'doc(paragraph("hi ", strong("bold")))');
    // What is typed next is outside the formatting.
    assert.deepEqual(bold.storedMarks, []);
    assert.equal(type_all("hi :smile:").doc.toString(), 'doc(paragraph("hi ", emoji))');
    assert.equal(type_all("hi @**Iago**").doc.toString(), 'doc(paragraph("hi ", mention))');
    assert.equal(
        type_all("see #**Verona**").doc.toString(),
        'doc(paragraph("see ", channel_link))',
    );
    assert.equal(
        type_all("a [b](https://ex.com)").doc.toString(),
        'doc(paragraph("a ", link("b")))',
    );
    // Text that means nothing to the server stays text.
    assert.equal(markdown_of(type_all("2 * 3 * 4")), "2 * 3 * 4");
    // A line that starts with a bullet, a number, a quote marker or
    // hashes becomes that block.
    assert.equal(type_all("- ").doc.toString(), "doc(bullet_list(list_item(paragraph)))");
    assert.equal(markdown_of(type_all("1. one")), "1. one");
    assert.equal(type_all("> ").doc.toString(), "doc(blockquote(paragraph))");
    assert.equal(type_all("## ").doc.toString(), "doc(heading)");
    // Only at the start of a line.
    assert.equal(markdown_of(type_all("text - ")), "text - ");
    // The rest of the line follows the marker into the new block, and
    // the lines around it stay as they were.
    const with_text = type(typed_state("todo:\n-item", 7), " ");
    assert.equal(markdown_of(with_text), "todo:\n- item");
    assert.equal(
        with_text.doc.toString(),
        'doc(paragraph("todo:"), bullet_list(list_item(paragraph("item"))))',
    );
    // Not inside a code block, where text is what it says.
    assert.equal(type(make_state("```\nx*", 6), "*").doc.toString(), 'doc(code_block("x**"))');
    // Typing that makes a line of the paragraph another block leaves
    // it to the block rules.
    const fence = type(typed_state("a\n``", 4), "`");
    assert.equal(fence.doc.toString(), 'doc(paragraph("a", hard_break, "```"))');
    // A heading holds formatting too.
    assert.equal(type_all("## *h*").doc.toString(), 'doc(heading(em("h")))');
    assert.equal(markdown_of(type_all("## *h*")), "## *h*");
});

run_test("characters that cannot be Markdown here stay as they are", () => {
    // Typing over a selection replaces it; it is not syntax completed.
    assert.equal(type(make_state("ab", 0, 2), "*").doc.toString(), 'doc(paragraph("*"))');
    // Inside code, or a link, a character is what it says.
    assert.equal(
        type(make_state("`ab` c", 2), "*").doc.toString(),
        'doc(paragraph(code("a*b"), " c"))',
    );
    assert.equal(
        type(make_state("[ab](https://ex.com)", 2), "*").doc.toString(),
        'doc(paragraph(link("a*b")))',
    );
    // A spoiler's header is not read as a block of Markdown.
    assert.equal(
        type(make_state("```spoiler H\nbody\n```", 12), "*").doc.toString(),
        'doc(spoiler(spoiler_header("H*"), paragraph("body")))',
    );
    // A bullet typed inside a list item is text, not another list.
    let state = make_state("- one", 2);
    for (const character of "- ") {
        state = type(state, character);
    }
    assert.equal(state.doc.toString(), 'doc(bullet_list(list_item(paragraph("- one"))))');
    // The line the marker is on becomes the list; the lines around it
    // stay where they are.
    const middle = type(typed_state("-item\nrest", 1), " ");
    assert.equal(markdown_of(middle), "- item\n\nrest");
    assert.equal(
        middle.doc.toString(),
        'doc(bullet_list(list_item(paragraph("item"))), paragraph("rest"))',
    );
});

run_test("Enter after a fence line starts the block", () => {
    const state = typed_state("```python", 9);
    const result = run(state, commands.enter_after_fence);
    assert.equal(result.markdown, "```python\n\n```");
    assert.equal(result.state.doc.toString(), "doc(code_block)");
    assert.equal(
        run(typed_state("```quote", 8), commands.enter_after_fence).state.doc.toString(),
        "doc(blockquote(paragraph))",
    );
    assert.equal(
        run(typed_state("```math", 7), commands.enter_after_fence).state.doc.toString(),
        "doc(math_block)",
    );
    const spoiler = run(typed_state("```spoiler Header", 17), commands.enter_after_fence).state;
    assert.equal(spoiler.doc.toString(), 'doc(spoiler(spoiler_header("Header"), paragraph))');
    // The cursor is in the spoiler's content, under its header.
    assert.equal(spoiler.selection.$from.parent.type.name, "paragraph");
    assert.equal(spoiler.selection.from, 1 + "Header".length + 2 + 1);
    // A line that is not a fence is left to the other Enter handlers,
    // and so is Enter anywhere but in a paragraph.
    assert.equal(run(typed_state("plain", 5), commands.enter_after_fence), undefined);
    assert.equal(run(make_state("```\nabc\n```", 5), commands.enter_after_fence), undefined);
    // A fence with no language, and a spoiler with no header.
    assert.equal(
        run(typed_state("```", 3), commands.enter_after_fence).state.doc.toString(),
        "doc(code_block)",
    );
    assert.equal(
        run(typed_state("```spoiler", 10), commands.enter_after_fence).state.doc.toString(),
        "doc(spoiler(spoiler_header, paragraph))",
    );
    // What is left of the line after the cursor goes into the block.
    assert.equal(
        run(typed_state("```python code()", 9), commands.enter_after_fence).state.doc.toString(),
        'doc(code_block(" code()"))',
    );
    const spoiler_rest = run(typed_state("```spoiler Hi there", 13), commands.enter_after_fence);
    assert.equal(
        spoiler_rest.state.doc.toString(),
        'doc(spoiler(spoiler_header("Hi"), paragraph(" there")))',
    );
    assert.equal(spoiler_rest.state.selection.$from.parentOffset, 0);
    // A fence line inside a list item is not a block of its own.
    const in_item = schema.node("doc", null, [
        schema.node("bullet_list", null, [
            schema.node("list_item", {marker: "- "}, [
                schema.node("paragraph", null, [schema.text("```python")]),
            ]),
        ]),
    ]);
    assert.equal(run(state_at_end(in_item), commands.enter_after_fence), undefined);
});

run_test("the marker of the next list item", () => {
    const item = (marker) => schema.node("list_item", {marker}, [schema.node("paragraph")]);
    assert.equal(commands.next_marker(item("- ")), "- ");
    assert.equal(commands.next_marker(item("  3. ")), "  4. ");
    assert.equal(commands.next_marker(item(null)), null);
});

run_test("formatting that Markdown cannot carry is refused", () => {
    // A code span ending in a backtick, math holding its own delimiter.
    assert.equal(run(make_state("a`", 0, 2), commands.toggle_format("code")), undefined);
    assert.equal(run(make_state("a$$b", 0, 4), commands.toggle_format("math")), undefined);
    // Whitespace at the edges of the selection is left out, as upstream
    // does, and whitespace alone gets nothing.
    assert.equal(
        run(make_state("a b c", 1, 4), commands.toggle_format("strong")).markdown,
        "a **b** c",
    );
    assert.equal(run(make_state("a   c", 1, 4), commands.toggle_format("strong")), undefined);
    // Bold of a lone star can be written (escaped), so it is allowed.
    assert.equal(
        run(make_state("*", 0, 1), commands.toggle_format("strong")).markdown,
        "**&#42;**",
    );
    // With nothing selected, the formatting is for what is typed next.
    const typing = run(make_state("ab", 1), commands.toggle_format("em"));
    assert.equal(typing.markdown, "ab");
    assert.equal(typing.state.storedMarks.length, 1);
});

run_test("Enter on a selected block chip adds a line after it", () => {
    const doc = schema.node("doc", null, [schema.node("opaque_block", {raw: "---", kind: "hr"})]);
    let state = EditorState.create({doc, plugins: [rules_plugin]});
    state = state.apply(state.tr.setSelection(NodeSelection.create(doc, 0)));
    const after = run(state, commands.enter_without_sending);
    assert.equal(after.state.doc.toString(), "doc(opaque_block, paragraph)");
    assert.equal(after.state.selection.from, 2);
    assert.ok(commands.enter_without_sending(state, undefined));
});

run_test("a link keeps only an address the server accepts", () => {
    assert.equal(
        // eslint-disable-next-line no-script-url -- a javascript: address the code must refuse
        run(make_state("abc", 0, 3), commands.apply_link("javascript:alert(1)")),
        undefined,
    );
    assert.equal(
        run(make_state("abc", 0, 3), commands.apply_link("https://ex.com/a b")).markdown,
        "[abc](https://ex.com/a%20b)",
    );
});

run_test("a code block's language", () => {
    assert.equal(commands.code_block_language("python"), "python");
    assert.equal(commands.code_block_language(" {.c++}"), "c++");
    assert.equal(commands.code_block_language(""), "");
    assert.ok(commands.is_code_language("objective-c"));
    assert.ok(!commands.is_code_language(""));
    assert.ok(!commands.is_code_language("two words"));
    assert.ok(!commands.is_code_language("a`b"));
    // Names that would make the block something else.
    for (const name of ["quote", "Quoted", "spoiler", "MATH"]) {
        assert.ok(!commands.is_code_language(name));
    }

    const set_language = (markdown, language) => {
        const state = EditorState.create({doc: md.parse_markdown(markdown, context)});
        // The fenced block is the last one.
        const pos = state.doc.content.size - state.doc.lastChild.nodeSize;
        return run(state, commands.set_code_block_language(pos, language));
    };
    const cases = [
        ["```\nx = 1\n```", "python", "```python\nx = 1\n```"],
        ["```python\nx = 1\n```", "ruby", "```ruby\nx = 1\n```"],
        ["~~~ {.python}\nx\n~~~", "c++", "~~~ {.c++}\nx\n~~~"],
        ["```python\nx\n```", "", "```\nx\n```"],
        ["hi\n\n``` \nx\n```", "js", "hi\n\n```js\nx\n```"],
    ];
    for (const [markdown, language, expected] of cases) {
        const result = set_language(markdown, language);
        assert.equal(result.markdown, expected);
        // The Markdown reads back as the same code block.
        const reparsed = md.parse_markdown(result.markdown, context);
        assert.equal(reparsed.lastChild.type.name, "code_block");
        assert.equal(commands.code_block_language(reparsed.lastChild.attrs.info), language);
    }
    // Asked whether it would, it changes nothing.
    const state = EditorState.create({doc: md.parse_markdown("```\nx\n```", context)});
    assert.ok(commands.set_code_block_language(0, "python")(state));
    // Only code blocks, and only names that stay code.
    assert.equal(set_language("```\nx\n```", "quote"), undefined);
    assert.equal(set_language("```math\nx\n```", "python"), undefined);
    assert.equal(set_language("text", "python"), undefined);
});

run_test("Markdown typed in a spoiler's header becomes formatting", () => {
    const header_state = (markdown, header_offset) => {
        const doc = md.parse_markdown(markdown, context);
        const state = EditorState.create({doc, plugins: [rules_plugin]});
        // Inside the spoiler (0), its header's content starts at 2.
        return state.apply(state.tr.setSelection(TextSelection.create(doc, 2 + header_offset)));
    };
    const type_text = (state, text) => {
        for (const character of text) {
            state = type(state, character);
        }
        return state;
    };

    const bold = type_text(header_state("```spoiler Title\nbody\n```", 5), " **big**");
    assert.equal(
        bold.doc.toString(),
        'doc(spoiler(spoiler_header("Title ", strong("big")), paragraph("body")))',
    );
    assert.equal(markdown_of(bold), "```spoiler Title **big**\nbody\n```");
    // The cursor is after the formatting, and what is typed next is not.
    assert.equal(bold.selection.from, 2 + "Title big".length);
    assert.deepEqual(bold.storedMarks, []);

    // A header that was empty takes formatting too.
    const empty = type_text(header_state("```spoiler\nbody\n```", 0), "*a*");
    assert.equal(markdown_of(empty), "```spoiler *a*\nbody\n```");
    assert.equal(empty.doc.firstChild.firstChild.toString(), 'spoiler_header(em("a"))');

    // A spoiler that is never closed, at the end of the message.
    const unclosed = type_text(header_state("```spoiler Hi\nbody", 2), " *x*");
    assert.equal(markdown_of(unclosed), "```spoiler Hi *x*\nbody");
    assert.equal(unclosed.doc.firstChild.firstChild.toString(), 'spoiler_header("Hi ", em("x"))');

    // A chip in the header.
    const emoji = type_text(header_state("```spoiler Hi\nbody\n```", 2), " :smile:");
    assert.equal(emoji.doc.firstChild.firstChild.toString(), 'spoiler_header("Hi ", emoji)');

    // A backtick cannot be Markdown in the fence line: it stays a
    // character.
    const tick = type_text(header_state("```spoiler Hi\nbody\n```", 2), " `a`");
    assert.equal(tick.doc.firstChild.firstChild.textContent, "Hi `a`");
    assert.equal(
        md.parse_markdown(markdown_of(tick), context).firstChild.firstChild.textContent,
        "Hi `a`",
    );
});
