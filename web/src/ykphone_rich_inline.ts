// Zulip's inline Markdown grammar, for the 옆커폰 rich composer.
//
// The rich composer shows formatted text and chips instead of Markdown
// syntax, but the compose textarea — and so every message sent — still
// holds Markdown. To turn that Markdown into editor content, and to
// know which characters of literal text would be read as syntax (and so
// need escaping), the composer needs to tokenize a line of Markdown the
// way the server does.
//
// This is a port of the relevant part of Python-Markdown's
// InlineProcessor as configured by zerver/lib/markdown/__init__.py
// (build_inlinepatterns): patterns run in priority order over the whole
// text; a match is replaced by a placeholder so lower-priority patterns
// cannot see into it; the text inside bold, italic and strikethrough is
// processed again with only the lower-priority patterns. The regular
// expressions are Zulip's, translated to JavaScript (Python's `\w` is
// Unicode-aware, so it becomes `[\p{L}\p{N}_]`).
//
// What depends on server data (does this user, group, channel or emoji
// exist?) is asked of the caller through InlineContext. Linkifiers and
// emoticon translation are not modelled: they only turn text into
// links or emoji and never into formatting.
//
// Tokens carry source offsets into the original string, so callers can
// map every token back to the characters it was made of.

export type InlineContext = {
    is_user_mention: (name: string) => boolean;
    is_group_mention: (name: string) => boolean;
    is_stream: (name: string) => boolean;
    is_emoji: (name: string) => boolean;
};

export const permissive_context: InlineContext = {
    is_user_mention: () => true,
    is_group_mention: () => true,
    is_stream: () => true,
    is_emoji: () => true,
};

type Span = {start: number; end: number};

export type ContainerType = "strong" | "em" | "strike" | "strong_em";

export type InlineToken =
    // Characters that are shown as they are.
    | ({type: "text"} & Span)
    // A newline inside a paragraph, rendered as <br>.
    | ({type: "br"} & Span)
    // Text a pattern consumed but left as text (an unknown emoji name,
    // a lone `*`); lower-priority patterns cannot see into it.
    | ({type: "literal"} & Span)
    | ({type: "code"; ticks: number} & Span)
    | ({type: ContainerType; delimiter: number; children: InlineToken[]} & Span)
    | ({type: "mention" | "group_mention"; silent: boolean; name: string} & Span)
    | ({
          type: "stream";
          stream_name: string;
          topic: string | undefined;
          message_id: string | undefined;
      } & Span)
    | ({type: "tex"; body: string} & Span)
    | ({type: "time"; time: string} & Span)
    | ({type: "link"; href: string; text: Span; children: InlineToken[]} & Span)
    | ({type: "image"; alt: string; src: string} & Span)
    // A URL the server links; what higher-priority patterns found inside
    // it (a time, say) is kept.
    | ({type: "autolink"; children: InlineToken[]} & Span)
    | ({type: "entity"} & Span)
    | ({type: "emoji"; name: string} & Span);

// Python's `\w`, `\s` for str patterns are Unicode-aware.
const WORD = String.raw`[\p{L}\p{N}_]`;
// zerver/lib/mention.py BEFORE_MENTION_ALLOWED_REGEX and
// BEFORE_LINK_PRODUCING_MENTION_ALLOWED_REGEX.
const BEFORE_MENTION = String.raw`(?<![^\s'"({\[/<])`;
const BEFORE_LINK_PRODUCING_MENTION = String.raw`(?<![^\s'"({/<])`;

// Characters a placeholder is made of, as in Python-Markdown.
const STX = "\u0002";
const ETX = "\u0003";
// eslint-disable-next-line no-control-regex -- control characters are what this matches
const PLACEHOLDER_RE = /\u0002klzzwxh:(\d+)\u0003/gu;

