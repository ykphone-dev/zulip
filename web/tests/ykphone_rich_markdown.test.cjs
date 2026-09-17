"use strict";

const assert = require("node:assert/strict");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const {schema} = zrequire("ykphone_rich_schema");
const md = zrequire("ykphone_rich_markdown");

const context = {
    ...md.default_context,
    is_user_mention: (name) => ["Iago", "Iago|11", "all"].includes(name),
    is_group_mention: (name) => name === "hamletcharacters",
    is_stream: (name) => name === "Verona",
    is_emoji: (name) => name === "smile",
};

function parse(markdown) {
    return md.parse_markdown(markdown, context);
}

function write(doc) {
    return md.serialize_markdown(doc, context).markdown;
}

// The round trip every other part of the composer relies on.
function assert_round_trip(markdown, structure) {
    const doc = parse(markdown);
    doc.check();
    assert.equal(write(doc), markdown, `round trip of ${JSON.stringify(markdown)}`);
    if (structure !== undefined) {
        assert.equal(doc.toString(), structure, `structure of ${JSON.stringify(markdown)}`);
    }
}

// A document of one paragraph holding `nodes`, as the editor would.
function paragraph(...nodes) {
    return schema.node("doc", null, [schema.node("paragraph", null, nodes)]);
}

function text(value, ...mark_names) {
    return schema.text(
        value,
        mark_names.map((name) =>
            name === "link"
                ? schema.marks.link.create({href: "https://ex.com"})
                : schema.marks[name].create(),
        ),
    );
}

run_test("paragraphs, line breaks and blank lines", () => {
    assert_round_trip("", "doc(paragraph)");
    assert_round_trip("hello", 'doc(paragraph("hello"))');
    // A newline is a line break inside one paragraph, as it is for the
    // server; blank lines are line breaks too, so the cursor can be put
    // on them.
    assert_round_trip("a\nb", 'doc(paragraph("a", hard_break, "b"))');
    assert_round_trip("a\n\n\nb");
    assert_round_trip("\n\nhello\n\n");
    assert_round_trip("trailing spaces  \nand a line");
});

run_test("formatting and chips", () => {
    assert_round_trip("**bold** *italic* ~~gone~~ `code` $$x$$");
    assert_round_trip("@**Iago** @_**Iago|11** @*hamletcharacters* @**all**");
    assert_round_trip("#**Verona** #**Verona>topic**");
    assert_round_trip(":smile: <time:2024-01-01T10:00Z>");
    assert_round_trip(
        "[a](https://ex.com) ![f.png](/user_uploads/1/f.png) [f.pdf](/user_uploads/2/f.pdf)",
    );
    // A link the editor cannot show as a link keeps its Markdown.
    assert_round_trip("[@**Iago**](https://ex.com)", "doc(paragraph(opaque_inline))");
    assert_round_trip("[a\nb](https://ex.com)");
    // The upload placeholder, while the file is on its way.
    assert_round_trip("[Uploading a.png…]()", "doc(paragraph(upload))");
    // A call link from the compose buttons is a chip of its own.
    const doc = parse("[Join video call.](https://meet.example/1)");
    assert.equal(doc.firstChild.firstChild.type.name, "call_link");
    assert.equal(doc.firstChild.firstChild.attrs.kind, "video");
    assert.equal(
        parse("[Join voice call.](https://meet.example/1)").firstChild.firstChild.attrs.kind,
        "audio",
    );
    // A character written as an entity is shown as the character.
    const escaped = parse("a&#42;b");
    assert.equal(escaped.firstChild.child(1).attrs.char, "*");
    assert.equal(write(escaped), "a&#42;b");
});

