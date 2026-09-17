"use strict";

const assert = require("node:assert/strict");

const {JSDOM} = require("jsdom");
const {DOMParser, DOMSerializer} = require("prosemirror-model");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const md = zrequire("ykphone_rich_markdown");
const {schema} = zrequire("ykphone_rich_schema");

const dom = new JSDOM("");
const {document} = dom.window;

const serializer = DOMSerializer.fromSchema(schema);
const parser = DOMParser.fromSchema(schema);

// What the clipboard carries between two of these editors: the document
// as HTML, and back.
function through_dom(markdown) {
    const doc = md.parse_markdown(markdown);
    const html = document.createElement("div");
    html.append(serializer.serializeFragment(doc.content, {document}));
    const parsed = parser.parse(html, {preserveWhitespace: "full"});
    return {html: html.innerHTML, markdown: md.serialize_markdown(parsed).markdown};
}

run_test("a document survives a trip through HTML", () => {
    const cases = [
        "**bold** *italic* ~~gone~~ `code`",
        "[a link](https://ex.com)",
        "@**Iago** @_**Iago|11** @*hamletcharacters*",
        "#**Verona** #**Verona>topic**",
        ":smile: <time:2024-01-01T10:00Z>",
        "![a.png](/user_uploads/1/a.png) [f.pdf](/user_uploads/2/f.pdf)",
        "[Join video call.](https://meet.example/1)",
        "line one\nline two",
        "- one\n- two",
        "1. one\n2. two",
        "> quoted",
        "```quote\nquoted\n```",
        "```python\ncode()\n```",
        "```math\nx^2\n```",
        "```spoiler Header\nhidden\n```",
        "# Heading",
        "a&#42;b",
        "some $$x^2$$ math",
        "[](https://ex.com)",
        "``a`b``",
        "| a | b |\n|---|---|\n| 1 | 2 |",
    ];
    for (const markdown of cases) {
        assert.equal(through_dom(markdown).markdown, markdown, markdown);
    }
});

run_test("chips carry what they are made of", () => {
    const {html} = through_dom("@**Iago|11** :smile:");
    assert.ok(html.includes('data-yk-raw="@**Iago|11**"'), html);
    assert.ok(html.includes('data-yk-silent="false"'), html);
    assert.ok(html.includes('data-yk-name="smile"'), html);
    // A numbered list keeps where it starts.
    assert.equal(through_dom("5. five\n6. six").markdown, "5. five\n6. six");
});

run_test("chips read as the text they stand for", () => {
    // What a chip copies as into a plain-text field, and what the input
    // rules see while typing.
    const doc = md.parse_markdown(
        "@**Iago** :smile: #**Verona** <time:2024-01-01T10:00Z> " +
            "[f.pdf](/user_uploads/2/f.pdf) [Join video call.](https://meet.example/1)\n" +
            "a&#42;b [](https://ex.com)",
    );
    assert.equal(
        doc.textContent,
        "@**Iago** :smile: #**Verona** <time:2024-01-01T10:00Z> " +
            "[f.pdf](/user_uploads/2/f.pdf) [Join video call.](https://meet.example/1)\n" +
            "a*b [](https://ex.com)",
    );
});

run_test("chip markup from elsewhere is read with what it carries", () => {
    // Attributes that are not the chip's own are left alone, and one it
    // does not carry keeps its default.
    const html = document.createElement("div");
    html.innerHTML =
        '<p><span class="ykphone-rich-mention" data-yk-raw="@**Iago**" data-yk-name="Iago" ' +
        'data-other="x">@Iago</span></p>' +
        '<div class="ykphone-rich-opaque-block" data-yk-raw="---" data-yk-kind="hr"></div>';
    const doc = parser.parse(html);
    assert.equal(doc.toString(), "doc(paragraph(mention), opaque_block)");
    assert.equal(doc.child(1).attrs.sep, null);
    assert.equal(md.serialize_markdown(doc).markdown, "@**Iago**\n---");
});

run_test("formatting pasted from elsewhere is read as formatting", () => {
    const html = document.createElement("div");
    html.innerHTML =
        "<p>a <b>bold</b> <b style='font-weight: normal'>not bold</b> " +
        "<span style='font-weight: 700'>heavy</span> <i>italic</i> <s>gone</s> " +
        "<code>code</code> <a href='https://ex.com'>link</a></p>" +
        "<ul><li>item</li></ul><ol><li>first</li></ol><blockquote>quoted</blockquote>" +
        "<pre>code()</pre><h2>Heading</h2><br>";
    const parsed = parser.parse(html);
    assert.equal(
        md.serialize_markdown(parsed).markdown,
        "a **bold** not bold **heavy** *italic* ~~gone~~ `code` [link](https://ex.com)\n" +
            "- item\n1. first\n\n```quote\nquoted\n```\n```\ncode()\n```\n## Heading\n\n",
    );
    // A span that turns bold off inside a bold one is not bold.
    const weights = document.createElement("div");
    weights.innerHTML = "<p><b>bold <span style='font-weight: 400'>normal</span></b></p>";
    assert.equal(md.serialize_markdown(parser.parse(weights)).markdown, "**bold **normal");
    // A link to an address the server would refuse is text.
    const unsafe = document.createElement("div");
    unsafe.innerHTML = "<p><a href='javascript:alert(1)'>y</a></p>";
    assert.equal(md.serialize_markdown(parser.parse(unsafe)).markdown, "y");
    // Text with a line-through style is struck out.
    const styled = document.createElement("div");
    styled.innerHTML = "<p><span style='text-decoration: line-through'>gone</span></p>";
    assert.equal(md.serialize_markdown(parser.parse(styled)).markdown, "~~gone~~");
});