// The URL schemes zerver/lib/markdown sanitize_url lets through.
const ALLOWED_SCHEMES = new Set([
    "http",
    "https",
    "ftp",
    "file",
    "mid",
    "bitcoin",
    "geo",
    "hansoft",
    "im",
    "irc",
    "ircs",
    "magnet",
    "mailto",
    "matrix",
    "obsidian",
    "mms",
    "news",
    "nntp",
    "openpgp4fpr",
    "sip",
    "sms",
    "smsto",
    "ssh",
    "tel",
    "urn",
    "webcal",
    "wtai",
    "xmpp",
    "zotero",
    "asanadesktop",
]);

// The working state of one run of the inline processor: the text with
// placeholders in it, and for every character the source span it stands
// for (a placeholder's characters all stand for the whole stashed token).
type Work = {
    data: string;
    starts: number[];
    ends: number[];
};

type Match = {
    // Offsets into Work.data.
    start: number;
    end: number;
    token: InlineToken;
};

type Tokenizer = {
    ctx: InlineContext;
    stash: InlineToken[];
};

// A pattern finds the first match to stash, or, when its matches can
// neither overlap nor be made by stashing (an entity, an emoji), all of
// them at once.
type Pattern = (
    work: Work,
    tokenizer: Tokenizer,
    pattern_index: number,
) => Match | Match[] | undefined;

function source_span(work: Work, start: number, end: number): Span {
    if (start === end) {
        // An empty range — a link with no text — sits right after the
        // character before it, and there is always one, since something
        // opened the range.
        const at = work.ends[start - 1]!;
        return {start: at, end: at};
    }
    return {start: work.starts[start]!, end: work.ends[end - 1]!};
}

function slice_work(work: Work, start: number, end: number): Work {
    return {
        data: work.data.slice(start, end),
        starts: work.starts.slice(start, end),
        ends: work.ends.slice(start, end),
    };
}

// Turns processed text back into tokens: placeholders become their
// stashed tokens, and the characters between them text.
function to_tokens(work: Work, tokenizer: Tokenizer): InlineToken[] {
    const tokens: InlineToken[] = [];
    let text_start = 0;
    const push_text = (end: number): void => {
        if (end > text_start) {
            tokens.push({type: "text", ...source_span(work, text_start, end)});
        }
    };
    for (const match of work.data.matchAll(PLACEHOLDER_RE)) {
        push_text(match.index);
        tokens.push(tokenizer.stash[Number(match[1])]!);
        text_start = match.index + match[0].length;
    }
    push_text(work.data.length);
    return tokens;
}

function placeholder_for(tokenizer: Tokenizer, token: InlineToken): string {
    const id = tokenizer.stash.length;
    tokenizer.stash.push(token);
    return `${STX}klzzwxh:${String(id).padStart(4, "0")}${ETX}`;
}

// Replaces one match with its placeholder, editing the offset arrays in
// place: a paragraph can hold thousands of matches, and copying them for
// each one made tokenizing quadratic.
function stash_match(work: Work, tokenizer: Tokenizer, match: Match): void {
    const placeholder = placeholder_for(tokenizer, match.token);
    const {start, end} = match.token;
    work.data = work.data.slice(0, match.start) + placeholder + work.data.slice(match.end);
    const length = match.end - match.start;
    work.starts.splice(
        match.start,
        length,
        ...Array.from({length: placeholder.length}, () => start),
    );
    work.ends.splice(match.start, length, ...Array.from({length: placeholder.length}, () => end));
}

// Replaces the matches (in order, not overlapping) with placeholders in
// one pass over the work, so that stashing a thousand entities does not
// move the rest of the text a thousand times.
function stash_matches(work: Work, tokenizer: Tokenizer, matches: Match[]): void {
    let data = "";
    const starts: number[] = [];
    const ends: number[] = [];
    let from = 0;
    for (const match of matches) {
        const placeholder = placeholder_for(tokenizer, match.token);
        data += work.data.slice(from, match.start) + placeholder;
        for (let i = from; i < match.start; i += 1) {
            starts.push(work.starts[i]!);
            ends.push(work.ends[i]!);
        }
        starts.push(...Array.from({length: placeholder.length}, () => match.token.start));
        ends.push(...Array.from({length: placeholder.length}, () => match.token.end));
        from = match.end;
    }
    data += work.data.slice(from);
    for (let i = from; i < work.data.length; i += 1) {
        starts.push(work.starts[i]!);
        ends.push(work.ends[i]!);
    }
    work.data = data;
    work.starts = starts;
    work.ends = ends;
}