run_test("blocks", () => {
    assert_round_trip("# Heading", 'doc(heading("Heading"))');
    assert_round_trip("# Heading\ntext");
    assert_round_trip(
        "- one\n- two",
        'doc(bullet_list(list_item(paragraph("one")), list_item(paragraph("two"))))',
    );
    assert_round_trip("1. one\n2. two");
    assert_round_trip("- one\n  - nested\n- two");
    // A line that follows an item without a marker belongs to it.
    assert_round_trip("- one\n  more");
    assert_round_trip("```quote\nquoted\n```", 'doc(blockquote(paragraph("quoted")))');
    assert_round_trip("```quote\nquoted\n```\ntext");
    assert_round_trip("> quoted\n> lines");
    assert_round_trip("```python\ncode()\n```", 'doc(code_block("code()"))');
    assert_round_trip("```math\nx^2\n```", 'doc(math_block("x^2"))');
    assert_round_trip(
        "```spoiler Header\nhidden\n```",
        'doc(spoiler(spoiler_header("Header"), paragraph("hidden")))',
    );
    // A fence that is never closed still reads back as it was written.
    assert_round_trip("```\nunfinished");
    // A quote can hold a code block whose fence is the same length.
    assert_round_trip("````quote\n```\ncode\n```\n````");
    assert_round_trip("text\n- a list right after it\n\nand a paragraph");
});

run_test("what the editor cannot show stays as it is", () => {
    const table = "| a | b |\n|---|---|\n| 1 | 2 |";
    assert_round_trip(table, "doc(opaque_block)");
    assert.equal(parse(table).firstChild.attrs.kind, "table");
    assert_round_trip("    indented code");
    assert_round_trip("---");
    // A poll or to-do list is the whole message.
    const poll = parse("/poll Lunch?\nSoup\nSalad");
    assert.equal(poll.firstChild.attrs.kind, "widget");
    assert.equal(write(poll), "/poll Lunch?\nSoup\nSalad");
    // A "> " quote with a lazy line is not the strict form the editor
    // shows, so it is kept whole.
    assert_round_trip("> quoted\nlazy line", "doc(opaque_block)");
});

run_test("literal text is escaped only where the server would read syntax", () => {
    const unchanged = [
        "3 * 4 = 12",
        "snake_case and __init__",
        "회의는 10:30에 시작합니다",
        "a > b and c < d",
        "https://zulip.com/help/(a)",
        "100% & ok",
        "hello *world",
    ];
    for (const value of unchanged) {
        assert.equal(write(paragraph(text(value))), value, value);
    }
    const escaped = [
        ["**bold**", "&#42;&#42;bold**"],
        ["`code`", "&#96;code`"],
        ["@**Iago**", "&#64;&#42;&#42;Iago**"],
        [":smile:", "&#58;smile:"],
        ["- item", "&#45; item"],
        ["1. item", "1&#46; item"],
        ["> quote", "&#62; quote"],
        ["# heading", "&#35; heading"],
        ["```", "&#96;``"],
        ["$$x$$", "&#36;$x$$"],
        ["[a](https://ex.com)", "&#91;a](https://ex.com)"],
        ["    indented", "&#32;   indented"],
    ];
    for (const [value, expected] of escaped) {
        const written = write(paragraph(text(value)));
        assert.equal(written, expected, value);
        // What was escaped reads back as the text it stands for.
        assert.equal(parse(written).firstChild.textContent, value);
    }
    // A line break does not hide syntax from the server, which reads a
    // paragraph's lines together.
    assert.equal(write(paragraph(text("``"), schema.node("hard_break"), text("``"))), "&#96;`\n``");
});

run_test("formatting is written as upstream's compose box would", () => {
    assert.equal(write(paragraph(text("bold", "strong"))), "**bold**");
    assert.equal(write(paragraph(text("both", "strong", "em"))), "***both***");
    assert.equal(write(paragraph(text("code", "code"))), "`code`");
    assert.equal(write(paragraph(text("x", "link"))), "[x](https://ex.com)");
    assert.equal(write(paragraph(text("x^2", "math"))), "$$x^2$$");
    // Whitespace cannot sit just inside italics, so it moves outside.
    assert.equal(write(paragraph(text(" a ", "em"))), " *a* ");
    // A code span picks a fence longer than any run of backticks inside.
    assert.equal(write(paragraph(text("a`b", "code"))), "``a`b``");
    // Formatting Zulip's Markdown cannot express is reported.
    const result = md.serialize_markdown(
        schema.node("doc", null, [
            schema.node("paragraph", null, [text("a", "em"), text("b", "strong")]),
        ]),
        context,
    );
    assert.ok(result.lossy);
});

