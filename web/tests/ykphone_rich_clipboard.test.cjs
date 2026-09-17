"use strict";

const assert = require("node:assert/strict");

const {Fragment} = require("prosemirror-model");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const clipboard = zrequire("ykphone_rich_clipboard");
const md = zrequire("ykphone_rich_markdown");
const {schema} = zrequire("ykphone_rich_schema");

const context = {
    ...md.default_context,
    is_user_mention: (name) => name === "Iago",
    is_stream: (name) => name === "Verona",
    is_emoji: (name) => name === "smile",
};

function sanitized(...nodes) {
    return clipboard.sanitize_fragment(Fragment.from(nodes), context);
}

function written(fragment) {
    return md.serialize_markdown(schema.node("doc", null, fragment), context).markdown;
}

run_test("chips are rebuilt from the Markdown they claim to hold", () => {
    // A chip whose Markdown is a chip of its kind is that chip, made
    // from the Markdown alone.
    const forged = schema.node("upload", {
        raw: "[report.pdf](/user_uploads/1/report.pdf)",
        name: "anything",
        url: "https://evil.example",
    });
    const paragraph = schema.node("paragraph", null, [forged]);
    const result = sanitized(paragraph);
    assert.equal(result.firstChild.firstChild.attrs.name, "report.pdf");
    assert.equal(result.firstChild.firstChild.attrs.url, "/user_uploads/1/report.pdf");
    // A mention whose Markdown is no mention becomes the text it holds;
    // an empty one nothing.
    const fake = schema.node("mention", {raw: "@**nobody**", kind: "user", name: "nobody"});
    assert.equal(
        sanitized(schema.node("paragraph", null, [fake])).toString(),
        '<paragraph("@**nobody**")>',
    );
    const empty = schema.node("mention", {raw: "", kind: "user", name: ""});
    assert.equal(sanitized(schema.node("paragraph", null, [empty])).toString(), "<paragraph>");
    // A chip keeps its formatting, except a link the server would refuse.
    const bold = schema.marks.strong.create();
    // eslint-disable-next-line no-script-url -- a javascript: address the code must refuse
    const bad_link = schema.marks.link.create({href: "javascript:x"});
    const chip = schema.node("emoji", {raw: ":smile:", name: "smile"}, undefined, [bold, bad_link]);
    const kept = sanitized(schema.node("paragraph", null, [chip])).firstChild.firstChild;
    assert.deepEqual(
        kept.marks.map((mark) => mark.type.name),
        ["strong"],
    );
    // A block chip is whatever its Markdown parses as.
    const table = schema.node("opaque_block", {raw: "|a|\n|-|", kind: "widget"});
    assert.equal(sanitized(table).toString(), "<opaque_block>");
    assert.equal(sanitized(table).firstChild.attrs.kind, "table");
    const not_a_block = schema.node("opaque_block", {raw: "plain", kind: "table"});
    assert.equal(sanitized(not_a_block).toString(), '<paragraph("plain")>');
});

run_test("links, text and blocks are checked", () => {
    const link = (href) => schema.marks.link.create({href});
    const paragraph = schema.node("paragraph", null, [
        // eslint-disable-next-line no-script-url -- a javascript: address the code must refuse
        schema.text("a", [link("javascript:alert(1)")]),
        schema.text("b\u0000c", [link("https://ex.com/a b")]),
        schema.text("\u0001"),
    ]);
    assert.equal(written(sanitized(paragraph)), "a[bc](https://ex.com/a%20b)");
    // Fence attributes are the editor's to choose; the language stays
    // when it is one.
    const code = schema.node(
        "code_block",
        {fence: "~~~", info: "quote", close: "~~~", bodyless: true},
        [schema.text("x")],
    );
    assert.equal(written(sanitized(code)), "```quote\nx\n```");
    const odd = schema.node("code_block", {info: "py`"}, [schema.text("x")]);
    assert.equal(written(sanitized(odd)), "```\nx\n```");
    const math = schema.node("math_block", {fence: "```", info: "quote"}, [schema.text("x")]);
    assert.equal(written(sanitized(math)), "```math\nx\n```");
    const quote = schema.node("blockquote", {fence: "````", info: "spoiler", style: "fence"}, [
        schema.node("paragraph", null, [schema.text("q")]),
    ]);
    assert.equal(written(sanitized(quote)), "```quote\nq\n```");
    const plain_quote = schema.node("blockquote", null, [
        schema.node("paragraph", null, [schema.text("q")]),
    ]);
    assert.equal(written(sanitized(plain_quote)), "```quote\nq\n```");
    // A list item's marker and a heading's level are taken when valid.
    const list = schema.node("bullet_list", null, [
        schema.node("list_item", {marker: "- "}, [
            schema.node("paragraph", null, [schema.text("a")]),
        ]),
        schema.node("list_item", {marker: "nonsense"}, [
            schema.node("paragraph", null, [
                schema.text("b"),
                schema.node("hard_break", {indent: "     "}),
                schema.text("c"),
            ]),
        ]),
    ]);
    assert.equal(written(sanitized(list)), "- a\n- b\n  c");
    const heading = schema.node("heading", {level: 9}, [schema.text("h")]);
    assert.equal(written(sanitized(heading)), "# h");
    const spoiler = schema.node("spoiler", {fence: "```", info: "spoiler "}, [
        schema.node("spoiler_header", null, [schema.text("H")]),
        schema.node("paragraph", null, [schema.text("s")]),
    ]);
    assert.equal(written(sanitized(spoiler)), "```spoiler H\ns\n```");
});

run_test("content a node cannot hold once cleaned is left where it was", () => {
    // A heading holding a block chip cannot hold what the chip becomes,
    // so the content stands on its own.
    const heading = schema.node("heading", {level: 2}, [
        schema.node("opaque_inline", {raw: "|a|\n|-|"}),
    ]);
    assert.equal(sanitized(heading).toString(), '<heading("|a|", hard_break, "|-|")>');
    // A list item cannot hold a heading, so the heading stands on its own.
    const item = schema.nodes.list_item.create(null, [
        schema.node("heading", {level: 1}, [schema.text("h")]),
    ]);
    assert.equal(sanitized(item).toString(), '<heading("h")>');
});