function process(
    work: Work,
    tokenizer: Tokenizer,
    pattern_index: number,
    patterns: Pattern[] = PATTERNS,
): Work {
    let index = pattern_index;
    while (index < patterns.length) {
        const found = patterns[index]!(work, tokenizer, index);
        const matches = found === undefined ? [] : Array.isArray(found) ? found : [found];
        if (matches.length === 0) {
            index += 1;
            continue;
        }
        if (matches.length === 1) {
            stash_match(work, tokenizer, matches[0]!);
        } else {
            stash_matches(work, tokenizer, matches);
        }
    }
    return work;
}

// A pattern whose first match is taken, as Python-Markdown's legacy
// `Pattern` does with its `^(.*?)PATTERN(.*)$` wrapper.
function first_match(
    regex: RegExp,
    handle: (m: RegExpExecArray, work: Work, tokenizer: Tokenizer, index: number) => InlineToken,
): Pattern {
    return (work, tokenizer, index) => {
        const m = regex.exec(work.data);
        if (m === null) {
            return undefined;
        }
        return {
            start: m.index,
            end: m.index + m[0].length,
            token: handle(m, work, tokenizer, index),
        };
    };
}

// A pattern that stashes every match in one pass. The same as
// first_match applied until it finds nothing, for a regex whose matches
// cannot overlap and cannot come from what stashing leaves behind
// (none of its characters can be a placeholder's).
function all_matches(
    regex: RegExp,
    handle: (m: RegExpExecArray, work: Work, tokenizer: Tokenizer) => InlineToken,
): Pattern {
    return (work, tokenizer) =>
        [...work.data.matchAll(regex)].map((m) => ({
            start: m.index,
            end: m.index + m[0].length,
            token: handle(m, work, tokenizer),
        }));
}

// A pattern whose handler may reject a match, in which case the next
// non-overlapping match is tried, as Python-Markdown's InlineProcessor
// does with finditer.
function accepted_match(
    regex: RegExp,
    handle: (m: RegExpExecArray, work: Work, tokenizer: Tokenizer) => Match | undefined,
): Pattern {
    return (work, tokenizer) => {
        for (const m of work.data.matchAll(regex)) {
            const match = handle(m, work, tokenizer);
            if (match !== undefined) {
                return match;
            }
        }
        return undefined;
    };
}

function whole(m: RegExpExecArray, work: Work): Span {
    return source_span(work, m.index, m.index + m[0].length);
}

const CONTAINER_REGEXES: Record<ContainerType, RegExp> = {
    strong_em: new RegExp(String.raw`(\*\*\*)(?!\s+)(?<content>[^*^\n]+)(?<!\s)\*\*\*`, "u"),
    strong: new RegExp(String.raw`(\*\*)(?<content>[^\n]+?)\1`, "u"),
    em: new RegExp(String.raw`(\*)(?!\s+)(?<content>[^*^\n]+)(?<!\s)\*`, "u"),
    strike: new RegExp(String.raw`(?<!~)(~~)(?<content>[^~\n]+?)(~~)(?!~)`, "u"),
};

function container(type: ContainerType, delimiter: number): Pattern {
    return first_match(CONTAINER_REGEXES[type], (m, work, tokenizer, index) => {
        const content_start = m.index + delimiter;
        const content_end = content_start + m.groups!["content"]!.length;
        const inner = process(slice_work(work, content_start, content_end), tokenizer, index + 1);
        return {
            type,
            delimiter,
            children: to_tokens(inner, tokenizer),
            ...whole(m, work),
        };
    });
}

