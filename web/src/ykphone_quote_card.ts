// Forwarded and quoted messages as Slack's card, for the 옆커폰 fork.
//
// Zulip renders a forward as a line of prose ("Iago said in #devel:")
// above a blockquote. Slack shows the original message itself: a
// bordered box with the sender's picture, name and time above the text
// they wrote, with the forwarder's own note in the message around it.
//
// The message is server-rendered markdown, so the card is made by
// rewriting that HTML after it is rendered — from
// rendered_markdown.update_elements, which every place that shows a
// message runs (the feed, the thread panel, the pins panel, the
// compose preview, the drafts overlay). **No markup is built from the
// message's text**: the sender's name, the links and the body are the
// nodes the server sent, moved into the card, so nothing can be
// re-inserted unescaped. Only the avatar is added, and its URL comes
// from the user object, not from the message.
//
// Anyone can type the markdown a forward produces, so a card must not
// lend a typed quote more authority than upstream's prose line does:
//
// - The header must be exactly the shape compose_reply generates — the
//   sender's silent mention first, one same-origin link to a message,
//   at most one link to the channel or topic, silent mentions of the
//   recipients, and nothing but the header's own connecting words.
//   Anything the author wrote besides that leaves the quote as the
//   ordinary blockquote it is, so no text is ever dropped.
// - The picture and the time (which link to the original) are shown
//   only when this client has the quoted message and its sender is the
//   user the header names. Otherwise the card carries the name (and the
//   link to the channel, which claims nothing about the sender) alone,
//   which is all upstream's prose line claims either.
//
// A quote that contains another quote, and a blockquote that is not a
// direct child of the message (inside a list, a spoiler, a quote), are
// always left alone.

import * as message_store from "./message_store.ts";
import * as muted_users from "./muted_users.ts";
import * as people from "./people.ts";
import * as timerender from "./timerender.ts";

// "said" links to the quoted message: "#narrow/channel/7-devel/topic/foo/near/123"
// or "#narrow/dm/11,6-group/near/99".
const NEAR_HASH_PATTERN = /^#narrow\/.+\/near\/(\d+)$/;
// The "in #devel > foo" part links to the channel or the topic.
const CHANNEL_HASH_PATTERN = /^#narrow\/channel\/[^/]+(?:\/topic\/[^/]*)?$/;
// The only words compose_reply's header puts between its parts, in the
// languages the fork ships (English and Korean): the translations of
// "{username} [said](…) in {topic_link}:" / "… to {recipients}:" and
// the list joiner of the recipients. A header in another language, or
// with any word the author added, is left as the blockquote it is — so
// nothing the author wrote is ever dropped.
const CONNECTING_WORDS = new Set(["in", "to", "and", "님이", "에서", "에게", "및"]);
// The label of the link to the quoted message, which the card replaces
// with the time; any other label is the author's own words.
const SAID_LABELS = new Set(["said", "말함"]);

type ForwardQuote = {
    // The paragraph the server rendered the header into; it is dropped
    // once the card has taken the parts of it that are kept.
    header: Element;
    // The silent mention of the sender, with their name as its text.
    sender: Element;
    // The link to the quoted message.
    link: Element;
    // The link to the channel or topic the message was in, if any.
    context: Element | undefined;
    sender_id: number | undefined;
    quoted_message_id: number;
};

// The hash of a link that points into this Zulip, or undefined for a
// link anywhere else. The server writes same-realm links as relative
// ("#narrow/…"), a locally echoed message has them absolute, and a
// channel link is "/#narrow/…".
export function same_origin_narrow_hash(href: string | null): string | undefined {
    if (href === null) {
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(href, window.location.href);
    } catch {
        return undefined;
    }
    if (
        url.origin !== window.location.origin ||
        url.pathname !== "/" ||
        url.search !== "" ||
        !url.hash.startsWith("#narrow/")
    ) {
        return undefined;
    }
    return url.hash;
}

export function quoted_message_id(href: string | null): number | undefined {
    const hash = same_origin_narrow_hash(href);
    if (hash === undefined) {
        return undefined;
    }
    const match = NEAR_HASH_PATTERN.exec(hash);
    if (match === null) {
        return undefined;
    }
    return Number.parseInt(match[1]!, 10);
}

function is_channel_link(element: Element): boolean {
    const hash = same_origin_narrow_hash(element.getAttribute("href"));
    return hash !== undefined && CHANNEL_HASH_PATTERN.test(hash);
}

function is_silent_mention(element: Element): boolean {
    return element.classList.contains("user-mention") && element.classList.contains("silent");
}

function parse_user_id(element: Element): number | undefined {
    const raw = element.getAttribute("data-user-id");
    if (raw === null) {
        return undefined;
    }
    const user_id = Number.parseInt(raw, 10);
    return Number.isNaN(user_id) ? undefined : user_id;
}