run_test("positions map between the document and the Markdown", () => {
    const doc = parse("hi **there** @**Iago** ok");
    const {anchors, markdown} = md.serialize_markdown(doc, context);
    // The document position before "there" is inside the ** delimiters.
    const there = doc.firstChild.child(1);
    assert.equal(there.text, "there");
    assert.equal(md.pos_to_offset(anchors, 4), markdown.indexOf("there"));
    // A chip is one position wide and several characters long.
    const mention_start = markdown.indexOf("@**Iago**");
    assert.equal(md.offset_to_pos(anchors, mention_start), 10);
    assert.equal(md.offset_to_pos(anchors, mention_start + "@**Iago**".length), 11);
    // Inside a chip's Markdown, the nearer end of it.
    assert.equal(md.offset_to_pos(anchors, mention_start + 1), 10);
    assert.equal(md.offset_to_pos(anchors, mention_start + 8), 11);
    // Before the first character and past the last one.
    assert.equal(md.offset_to_pos(anchors, 0), 1);
    assert.equal(md.offset_to_pos(anchors, markdown.length), doc.content.size - 1);
    assert.equal(md.pos_to_offset(anchors, 0), 0);

    // Inside a code block the text and the Markdown run together.
    const code = parse("```python\nabc\n```");
    const code_anchors = md.serialize_markdown(code, context).anchors;
    assert.equal(md.pos_to_offset(code_anchors, 2), "```python\na".length);
    assert.equal(md.offset_to_pos(code_anchors, "```python\nab".length), 3);

    // In a quote, the "> " before each line is not part of the text.
    const quote = parse("> one\n> two");
    const quote_anchors = md.serialize_markdown(quote, context).anchors;
    assert.equal(md.pos_to_offset(quote_anchors, 3), "> o".length);
    assert.equal(md.offset_to_pos(quote_anchors, "> one\n> t".length), 7);
});

run_test("every mixture of Markdown reads back as it was written", () => {
    // The round trip is what keeps a message the user never sees as
    // Markdown from being changed by the editor, so it is checked over
    // a deterministic sweep of the syntax, in and out of every context.
    const pieces = [
        "*",
        "**",
        "~~",
        "`",
        "```",
        "$$",
        "@**Iago**",
        "@*hamletcharacters*",
        "#**Verona**",
        "#**Verona>t**",
        "[a](https://ex.com)",
        "![i](/user_uploads/2/i.png)",
        "\n",
        "\n\n",
        " ",
        "  ",
        "a",
        "한글",
        ":smile:",
        ":nosuch:",
        "&#42;",
        "&",
        "<time:2024-01-01>",
        "_",
        "|",
        "---",
        "    ",
        "\t",
        "```quote",
        "```spoiler H",
        "```math",
        "```py",
        "!",
        "[",
        "]",
        "(",
        ")",
        "- ",
        "* ",
        "1. ",
        "10. ",
        "> ",
        ">",
        "# ",
        "## ",
        "http://x.com/*a*",
        "~~~",
        ":",
        "@",
        "#",
        "<",
    ];
    // A small deterministic generator, so a failure can be repeated.
    let seed = 20_260_917;
    const next = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
    };
    let checked = 0;
    for (let i = 0; i < 400; i += 1) {
        let markdown = "";
        const length = 1 + Math.floor(next() * 10);
        for (let j = 0; j < length; j += 1) {
            markdown += pieces[Math.floor(next() * pieces.length)];
        }
        const doc = parse(markdown);
        doc.check();
        assert.equal(write(doc), markdown, `round trip of ${JSON.stringify(markdown)}`);
        checked += 1;
    }
    assert.equal(checked, 400);
});