// Python-Markdown's LinkInlineProcessor.getText: the text between
// balanced square brackets, starting just after the opening one.
function get_link_text(data: string, index: number): {end: number; handled: boolean} {
    let bracket_count = 1;
    let pos = index;
    for (; pos < data.length; pos += 1) {
        const c = data[pos];
        if (c === "]") {
            bracket_count -= 1;
        } else if (c === "[") {
            bracket_count += 1;
        }
        if (bracket_count === 0) {
            break;
        }
    }
    return {end: pos, handled: bracket_count === 0};
}

// Python-Markdown's LinkInlineProcessor.getLink, in the forms links are
// written in: (url), (<url>), (url "title"), (<url> 'title'), with
// balanced parentheses inside the URL. Anything else is not a link here;
// the text stays text, as it does for an address the server rejects.
function get_link_href(data: string, index: number): {href: string; end: number} | undefined {
    if (data[index] !== "(") {
        return undefined;
    }
    let pos = index + 1;
    while (data[pos] === " ") {
        pos += 1;
    }
    let href = "";
    if (data[pos] === "<") {
        const close = data.indexOf(">", pos);
        if (close === -1) {
            return undefined;
        }
        href = data.slice(pos + 1, close);
        pos = close + 1;
    } else {
        let depth = 0;
        const start = pos;
        while (pos < data.length) {
            const c = data[pos]!;
            // eslint-disable-next-line unicorn/prefer-switch -- a switch's break would not leave the loop
            if (c === "(") {
                depth += 1;
            } else if (c === ")") {
                if (depth === 0) {
                    break;
                }
                depth -= 1;
            } else if (c === " " || c === "\n") {
                break;
            }
            pos += 1;
        }
        href = data.slice(start, pos);
    }
    while (data[pos] === " ") {
        pos += 1;
    }
    const quote = data[pos];
    if (quote === '"' || quote === "'") {
        const close = data.indexOf(quote, pos + 1);
        if (close === -1) {
            return undefined;
        }
        pos = close + 1;
        while (data[pos] === " ") {
            pos += 1;
        }
    }
    if (data[pos] !== ")") {
        return undefined;
    }
    return {href: href.trim(), end: pos + 1};
}

