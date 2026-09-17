"use strict";

const assert = require("node:assert/strict");

const {JSDOM} = require("jsdom");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

// Quoted messages this client has: 123 and 99 were sent by Iago (11),
// 500 by the CEO (8).
const known_messages = new Map([
    [123, {sender_id: 11, timestamp: 1_700_000_000}],
    [99, {sender_id: 11, timestamp: 1_700_000_100}],
    [500, {sender_id: 8, timestamp: 1_700_000_200}],
]);
mock_esm("../src/message_store", {
    get: (message_id) => known_messages.get(message_id),
});
const muted_users = mock_esm("../src/muted_users", {
    is_user_muted: () => false,
});
const people = mock_esm("../src/people", {
    maybe_get_user_by_id: (user_id) => ({user_id}),
    small_avatar_url_for_person: (person) => `/avatar/${person.user_id}`,
});
mock_esm("../src/timerender", {
    get_localized_date_or_time_for_format: (date, format) => `${format}(${date.getTime()})`,
});

const ykphone_quote_card = zrequire("ykphone_quote_card");

// The exact HTML the server renders for the markdown
// compose_reply.generate_replace_content produces, checked against the
// backend's markdown_convert.
const CHANNEL_QUOTE_HTML = `<p><span class="user-mention silent" data-user-id="11">Iago</span> <a href="#narrow/channel/7-devel/topic/foo/near/123">said</a> in <a href="#narrow/channel/7-devel/topic/foo">#devel &gt; foo</a>:</p>
<blockquote>
<p>hello <em>world</em></p>
<p>second para</p>
</blockquote>`;

const DM_QUOTE_HTML = `<p><span class="user-mention silent" data-user-id="11">Iago</span> <a href="#narrow/dm/11,6-group/near/99">said</a> to <span class="user-mention silent" data-user-id="6">aaron</span>:</p>
<blockquote>
<p>dm body</p>
</blockquote>`;

// The Korean translation puts the parts in another order.
const KOREAN_QUOTE_HTML = `<p><span class="user-mention silent" data-user-id="11">Iago</span>님이 <a href="#narrow/channel/7-devel/topic/foo">#devel &gt; foo</a>에서 <a href="#narrow/channel/7-devel/topic/foo/near/123">말함</a>:</p><blockquote><p>x</p></blockquote>`;

// A channel's general chat: the fork's header names the channel with a
// channel link, which the server renders as "/#narrow/…".
const GENERAL_CHAT_QUOTE_HTML = `<p><span class="user-mention silent" data-user-id="11">Iago</span>님이 <a class="stream" data-stream-id="7" href="/#narrow/channel/7-devel">#devel</a>에서 <a href="#narrow/channel/7-devel/topic//near/123">말함</a>:</p><blockquote><p>x</p></blockquote>`;

function content_root(html) {
    const {window} = new JSDOM(`<div class="message_content">${html}</div>`);
    return window.document.querySelector(".message_content");
}

function header(html_between) {
    return `<p><span class="user-mention silent" data-user-id="11">Iago</span>${html_between}</p><blockquote><p>x</p></blockquote>`;
}

run_test("quoted_message_id", () => {
    assert.equal(
        ykphone_quote_card.quoted_message_id("#narrow/channel/7-devel/topic/foo/near/123"),
        123,
    );
    assert.equal(ykphone_quote_card.quoted_message_id("#narrow/dm/11,6-group/near/99"), 99);
    // A locally echoed message has the link absolute, on this origin.
    assert.equal(
        ykphone_quote_card.quoted_message_id("http://zulip.zulipdev.com/#narrow/dm/11-x/near/5"),
        5,
    );
    // Links anywhere else are not quote links, however they end.
    for (const href of [
        "https://evil.example/#narrow/x/near/5",
        "http://zulip.zulipdev.com/other/#narrow/x/near/5",
        "http://zulip.zulipdev.com/?x=1#narrow/x/near/5",
        "https://example.com/near/5",
        "#narrow/near/5",
        "#narrow/channel/7-devel/topic/foo",
        "#narrow/dm/11-x/near/5/extra",
        "http://[",
        null,
    ]) {
        assert.equal(ykphone_quote_card.quoted_message_id(href), undefined, String(href));
    }
});

run_test("parse_forward_quote recognizes a forward", () => {
    for (const [name, html, expected_id, has_context] of [
        ["channel", CHANNEL_QUOTE_HTML, 123, true],
        ["dm", DM_QUOTE_HTML, 99, false],
        ["korean", KOREAN_QUOTE_HTML, 123, true],
        ["general chat", GENERAL_CHAT_QUOTE_HTML, 123, true],
    ]) {
        const root = content_root(html);
        const quote = ykphone_quote_card.parse_forward_quote(root.querySelector("blockquote"));
        assert.ok(quote !== undefined, name);
        assert.equal(quote.quoted_message_id, expected_id, name);
        assert.equal(quote.sender_id, 11, name);
        assert.equal(quote.sender.textContent, "Iago", name);
        assert.equal(quote.context !== undefined, has_context, name);
    }
});