run_test("blocks the editor shows, in their less usual forms", () => {
    // A quote inside a list item, which the editor does not show as a
    // list.
    assert_round_trip("- a\n> quoted", "doc(opaque_block)");
    // A list that changes kind, and one that nests deeper and comes back.
    assert_round_trip(
        "- a\n1. b",
        'doc(bullet_list(list_item(paragraph("a"))), ordered_list(list_item(paragraph("b"))))',
    );
    assert_round_trip("- a\n  - b\n  - c\n- d");
    // Lists of the same kind, kept apart by a blank line.
    assert_round_trip("- a\n\n- b");
    // A line without a marker belongs to the item above it.
    assert_round_trip("- a\nlazy");
    // A numbered list after text only starts at a single-digit number.
    assert_round_trip("text\n\n10. a");
    // A spoiler without a header, and an empty fenced block.
    assert_round_trip("```spoiler\nx\n```");
    assert_round_trip("```\n```");
    assert_round_trip("> a\n>\n> b");
    // Lines that only write back as they were when kept whole.
    assert_round_trip(
        "한글#**Verona**    *\n&~~~:x:**@*g*http://x.com/*a*![i](/user_uploads/2/i.png)",
    );
});

run_test("lines that cannot be shown as themselves are kept whole", () => {
    // Only the lines that need it become chips; the others stay text.
    assert_round_trip("\n$$)\n1. # ");
    assert_round_trip("```quote```quote\n> 1. ```spoiler H");
    // With a blank line among the lines that are kept whole.
    assert_round_trip("\n\n    \n[\n\n- 1. ");
    // Where only the first line has to be kept whole, the rest stays
    // text.
    assert_round_trip(
        "[a](b)``]\n```~~`",
        'doc(paragraph(opaque_inline, hard_break, code("``~~")))',
    );
    // With an empty line before it, which is a line break either way.
    assert_round_trip(
        "\n[a](b)[a](b)~~~~~~\nx",
        'doc(paragraph(hard_break, opaque_inline, hard_break, "x"))',
    );
    // With a blank line after the line that is kept whole.
    assert_round_trip(
        "[a](b)[a](b)~~~~~~\n\nx",
        'doc(paragraph(opaque_inline, hard_break, hard_break, "x"))',
    );
    // A quote whose last line is not quite the strict form.
    assert_round_trip("> a\n> ", "doc(opaque_block)");
    // Blocks that each write back on their own but not next to each
    // other are kept as one.
    assert_round_trip("> ```spoiler H@**Iago*** _[(#**V>t**(* [a](b)\n\n > ", "doc(opaque_block)");
});

run_test("blocks the editor makes, written as Markdown", () => {
    // A quote the editor made (no fence of its own) holding a code block
    // gets a fence long enough to hold it.
    const quote = schema.node("doc", null, [
        schema.node("blockquote", null, [schema.node("code_block", null, [schema.text("code()")])]),
    ]);
    assert.equal(write(quote), "````quote\n```\ncode()\n```\n````");
    // A spoiler the editor made, with and without a header.
    const spoiler = (header) =>
        schema.node("doc", null, [
            schema.node("spoiler", null, [
                schema.node(
                    "spoiler_header",
                    null,
                    header === "" ? undefined : schema.text(header),
                ),
                schema.node("paragraph", null, [schema.text("hidden")]),
            ]),
        ]);
    assert.equal(write(spoiler("Header")), "```spoiler Header\nhidden\n```");
    assert.equal(write(spoiler("")), "```spoiler\nhidden\n```");
    // An item whose marker does not fit where it ended up is renumbered.
    const list = schema.node("doc", null, [
        schema.node("ordered_list", null, [
            schema.node("list_item", {marker: "  - "}, [
                schema.node("paragraph", null, [schema.text("one")]),
            ]),
            schema.node("list_item", null, [schema.node("paragraph", null, [schema.text("two")])]),
        ]),
    ]);
    assert.equal(write(list), "1. one\n2. two");
    // An empty line after a list is one line away, as pressing Enter on
    // an empty item leaves it.
    const with_empty = schema.node("doc", null, [
        schema.node("bullet_list", null, [
            schema.node("list_item", {marker: "- "}, [
                schema.node("paragraph", null, [schema.text("one")]),
            ]),
        ]),
        schema.node("paragraph"),
    ]);
    assert.equal(write(with_empty), "- one\n");
    // A paragraph with something in it after a list is a blank line away
    // from it, so the server does not read it as part of the last item.
    const after_list = schema.node("doc", null, [
        with_empty.firstChild,
        schema.node("paragraph", null, [schema.text("text")]),
    ]);
    assert.equal(write(after_list), "- one\n\ntext");
    // A list the editor made, whose items have no marker of their own.
    const plain_list = schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("before")]),
        schema.node("bullet_list", null, [
            schema.node("list_item", null, [
                schema.node("paragraph", null, [schema.text("one")]),
                schema.node("bullet_list", null, [
                    schema.node("list_item", null, [
                        schema.node("paragraph", null, [schema.text("nested")]),
                    ]),
                ]),
            ]),
        ]),
    ]);
    assert.equal(write(plain_list), "before\n- one\n  - nested");
    // A fence that was never closed is closed again once something
    // follows it.
    const unclosed = schema.node("doc", null, [
        schema.node("code_block", {fence: "\u0060\u0060\u0060", close: null}, [
            schema.text("code()"),
        ]),
        schema.node("paragraph", null, [schema.text("after")]),
    ]);
    assert.equal(write(unclosed), "```\ncode()\n```\nafter");
    // A quote whose contents would close its fence gets a longer one.
    const closing_quote = schema.node("doc", null, [
        schema.node(
            "blockquote",
            {fence: "\u0060\u0060\u0060", info: "quote", close: "\u0060\u0060\u0060"},
            [schema.node("code_block", null, [schema.text("code()")])],
        ),
    ]);
    assert.equal(write(closing_quote), "````quote\n```\ncode()\n```\n````");
});