// zerver/lib/markdown sanitize_url, reduced to what decides whether a
// link is made at all.
// The server unescapes entities before it looks at a URL's scheme, so
// "&#106;avascript:" is "javascript:" to it.
function decode_url_entities(url: string): string {
    return url.replaceAll(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (entity, body: string) => {
        const named = new Map([
            ["amp", "&"],
            ["lt", "<"],
            ["gt", ">"],
            ["quot", '"'],
            ["apos", "'"],
        ]).get(body.toLowerCase());
        if (named !== undefined) {
            return named;
        }
        const code =
            body.startsWith("#x") || body.startsWith("#X")
                ? Number.parseInt(body.slice(2), 16)
                : Number.parseInt(body.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    });
}

export function is_allowed_url(url: string): boolean {
    const scheme = /^([A-Za-z][\d+.A-Za-z-]*):/u.exec(decode_url_entities(url).trim());
    return scheme === null || ALLOWED_SCHEMES.has(scheme[1]!.toLowerCase());
}

// A link address as the editor keeps it, or undefined for one the
// server would refuse or that Markdown cannot hold: whitespace and
// parentheses are percent-encoded, a bare address is left as it is.
export function sanitize_href(href: string): string | undefined {
    const trimmed = href.trim();
    // eslint-disable-next-line no-control-regex -- control characters are what this matches
    if (trimmed === "" || !is_allowed_url(trimmed) || /[\u0000-\u001F<>]/u.test(trimmed)) {
        return undefined;
    }
    return trimmed.replaceAll(/[\s()]/gu, (char) => {
        switch (char) {
            case "(":
                return "%28";
            case ")":
                return "%29";
            default:
                return encodeURIComponent(char);
        }
    });
}

function link_like(image: boolean): Pattern {
    const regex = image ? /!\[/gu : /(?<!!)\[/gu;
    return accepted_match(regex, (m, work, tokenizer) => {
        const text_start = m.index + m[0].length;
        const text = get_link_text(work.data, text_start);
        if (!text.handled) {
            return undefined;
        }
        const link = get_link_href(work.data, text.end + 1);
        if (link === undefined || !is_allowed_url(link.href)) {
            return undefined;
        }
        const span = source_span(work, m.index, link.end);
        if (image) {
            // The server only renders images of uploaded files.
            if (!link.href.startsWith("/user_uploads/")) {
                return undefined;
            }
            return {
                start: m.index,
                end: link.end,
                token: {
                    type: "image",
                    alt: work.data.slice(text_start, text.end),
                    src: link.href,
                    ...span,
                },
            };
        }
        return {
            start: m.index,
            end: link.end,
            token: {
                type: "link",
                href: link.href,
                text: source_span(work, text_start, text.end),
                // Zulip makes link text atomic: no formatting inside.
                // Entities in it still reach the browser, which shows
                // them as their characters.
                children: to_tokens(
                    process(slice_work(work, text_start, text.end), tokenizer, 0, [ENTITY_PATTERN]),
                    tokenizer,
                ),
                ...span,
            },
        };
    });
}

function mention_pattern(group: boolean): Pattern {
    const regex = group
        ? new RegExp(String.raw`${BEFORE_MENTION}@(?<silent>_?)\*(?<match>[^*]+)\*`, "gu")
        : new RegExp(String.raw`${BEFORE_MENTION}@(?<silent>_?)\*\*(?<match>[^*]+)\*\*`, "gu");
    return accepted_match(regex, (m, work, tokenizer) => {
        const name = m.groups!["match"]!;
        const valid = group
            ? tokenizer.ctx.is_group_mention(name)
            : tokenizer.ctx.is_user_mention(name);
        if (!valid) {
            return undefined;
        }
        return {
            start: m.index,
            end: m.index + m[0].length,
            token: {
                type: group ? "group_mention" : "mention",
                silent: m.groups!["silent"] === "_",
                name,
                ...whole(m, work),
            },
        };
    });
}

function stream_pattern(kind: "message" | "topic" | "stream"): Pattern {
    const body = {
        message: String.raw`(?<stream_name>[^*>]+)>(?<topic_name>[^*]*)@(?<message_id>\d+)`,
        topic: String.raw`(?<stream_name>[^*>]+)>(?<topic_name>[^*]*)`,
        stream: String.raw`(?<stream_name>[^*]+)`,
    }[kind];
    const regex = new RegExp(String.raw`${BEFORE_LINK_PRODUCING_MENTION}#\*\*${body}\*\*`, "gu");
    return accepted_match(regex, (m, work, tokenizer) => {
        const stream_name = m.groups!["stream_name"]!;
        if (!tokenizer.ctx.is_stream(stream_name)) {
            return undefined;
        }
        return {
            start: m.index,
            end: m.index + m[0].length,
            token: {
                type: "stream",
                stream_name,
                topic: m.groups!["topic_name"],
                message_id: m.groups!["message_id"],
                ...whole(m, work),
            },
        };
    });
}

// The server's web link regex, reduced: a scheme URL, or a dotted
// domain name, or an e-mail address, starting after whitespace or an
// opening delimiter and ending before whitespace, allowing trailing
// punctuation that is not part of the URL. Its only use here is to
// keep what the server would linkify from being read as formatting.
const AUTOLINK_RE = new RegExp(
    String.raw`(?<![^\s'"(,:<\x80-\u{10FFFF}])(?:(?:(?:https?|hansoft|obsidian|zotero|asanadesktop)://[\p{L}\p{N}_.:@-]+?|(?:[\p{L}\p{N}_-]+\.)+[A-Za-z]{2,})(?:/(?:[^\s()"]|\([^\s()"]*\))*?|\?(?![)"\s]|$)(?:[^\s()"]|\([^\s()"]*\))*?)?|[\p{L}\p{N}_.-]+@[\p{L}\p{N}_.-]+\.[\p{L}\p{N}_]+)(?=[!:;?),.'">]*(?:$|\s))`,
    "u",
);

const ENTITY_PATTERN: Pattern = all_matches(
    /&(?:#\d+|#x[\dA-Fa-f]+|[\dA-Za-z]+);/gu,
    (m, work) => ({
        type: "entity",
        ...whole(m, work),
    }),
);

const PATTERNS: Pattern[] = [
    // backtick, 105
    accepted_match(
        new RegExp(
            String.raw`(?:(?<!\\)((?:\\{2})+)(?=\x60+)|(?<!\\)(\x60+)([\s\S]+?)(?<!\x60)\2(?!\x60))`,
            "gu",
        ),
        (m, work) => {
            const token: InlineToken =
                m[3] === undefined
                    ? {type: "literal", ...whole(m, work)}
                    : {type: "code", ticks: m[2]!.length, ...whole(m, work)};
            return {start: m.index, end: m.index + m[0].length, token};
        },
    ),
    // strong_em, 100
    container("strong_em", 3),
    // usermention, 95
    mention_pattern(false),
    // tex, 90
    first_match(
        new RegExp(
            String.raw`(?<!${WORD})(?<!\$)\$\$(?<body>[^\n_$](?:\\\$|[^$\n])*)\$\$(?!\$)(?!${WORD})`,
            "u",
        ),
        (m, work) => ({type: "tex", body: m.groups!["body"]!, ...whole(m, work)}),
    ),
    // stream_topic_message 89, topic 87, stream 85
    stream_pattern("message"),
    stream_pattern("topic"),
    stream_pattern("stream"),
    // timestamp, 75
    first_match(/<time:(?<time>[^>]*?)>/u, (m, work) => ({
        type: "time",
        time: m.groups!["time"]!,
        ...whole(m, work),
    })),
    // usergroupmention, 65
    mention_pattern(true),
    // link 60, image 57 (the audio processor passes non-audio on to it)
    link_like(false),
    link_like(true),
    // autolink, 55
    first_match(AUTOLINK_RE, (m, work, tokenizer) => ({
        type: "autolink",
        children: to_tokens(slice_work(work, m.index, m.index + m[0].length), tokenizer),
        ...whole(m, work),
    })),
    // entity, 40
    ENTITY_PATTERN,
    // strong 35, emphasis 30, del 25
    container("strong", 2),
    container("em", 1),
    container("strike", 2),
    // not_strong, 20
    all_matches(/(?:^|(?<=\s))(?:\*{1,3}|_{1,3})(?=\s|$)/gu, (m, work) => ({
        type: "literal",
        ...whole(m, work),
    })),
    // emoji, 15: an unknown name is kept as text, but stashed.
    all_matches(new RegExp(String.raw`:[\p{L}\p{N}_+\-]+:`, "gu"), (m, work, tokenizer) => {
        const name = m[0].slice(1, -1);
        return tokenizer.ctx.is_emoji(name)
            ? {type: "emoji", name, ...whole(m, work)}
            : {type: "literal", ...whole(m, work)};
    }),
    // nl2br, 5
    all_matches(/\n/gu, (m, work) => ({type: "br", ...whole(m, work)})),
];

export function tokenize(text: string, ctx: InlineContext = permissive_context): InlineToken[] {
    const tokenizer: Tokenizer = {ctx, stash: []};
    // Offsets are UTF-16 code unit offsets, like String indexes.
    const work: Work = {
        // Text that happens to hold the placeholder's own characters
        // must not be taken for a placeholder; the tokens keep their
        // offsets into the text as given.
        // eslint-disable-next-line no-control-regex -- the placeholder delimiters are control characters
        data: text.replaceAll(/[\u0002\u0003]/gu, "\uFFFD"),
        starts: Array.from({length: text.length}, (_, i) => i),
        ends: Array.from({length: text.length}, (_, i) => i + 1),
    };
    return to_tokens(process(work, tokenizer, 0), tokenizer);
}