run_test("parse_forward_quote leaves everything else alone", () => {
    const near = '<a href="#narrow/dm/11-x/near/2">said</a>';
    const cases = {
        // An ordinary quote, with no header at all.
        plain: "<blockquote>\n<p>just a quote</p>\n</blockquote>",
        // A paragraph of plain text above a quote.
        text_header: "<p>as I said:</p><blockquote><p>x</p></blockquote>",
        // A paragraph that starts with some other element.
        not_a_mention: `<p><em>Iago</em> ${near}:</p><blockquote><p>x</p></blockquote>`,
        // The mention has to start the header.
        mention_not_first: `<p>look, <span class="user-mention silent" data-user-id="11">Iago</span> ${near}:</p><blockquote><p>x</p></blockquote>`,
        // A loud mention is someone being notified, not a quote header.
        loud_mention: `<p><span class="user-mention" data-user-id="11">@Iago</span> ${near}:</p><blockquote><p>x</p></blockquote>`,
        // The header is a heading rather than a paragraph.
        header_not_paragraph: `<h1><span class="user-mention silent" data-user-id="11">Iago</span> ${near}:</h1><blockquote><p>x</p></blockquote>`,
        // A forward of a forward keeps the nesting the blockquotes show.
        nested: `${header(` ${near}:`).replace("</blockquote>", "")}<blockquote><p>y</p></blockquote></blockquote>`,
        // No link to a message, or only a link to a conversation.
        no_link: header(" wrote:"),
        conversation_link: header(' <a href="#narrow/channel/7-devel/topic/foo">said</a>:'),
        // Words the author wrote in the header would be dropped by the
        // card, so the quote stays as it is.
        extra_text: header(
            ' 이건 틀렸어요, 원문은 <a href="#narrow/channel/7-devel/topic/foo/near/123">여기</a>:',
        ),
        // An off-site link dressed as a message link.
        off_site_link: header(' <a href="https://evil.example/#narrow/x/near/123">said</a>:'),
        // Extra links or elements the generated header never has.
        second_message_link: header(` ${near} and ${near}:`),
        extra_off_site_link: header(` ${near} <a href="https://evil.example/">see</a>:`),
        second_channel_link: header(
            ` ${near} in <a href="#narrow/channel/7-devel">#devel</a> <a href="#narrow/channel/8-x">#x</a>:`,
        ),
        extra_element: header(` ${near} <strong>urgent</strong>:`),
        // The message link's label is replaced by the time, so a label
        // of the author's own keeps the blockquote.
        own_label: header(' <a href="#narrow/dm/11-x/near/2">said, and I agree</a>:'),
        // Even one word of the author's own is kept, as a blockquote.
        extra_word: header(` ${near} URGENT:`),
        // A header in a language the fork does not ship.
        other_language: header(` ${near} sagte:`),
        comment: header(` ${near}<!-- hidden -->:`),
    };
    for (const [name, html] of Object.entries(cases)) {
        const root = content_root(html);
        assert.equal(
            ykphone_quote_card.parse_forward_quote(root.querySelector("blockquote")),
            undefined,
            name,
        );
    }
});

run_test("update_quote_blocks builds a verified card", () => {
    const root = content_root(`<p>look at this</p>${CHANNEL_QUOTE_HTML}`);
    const quoted_body = root.querySelector("blockquote em");
    ykphone_quote_card.update_quote_blocks([root]);

    // The forwarder's own note stays above the card.
    assert.equal(root.children[0].tagName, "P");
    assert.equal(root.children[0].textContent, "look at this");
    // The header paragraph and the blockquote are replaced by one card.
    assert.equal(root.children.length, 2);
    const card = root.children[1];
    assert.equal(card.className, "ykphone-quote-card");

    const avatar = card.querySelector(".ykphone-quote-card-avatar");
    assert.equal(avatar.getAttribute("src"), "/avatar/11");
    assert.equal(avatar.getAttribute("alt"), "");
    assert.equal(card.querySelector(".ykphone-quote-card-sender").textContent, "Iago");
    const time = card.querySelector(".ykphone-quote-card-time");
    assert.equal(time.textContent, "dayofyear_time(1700000000000)");
    assert.equal(time.getAttribute("href"), "#narrow/channel/7-devel/topic/foo/near/123");
    const context = card.querySelector(".ykphone-quote-card-context");
    assert.equal(context.textContent, "#devel > foo");

    // The body holds the very nodes the server sent, not a copy: no
    // markup is ever rebuilt from the message's own text.
    const body = card.querySelector(".ykphone-quote-card-body");
    assert.equal(body.querySelector("em"), quoted_body);
    assert.equal(body.querySelectorAll("p").length, 2);
});