run_test("text that cannot be escaped is left as it is", () => {
    // Escaping never touches a code span or math, where the server
    // reads the characters as they are; a link's text is escaped like
    // any other text, and reads back as the same characters.
    const result = md.serialize_markdown(
        schema.node("doc", null, [
            schema.node("paragraph", null, [text("``", "link"), text("x``")]),
        ]),
        context,
    );
    assert.equal(result.markdown, "[&#96;`](https://ex.com)x``");
    assert.equal(parse(result.markdown).firstChild.textContent, "``x``");
    assert.ok(!result.lossy);
    // Formatting on whitespace alone is dropped, since the delimiters
    // cannot hold it, and whitespace at the edges of a run moves out.
    assert.equal(write(paragraph(text("   ", "em"))), "   ");
    assert.equal(write(paragraph(text("a"), text(" b ", "em"), text("c"))), "a *b* c");
    assert.equal(write(paragraph(text("a", "em"), text("   ", "em"), text("b", "em"))), "*a   b*");
    // Italics of nothing but whitespace between plain text is plain
    // too.
    assert.equal(write(paragraph(text("a"), text("  ", "em"), text("b"))), "a  b");
});

run_test("positions outside the text, and without anchors", () => {
    const anchors = [
        {pos: 0, off: 0},
        {pos: 1, off: 0, text: true},
        {pos: 4, off: 3, text: true},
        {pos: 5, off: 9},
    ];
    // Before the first anchor and after the last one.
    assert.equal(md.pos_to_offset(anchors, -1), 0);
    assert.equal(md.pos_to_offset(anchors, 9), 9);
    // Past the last character: the last position inside the text.
    assert.equal(md.offset_to_pos(anchors, 20), 4);
    assert.equal(md.offset_to_pos([], 3), 0);
    // An offset between anchors that do not run together lands on the
    // nearer one.
    assert.equal(md.offset_to_pos(anchors, 8), 4);
    assert.equal(md.offset_to_pos([{pos: 3, off: 5}], 1), 3);
    // Positions in syntax, where document positions and offsets do not
    // run together.
    const syntax = [
        {pos: 1, off: 0, text: true},
        {pos: 2, off: 9, text: true},
    ];
    assert.equal(md.pos_to_offset(syntax, 1), 0);
    assert.equal(md.offset_to_pos(syntax, 2), 1);
    assert.equal(md.offset_to_pos(syntax, 8), 2);
    // An offset that only a position outside the text sits on.
    assert.equal(
        md.offset_to_pos(
            [
                {pos: 0, off: 0},
                {pos: 5, off: 3},
            ],
            3,
        ),
        5,
    );
});