// Decides whether a blockquote is the quote half of a forward, and
// picks out the pieces of its header that the card keeps. Exported so
// that the decision can be tested apart from the DOM surgery.
// Node types by nodeType rather than instanceof, which also holds for
// nodes from another document.
function is_text(node: Node): node is Text {
    return node.nodeType === node.TEXT_NODE;
}

function is_element(node: Node): node is Element {
    return node.nodeType === node.ELEMENT_NODE;
}

export function parse_forward_quote(blockquote: Element): ForwardQuote | undefined {
    if (blockquote.querySelector("blockquote") !== null) {
        return undefined;
    }
    const header = blockquote.previousElementSibling;
    if (header?.tagName !== "P") {
        return undefined;
    }
    const sender = header.firstElementChild;
    if (sender === null || header.firstChild !== sender || !is_silent_mention(sender)) {
        return undefined;
    }

    let link: Element | undefined;
    let quoted_id: number | undefined;
    let context: Element | undefined;
    for (const node of header.childNodes) {
        if (node === sender) {
            continue;
        }
        if (is_text(node)) {
            const words = node.data.replaceAll(/[:,]/g, " ").split(/\s+/);
            if (words.some((word) => word !== "" && !CONNECTING_WORDS.has(word))) {
                return undefined;
            }
            continue;
        }
        if (!is_element(node)) {
            // A comment or anything else the header shape has no place for.
            return undefined;
        }
        const element = node;
        const is_link = element.tagName === "A";
        const id = is_link ? quoted_message_id(element.getAttribute("href")) : undefined;
        if (id !== undefined && link === undefined && SAID_LABELS.has(element.textContent.trim())) {
            link = element;
            quoted_id = id;
        } else if (
            is_link &&
            id === undefined &&
            context === undefined &&
            is_channel_link(element)
        ) {
            context = element;
        } else if (!is_silent_mention(element)) {
            return undefined;
        }
    }
    if (link === undefined || quoted_id === undefined) {
        return undefined;
    }
    return {
        header,
        sender,
        link,
        context,
        sender_id: parse_user_id(sender),
        quoted_message_id: quoted_id,
    };
}

// Whether the header's claim holds: this client has the quoted message
// and it was sent by the user the header names.
export function is_verified(quote: ForwardQuote): boolean {
    const message = message_store.get(quote.quoted_message_id);
    return (
        message !== undefined &&
        quote.sender_id !== undefined &&
        message.sender_id === quote.sender_id
    );
}

function time_label(message_id: number): string {
    const message = message_store.get(message_id)!;
    return timerender.get_localized_date_or_time_for_format(
        new Date(message.timestamp * 1000),
        "dayofyear_time",
    );
}

function avatar_url(sender_id: number): string | undefined {
    if (muted_users.is_user_muted(sender_id)) {
        // The feed hides a muted user's picture; so does the card.
        return undefined;
    }
    const person = people.maybe_get_user_by_id(sender_id, true);
    if (person === undefined) {
        return undefined;
    }
    return people.small_avatar_url_for_person(person);
}

function build_card(quote: ForwardQuote, blockquote: Element): Element {
    // Non-null because ownerDocument is null only on a Document node.
    const doc = blockquote.ownerDocument;
    const card = doc.createElement("div");
    card.className = "ykphone-quote-card";

    const header_row = doc.createElement("div");
    header_row.className = "ykphone-quote-card-header";
    const verified = is_verified(quote);
    const src = verified ? avatar_url(quote.sender_id!) : undefined;
    if (src !== undefined) {
        const avatar = doc.createElement("img");
        avatar.className = "ykphone-quote-card-avatar";
        avatar.src = src;
        avatar.alt = "";
        avatar.loading = "lazy";
        header_row.append(avatar);
    }
    // Moved, not rebuilt: the mention keeps the name the server sent
    // (and whatever rendered_markdown has already made of it) and the
    // links keep their hrefs.
    quote.sender.classList.add("ykphone-quote-card-sender");
    header_row.append(quote.sender);
    if (verified) {
        quote.link.classList.add("ykphone-quote-card-time");
        quote.link.textContent = time_label(quote.quoted_message_id);
        header_row.append(quote.link);
    }
    // Where the message was is a link like any other, not a claim about
    // who sent it, so it is kept either way.
    if (quote.context !== undefined) {
        quote.context.classList.add("ykphone-quote-card-context");
        header_row.append(quote.context);
    }

    const body = doc.createElement("div");
    body.className = "ykphone-quote-card-body";
    body.append(...blockquote.childNodes);

    card.append(header_row, body);
    return card;
}

// Rewrites every forwarded quote of one rendered message. Runs after
// the rest of update_elements, so the mentions and links inside the
// quote have already been brought up to date.
export function update_quote_blocks(roots: Element[]): void {
    for (const root of roots) {
        const blockquotes = [...root.children].filter((child) => child.tagName === "BLOCKQUOTE");
        for (const blockquote of blockquotes) {
            const quote = parse_forward_quote(blockquote);
            if (quote === undefined) {
                continue;
            }
            blockquote.replaceWith(build_card(quote, blockquote));
            quote.header.remove();
        }
    }
}
