"use strict";

const assert = require("node:assert/strict");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const ykphone_rich_inline = zrequire("ykphone_rich_inline");

// What the server would find in a dev realm: Iago and the empty-string
// wildcards, one group, one channel, two emoji.
const context = {
    is_user_mention: (name) => ["Iago", "Iago|11", "all", "everyone"].includes(name),
    is_group_mention: (name) => name === "hamletcharacters",
    is_stream: (name) => name === "Verona",
    is_emoji: (name) => ["smile", "+1"].includes(name),
};

// A token as "type[source]", which reads better in assertions than the
// whole token objects.
function describe(tokens, source) {
    return tokens
        .map((token) => {
            const text = source.slice(token.start, token.end);
            const children =
                "children" in token && token.type !== "autolink"
                    ? `(${describe(token.children, source)})`
                    : "";
            return `${token.type}[${text}]${children}`;
        })
        .join(" ");
}

function tokens_of(source) {
    return describe(ykphone_rich_inline.tokenize(source, context), source);
}

run_test("text and formatting", () => {
    assert.equal(tokens_of("plain text"), "text[plain text]");
    assert.equal(
        tokens_of("**bold** and *italic* and ~~gone~~"),
        "strong[**bold**](text[bold]) text[ and ] em[*italic*](text[italic]) text[ and ] " +
            "strike[~~gone~~](text[gone])",
    );
    // Bold and italic over the same text is one pattern of its own.
    assert.equal(tokens_of("***both***"), "strong_em[***both***](text[both])");
    // Inside bold, the patterns that run after it still apply.
    assert.equal(
        tokens_of("**a *b* c**"),
        "strong[**a *b* c**](text[a ] em[*b*](text[b]) text[ c])",
    );
    // Zulip's italics take no whitespace just inside the delimiters; the
    // delimiters are kept as text by the not_strong pattern.
    assert.equal(tokens_of("* not italic *"), "literal[*] text[ not italic ] literal[*]");
    // A lone delimiter is kept as text by the not_strong pattern.
    assert.equal(tokens_of("2 * 3 * 4"), "text[2 ] literal[*] text[ 3 ] literal[*] text[ 4]");
});

run_test("code spans keep their contents", () => {
    assert.equal(tokens_of("`a *b* c`"), "code[`a *b* c`]");
    // The longest run of backticks wins, so a span can hold backticks.
    assert.equal(tokens_of("``a`b``"), "code[``a`b``]");
    const [code] = ykphone_rich_inline.tokenize("``x``", context);
    assert.equal(code.type === "code" && code.ticks, 2);
    // A pair of backslashes before a backtick is text, as it is for the
    // server's backtick pattern.
    assert.equal(
        tokens_of(String.raw`a\\` + "`b`"),
        String.raw`text[a] literal[\\] code[` + "`b`]",
    );
});

run_test("mentions, channels, emoji and times", () => {
    assert.equal(
        tokens_of("@**Iago** @_**Iago|11** @*hamletcharacters* @**nobody**"),
        "mention[@**Iago**] text[ ] mention[@_**Iago|11**] text[ ] " +
            "group_mention[@*hamletcharacters*] text[ @] strong[**nobody**](text[nobody])",
    );
    const [mention, , silent] = ykphone_rich_inline.tokenize("@**Iago** @_**Iago|11**", context);
    assert.equal(mention.type === "mention" && mention.silent, false);
    assert.equal(silent.type === "mention" && silent.silent, true);

    assert.equal(
        tokens_of("#**Verona** #**Verona>topic** #**Verona>topic@12** #**Elsinore**"),
        "stream[#**Verona**] text[ ] stream[#**Verona>topic**] text[ ] " +
            "stream[#**Verona>topic@12**] text[ #] strong[**Elsinore**](text[Elsinore])",
    );
    const topic = ykphone_rich_inline.tokenize("#**Verona** #**Verona>t@9**", context)[2];
    assert.equal(topic.type === "stream" && topic.topic, "t");
    assert.equal(topic.type === "stream" && topic.message_id, "9");

    // An emoji name the realm does not have stays text.
    assert.equal(tokens_of(":smile: :nosuch:"), "emoji[:smile:] text[ ] literal[:nosuch:]");
    // A time is a chip whether or not it can be parsed.
    assert.equal(tokens_of("<time:2024-01-01T10:00Z>"), "time[<time:2024-01-01T10:00Z>]");
    // A mention needs whitespace or an opening character before it.
    assert.equal(tokens_of("x@**Iago**"), "text[x@] strong[**Iago**](text[Iago])");
});

run_test("links, images and autolinks", () => {
    assert.equal(tokens_of("[text](http://x.com)"), "link[[text](http://x.com)](text[text])");
    // Link text is atomic for the server: no formatting inside it.
    assert.equal(tokens_of("[**t**](http://x.com)"), "link[[**t**](http://x.com)](text[**t**])");
    assert.equal(
        tokens_of("![a.png](/user_uploads/1/a.png)"),
        "image[![a.png](/user_uploads/1/a.png)]",
    );
    // Only uploaded files are images; another address is left to the
    // autolinker, as on the server.
    assert.equal(
        tokens_of("![a](http://x.com/a.png)"),
        "text[![a](] autolink[http://x.com/a.png] text[)]",
    );
    // A URL the server would linkify keeps what is inside it out of
    // reach of the formatting patterns.
    assert.equal(
        tokens_of("see http://x.com/*a* ok"),
        "text[see ] autolink[http://x.com/*a*] text[ ok]",
    );
    // A scheme the server does not allow is not a link.
    assert.equal(tokens_of("[x](javascript:alert(1))"), "text[[x](javascript:alert(1))]");
    assert.ok(ykphone_rich_inline.is_allowed_url("/user_uploads/1/a.png"));
    assert.ok(!ykphone_rich_inline.is_allowed_url("data:text/html,x"));
});