run_test("the default context is used when none is given", () => {
    assert.equal(md.parse_markdown("@**Nobody**").firstChild.firstChild.type.name, "mention");
    assert.equal(md.serialize_markdown(md.parse_markdown("hi")).markdown, "hi");
    assert.equal(md.serialize_inline([schema.text("hi")]), "hi");
});

run_test("entities are decoded and encoded", () => {
    assert.equal(md.decode_entity("&#42;"), "*");
    assert.equal(md.decode_entity("&#x2a;"), "*");
    assert.equal(md.decode_entity("&amp;"), "&");
    // Anything that is not a character stays as it was written.
    assert.equal(md.decode_entity("&#0;"), "&#0;");
    assert.equal(md.decode_entity("&nosuch;"), "&nosuch;");
    assert.equal(md.encode_entity("*"), "&#42;");
});

run_test("inline content can be written on its own", () => {
    const nodes = [text("a", "strong"), schema.node("hard_break"), text("b")];
    assert.equal(md.serialize_inline(nodes, context), "**a**\nb");
});

function mention(raw = "@**Iago**") {
    return schema.node("mention", {raw, kind: "user", silent: false, name: "Iago"});
}

run_test("chips are written outside formatting, with the space a mention needs", () => {
    const strong = schema.marks.strong.create();
    // Bold applied to a selection that starts with a mention: the pill
    // is not bold anyway, and "**@**Iago** please**" is no mention.
    assert.equal(
        write(paragraph(mention().mark([strong]), text(" please", "strong"))),
        "@**Iago** **please**",
    );
    // A mention right after a word, a delimiter or an escaped character
    // gets a space, which the server needs to read it.
    assert.equal(write(paragraph(text("hi"), mention())), "hi @**Iago**");
    assert.equal(write(paragraph(text("a", "strong"), mention())), "**a** @**Iago**");
    assert.equal(write(paragraph(text("@"), mention())), "@ @**Iago**");
    assert.equal(write(paragraph(text("("), mention(), text(")"))), "(@**Iago**)");
    const channel = schema.node("channel_link", {raw: "#**Verona**", stream_name: "Verona"});
    assert.equal(write(paragraph(text("see"), channel)), "see #**Verona**");
    assert.equal(write(paragraph(text("["), channel)), "[ #**Verona**");
    // An emoji in italics is written as itself.
    const emoji = schema.node("emoji", {raw: ":smile:", name: "smile"});
    assert.equal(
        write(paragraph(text("a", "em"), emoji.mark([schema.marks.em.create()]))),
        "*a*:smile:",
    );
    // A chip holding a link cannot be written as such.
    const linked = mention().mark([schema.marks.link.create({href: "https://ex.com"})]);
    assert.ok(md.serialize_markdown(paragraph(linked), context).lossy);
});