run_test("update_quote_blocks does not lend an identity to an unverified header", () => {
    function card_for(html) {
        const root = content_root(html);
        ykphone_quote_card.update_quote_blocks([root]);
        const card = root.querySelector(".ykphone-quote-card");
        assert.ok(card !== null);
        return card;
    }
    function assert_name_only(card, name) {
        assert.equal(card.querySelector(".ykphone-quote-card-sender").textContent, "Iago");
        assert.equal(card.querySelector(".ykphone-quote-card-avatar"), null, name);
        assert.equal(card.querySelector(".ykphone-quote-card-time"), null, name);
        // The only link left is the header's link to a channel, if any.
        assert.equal(
            card.querySelector(".ykphone-quote-card-header a:not(.ykphone-quote-card-context)"),
            null,
            name,
        );
    }

    // The header names Iago but links to a real message the CEO sent:
    // a forged forward cannot borrow the message's time or Iago's face.
    assert_name_only(
        card_for(header(' <a href="#narrow/channel/1-general/topic/x/near/500">said</a>:')),
        "forged",
    );
    // A message this client does not have cannot be checked; the link to
    // the channel stays, since it claims nothing about the sender.
    const unknown = card_for(
        header(
            ' <a href="#narrow/channel/1-general/topic/x/near/777">said</a> in <a href="#narrow/channel/1-general">#general</a>:',
        ),
    );
    assert_name_only(unknown, "unknown message");
    assert.equal(unknown.querySelector(".ykphone-quote-card-context").textContent, "#general");
    // A mention without a readable user id cannot be checked either.
    for (const attribute of ["", ' data-user-id="unknown"']) {
        assert_name_only(
            card_for(
                `<p><span class="user-mention silent"${attribute}>Iago</span> <a href="#narrow/dm/11-x/near/123">said</a>:</p><blockquote><p>x</p></blockquote>`,
            ),
            `mention${attribute}`,
        );
    }
});

run_test("update_quote_blocks hides pictures the feed would", ({override}) => {
    // A muted sender, and a sender this client has no user object for,
    // keep the verified time but no picture.
    override(muted_users, "is_user_muted", (user_id) => user_id === 11);
    let root = content_root(DM_QUOTE_HTML);
    ykphone_quote_card.update_quote_blocks([root]);
    assert.equal(root.querySelector(".ykphone-quote-card-avatar"), null);
    assert.ok(root.querySelector(".ykphone-quote-card-time") !== null);

    override(muted_users, "is_user_muted", () => false);
    override(people, "maybe_get_user_by_id", () => undefined);
    root = content_root(DM_QUOTE_HTML);
    ykphone_quote_card.update_quote_blocks([root]);
    assert.equal(root.querySelector(".ykphone-quote-card-avatar"), null);
    assert.ok(root.querySelector(".ykphone-quote-card-time") !== null);
});

run_test("update_quote_blocks skips quotes it does not own", () => {
    // A blockquote that is not a direct child of the rendered message
    // (inside a list, a spoiler or another quote) is left alone, and so
    // is a quote whose header does not match.
    const root = content_root(
        `<ul><li>${CHANNEL_QUOTE_HTML}</li></ul><blockquote><p>plain</p></blockquote>`,
    );
    ykphone_quote_card.update_quote_blocks([root]);
    assert.equal(root.querySelector(".ykphone-quote-card"), null);
    assert.equal(root.querySelectorAll("blockquote").length, 2);
});

run_test("update_quote_blocks handles several messages and several quotes", () => {
    const first = content_root(`${CHANNEL_QUOTE_HTML}<p>and</p>${DM_QUOTE_HTML}`);
    // Several recipients are joined as the sender's language lists them.
    const group_dm = `<p><span class="user-mention silent" data-user-id="11">Iago</span>님이 <span class="user-mention silent" data-user-id="6">aaron</span>, <span class="user-mention silent" data-user-id="7">Zoe</span> 및 <span class="user-mention silent" data-user-id="9">Desdemona</span>에게 <a href="#narrow/dm/6,7,9,11-group/near/99">말함</a>:</p><blockquote><p>x</p></blockquote>`;
    assert.ok(
        ykphone_quote_card.parse_forward_quote(content_root(group_dm).querySelector("blockquote")),
    );
    const second = content_root(KOREAN_QUOTE_HTML);
    ykphone_quote_card.update_quote_blocks([first, second]);

    assert.equal(first.querySelectorAll(".ykphone-quote-card").length, 2);
    assert.equal(first.querySelectorAll("blockquote").length, 0);
    assert.equal(second.querySelectorAll(".ykphone-quote-card").length, 1);
    // An empty list of roots is not an error.
    ykphone_quote_card.update_quote_blocks([]);
});