run_test("the forms a link's address can take", () => {
    // Every form Python-Markdown accepts and the composer can show.
    assert.equal(tokens_of("[a](<http://x.com>)"), "link[[a](<http://x.com>)](text[a])");
    assert.equal(
        tokens_of('[a](http://x.com "title")'),
        'link[[a](http://x.com "title")](text[a])',
    );
    assert.equal(
        tokens_of("[a](<http://x.com> 'title')"),
        "link[[a](<http://x.com> 'title')](text[a])",
    );
    assert.equal(tokens_of("[a](http://x.com/b(c)d)"), "link[[a](http://x.com/b(c)d)](text[a])");
    assert.equal(tokens_of("[a]( http://x.com )"), "link[[a]( http://x.com )](text[a])");
    assert.equal(
        tokens_of('[a](http://x.com "title" )'),
        'link[[a](http://x.com "title" )](text[a])',
    );
    // Nested brackets in the text are balanced.
    assert.equal(
        tokens_of("[a [b] c](http://x.com)"),
        "link[[a [b] c](http://x.com)](text[a [b] c])",
    );
    // Forms that are not links leave their text alone.
    assert.equal(tokens_of("[a](http://x.com"), "text[[a](] autolink[http://x.com]");
    assert.equal(tokens_of("[a](<http://x.com)"), "text[[a](<] autolink[http://x.com] text[)]");
    assert.equal(
        tokens_of('[a](http://x.com "unclosed)'),
        'text[[a](] autolink[http://x.com] text[ "unclosed)]',
    );
    assert.equal(tokens_of("[a"), "text[[a]");
    assert.equal(tokens_of("[a] no parens"), "text[[a] no parens]");
    // A link with no text of its own: the server shows its address.
    assert.equal(tokens_of("[](http://x.com)"), "link[[](http://x.com)]()");
});

run_test("entities, line breaks and math", () => {
    assert.equal(tokens_of("a&#42;b"), "text[a] entity[&#42;] text[b]");
    assert.equal(tokens_of("one\ntwo"), "text[one] br[\n] text[two]");
    assert.equal(tokens_of("$$x^2$$"), "tex[$$x^2$$]");
    // The server needs a non-word character before the math delimiters.
    assert.equal(tokens_of("a$$x$$"), "text[a$$x$$]");
});

run_test("the default context takes every name as valid", () => {
    const tokens = ykphone_rich_inline.tokenize("@**Nobody** @*nogroup* #**Nowhere** :nosuch:");
    assert.deepEqual(
        tokens.map((token) => token.type),
        ["mention", "text", "group_mention", "text", "stream", "text", "emoji"],
    );
});

run_test("addresses are checked as the server checks them", () => {
    const {is_allowed_url, sanitize_href} = ykphone_rich_inline;
    assert.ok(is_allowed_url("https://ex.com"));
    assert.ok(is_allowed_url("/user_uploads/1/a.png"));
    // eslint-disable-next-line no-script-url -- a javascript: address the code must refuse
    assert.ok(!is_allowed_url("javascript:alert(1)"));
    // The server unescapes entities before it looks at the scheme.
    assert.ok(!is_allowed_url("&#106;avascript:alert(1)"));
    assert.ok(!is_allowed_url("&#x6A;avascript:alert(1)"));
    assert.ok(is_allowed_url("https://ex.com/?a=&amp;b&#0;&lt;"));
    // What a link keeps as its address.
    assert.equal(sanitize_href(" https://ex.com/a b "), "https://ex.com/a%20b");
    assert.equal(sanitize_href("https://ex.com/a)b(c"), "https://ex.com/a%29b%28c");
    assert.equal(sanitize_href("ex.com"), "ex.com");
    assert.equal(sanitize_href(""), undefined);
    // eslint-disable-next-line no-script-url -- a javascript: address the code must refuse
    assert.equal(sanitize_href("javascript:x"), undefined);
    assert.equal(sanitize_href("https://ex.com/<b>"), undefined);
});

run_test("text that looks like a placeholder is text", () => {
    assert.equal(tokens_of("a\u0002klzzwxh:0000\u0003b"), "text[a\u0002klzzwxh:0000\u0003b]");
    // Many entities are stashed in one pass, in order.
    assert.equal(
        tokens_of("&#42;a&#42;b&amp;"),
        "entity[&#42;] text[a] entity[&#42;] text[b] entity[&amp;]",
    );
    assert.equal(tokens_of(":smile: :+1:"), "emoji[:smile:] text[ ] emoji[:+1:]");
    // Entities in link text are read; other syntax there is not.
    assert.equal(
        tokens_of("[a&#93;b :smile:](https://ex.com)"),
        "link[[a&#93;b :smile:](https://ex.com)](text[a] entity[&#93;] text[b :smile:])",
    );
});