run_test("what the server would misread in a block is escaped", () => {
    const doc = (...blocks) => schema.node("doc", null, blocks);
    // Hashes ending a heading, which the server drops.
    assert.equal(write(doc(schema.node("heading", {level: 1}, [text("a #")]))), "# a &#35;");
    assert_round_trip("# a &#35;", 'doc(heading("a ", escape))');
    // A spoiler's header is one line, which the fence line must hold
    // whole and the server trims.
    const spoiler = (header) =>
        doc(
            schema.node("spoiler", null, [
                schema.node("spoiler_header", null, header),
                schema.node("paragraph", null, [text("x")]),
            ]),
        );
    assert.equal(write(spoiler([text("a`b~c")])), "```spoiler a&#96;b&#126;c\nx\n```");
    assert.equal(write(spoiler([text(" a ")])), "```spoiler &#32;a&#32;\nx\n```");
    assert.equal(write(spoiler([text(" ")])), "```spoiler &#32;\nx\n```");
    assert_round_trip("```spoiler a&#96;b\nx\n```");
    assert.ok(
        md.serialize_markdown(spoiler([text("a"), schema.node("hard_break"), text("b")]), context)
            .lossy,
    );
    // A poll or to-do list is the whole message.
    const widget = schema.node("opaque_block", {raw: "/poll a", kind: "widget"});
    assert.ok(!md.serialize_markdown(doc(widget), context).lossy);
    assert.ok(
        md.serialize_markdown(doc(widget, schema.node("paragraph", null, [text("b")])), context)
            .lossy,
    );
    // A backtick fence cannot carry a backtick in its info string.
    assert.equal(
        write(doc(schema.node("code_block", {info: "py`"}, [schema.text("x")]))),
        "~~~py`\nx\n~~~",
    );
    assert.equal(
        write(doc(schema.node("code_block", {fence: "```", info: "py`"}, [schema.text("x")]))),
        "~~~py`\nx\n~~~",
    );
    // Bold of a lone star would be a rule; a table typed as text, a
    // table.
    assert.equal(write(paragraph(text("*", "strong"))), "**&#42;**");
    assert.equal(
        write(paragraph(text("a|b"), schema.node("hard_break"), text("-|-"))),
        "a|b\n&#45;|-",
    );
    // A backslash keeps the server from reading the code span after it.
    assert.equal(write(paragraph(text("\\"), text("a", "code"))), "&#92;`a`");
    // Control characters, including what a placeholder is made of.
    assert.equal(write(paragraph(text("a\u0002klzzwxh:0000\u0003b"))), "a&#2;klzzwxh:0000&#3;b");
    assert.equal(parse("\u0002klzzwxh:0000\u0003").textContent, "\u0002klzzwxh:0000\u0003");
    // A blank line inside a list item stays inside it.
    const item = (...nodes) =>
        doc(
            schema.node("bullet_list", null, [
                schema.node("list_item", null, [schema.node("paragraph", null, nodes)]),
            ]),
        );
    assert.equal(
        write(item(text("a"), schema.node("hard_break"), schema.node("hard_break"), text("b"))),
        "- a\n  \n  b",
    );
    assert.equal(write(item(text("a"), schema.node("hard_break"), text("- b"))), "- a\n  &#45; b");
    assert_round_trip("- a\nb", 'doc(bullet_list(list_item(paragraph("a", hard_break, "b"))))');
    // Link text is escaped like any text, and the address is kept.
    assert.equal(write(paragraph(text("a]b", "link"))), "[a&#93;b](https://ex.com)");
    assert.equal(parse("[a&#93;b](https://ex.com)").firstChild.textContent, "a]b");
    assert.equal(write(paragraph(text("@**Iago**", "link"))), "[&#64;**Iago**](https://ex.com)");
    // What Markdown cannot hold is said to be lossy: a code span ending
    // in a backtick, math holding its own delimiter, marks that touch,
    // an address with a space.
    for (const nodes of [
        [text("a`", "code")],
        [text("a$$b", "math")],
        [text("a", "em"), text("b", "strong")],
        [schema.text("a", [schema.marks.link.create({href: "https://x.com/a b"})])],
    ]) {
        assert.ok(md.serialize_markdown(paragraph(...nodes), context).lossy, nodes.map(String));
    }
});

run_test("syntax repeated on many pasted lines is escaped in a few rounds", () => {
    // Closing delimiters left on each line would pair up line by line;
    // after the first rounds, whole delimiters are escaped.
    const line = "`a` *b* [c](https://x.com) $$d$$ **e**";
    const nodes = [];
    for (let i = 0; i < 6; i += 1) {
        if (i > 0) {
            nodes.push(schema.node("hard_break"));
        }
        nodes.push(text(line));
    }
    const result = md.serialize_markdown(paragraph(...nodes), context);
    assert.ok(!result.lossy);
    assert.equal(
        parse(result.markdown).textContent,
        Array.from({length: 6}, () => line).join("\n"),
    );
    assert.ok((result.markdown.match(/&#\d+;/gu) ?? []).length < 6 * 12);
});

run_test("a chip holding Markdown reads as what it holds", () => {
    for (const markdown of [
        "*a **b** c*",
        "[a](https://x.com 'title')",
        "[a](<https://x.com/a b>)",
    ]) {
        const result = md.serialize_markdown(parse(markdown), context);
        assert.equal(result.markdown, markdown);
        assert.ok(!result.lossy, markdown);
    }
});

// The inline content of a document as characters with their formatting
// and chips with their Markdown: an escaped character reads as the
// character, and a chip carries no formatting.
function inline_signature(doc) {
    const parts = [];
    doc.descendants((node) => {
        const marks = node.marks
            .map((mark) => mark.type.name)
            .toSorted()
            .join("+");
        if (node.isText) {
            parts.push(...[...node.text].map((char) => `${char}:${marks}`));
        } else if (node.type.name === "escape") {
            parts.push(`${node.attrs.char}:${marks}`);
        } else if (node.type.name === "hard_break") {
            parts.push("break");
        } else if (node.isInline) {
            parts.push(`${node.type.name}:${node.attrs.raw}`);
        }
        return true;
    });
    // The space written before a mention or channel link the server
    // could not read otherwise is the one thing added on purpose.
    return parts.join(" ").replaceAll(/ : (?=(?:mention|channel_link):)/gu, "");
}

run_test("what the editor makes reads back as it is, or is said to be lossy", () => {
    // The direction that protects what users make: documents built from
    // formatting and chips in every order are written, read back and
    // compared; a document that cannot be written is flagged.
    const pieces = [
        () => text("a"),
        () => text("*"),
        () => text("]"),
        () => text("`"),
        () => text(" "),
        () => text("b", "strong"),
        () => text("c", "em"),
        () => text("d", "strike"),
        () => text("e", "code"),
        () => text("f", "link"),
        () => text("g", "math"),
        () => text("h", "strong", "em"),
        () => mention(),
        () => schema.node("emoji", {raw: ":smile:", name: "smile"}),
        () => schema.node("escape", {raw: "&#42;", char: "*"}),
        () => schema.node("hard_break"),
    ];
    let checked = 0;
    let lossy = 0;
    for (const first of pieces) {
        for (const second of pieces) {
            for (const third of pieces) {
                const doc = paragraph(first(), second(), third());
                const result = md.serialize_markdown(doc, context);
                checked += 1;
                if (result.lossy) {
                    lossy += 1;
                    continue;
                }
                const back = parse(result.markdown);
                assert.equal(
                    inline_signature(back),
                    inline_signature(doc),
                    `${doc.toString()} written as ${JSON.stringify(result.markdown)}`,
                );
                assert.equal(write(back), result.markdown);
            }
        }
    }
    assert.equal(checked, pieces.length ** 3);
    // Only the combinations Markdown really cannot express are lossy.
    assert.ok(lossy < checked * 0.05, `${lossy} of ${checked} lossy`);
});

run_test("a pasted README does not cost seconds per keystroke", () => {
    // Literal text full of syntax is the worst case for escaping; the
    // reviewer measured 222 s for this document before the escaping
    // was made linear. The bound is generous, since coverage
    // instrumentation slows the test several times over.
    const line =
        "# Title\n- item with **bold** and `code` and *em* and [link](https://x.com) and :smile: and @**Iago**\n";
    const nodes = [];
    for (const [index, piece] of line.repeat(100).split("\n").entries()) {
        if (index > 0) {
            nodes.push(schema.node("hard_break"));
        }
        if (piece !== "") {
            nodes.push(schema.text(piece));
        }
    }
    const doc = paragraph(...nodes);
    assert.ok(doc.textContent.length > 10000);
    const stars = paragraph(schema.text("a * b ** c *** d ".repeat(600)));
    const before = process.cpuUsage();
    const readme = md.serialize_markdown(doc, context);
    const heavy = md.serialize_markdown(stars, context);
    const used = process.cpuUsage(before);
    const ms = (used.user + used.system) / 1000;
    assert.ok(!readme.lossy && !heavy.lossy);
    assert.ok(ms < 3000, `${ms} ms`);
    // Unchanged blocks are not written again.
    assert.equal(md.serialize_markdown(doc, context).markdown, readme.markdown);
});
