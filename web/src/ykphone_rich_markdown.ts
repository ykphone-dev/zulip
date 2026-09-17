// Markdown ⇄ document conversion for the 옆커폰 rich composer.
//
// parse_markdown turns the compose box's Markdown into an editor
// document; serialize_markdown turns the document back into Markdown,
// along with anchors between document positions and Markdown offsets
// (which keep the hidden textarea's selection where the editor's is).
//
// The one invariant everything else relies on:
//
//     serialize_markdown(parse_markdown(md)).markdown === md
//
// for every string md. The editor shows as formatting what it can and
// keeps everything else as chips holding their exact Markdown; parsing
// checks each block and each line by writing it back, and falls back to
// a chip where the round trip would not be exact.
//
// In the other direction, text the user wrote literally must not be
// read as syntax by the server. Literal characters that would be are
// written as numeric HTML entities (`&#42;`), which the server renders
// as the character (it has no backslash escapes). Only characters that
// would really be misread are escaped: the serialiser tokenizes what it
// wrote with Zulip's grammar (ykphone_rich_inline.ts) and escapes until
// it reads back as the document.
//
// The block grammar modelled is Zulip's (zerver/lib/markdown): fenced
// blocks (```quote, ```spoiler, ```math and code) recognised anywhere,
// quote and spoiler contents parsed again; lists with two-space nesting
// and lazy continuation lines; "> " quotes, headings and rules that
// split paragraphs; tables and indented code at the start of a block;
// "/poll" and "/todo" widgets.

import type {Mark, Node as PMNode} from "prosemirror-model";

import {
    type InlineContext,
    type InlineToken,
    permissive_context,
    tokenize,
} from "./ykphone_rich_inline.ts";
import {number_attr, schema, string_attr} from "./ykphone_rich_schema.ts";

export type MarkdownContext = InlineContext & {
    // The link texts of the compose box's call buttons ("Join video
    // call."), so that call links become call chips.
    video_call_label: string;
    audio_call_label: string;
};

export const default_context: MarkdownContext = {
    ...permissive_context,
    video_call_label: "Join video call.",
    audio_call_label: "Join voice call.",
};

// A document position and the Markdown offset that corresponds to it;
// see pos_to_offset and offset_to_pos. `text` marks positions inside a
// textblock, where a cursor can be.
export type Anchor = {pos: number; off: number; text?: true};

export type SerializeResult = {
    markdown: string;
    anchors: Anchor[];
    // Set when some formatting could not be written so that it reads
    // back the same (a link whose text holds a backtick, say).
    lossy: boolean;
};

// zerver/lib/markdown/fenced_code.py FENCE_RE.
export const FENCE_RE =
    /^(?<fence>~{3,}|\u0060{3,})[ ]*(?:\{?\.?(?<lang>[\w+\-./#]+)[ ]*(?<header>[^ ~\u0060][^~\u0060]*)?\}?)?$/u;
// Python-Markdown's HRProcessor.
const HR_RE = /^[ ]{0,3}(?:(?:-+[ ]{0,2}){3,}|(?:_+[ ]{0,2}){3,}|(?:\*+[ ]{0,2}){3,})[ ]*$/u;
const HEADING_RE = /^(?<hashes>#{1,6}) (?<content>.*)$/u;
const HEADING_TRIGGER_RE = /^#{1,6}(?:\s|$)/u;
const QUOTE_TRIGGER_RE = /^[ ]{0,3}>/u;
// A list item as the list processors see it at the start of a block:
// at most one space of indentation.
const LIST_START_RE = /^[ ]?(?:[*+-]|\d+\.)[ ]+/u;
// MarkdownListPreprocessor.LI_RE: an item right after a line of text
// starts a list too (only with a single-digit number).
const LI_RE = /^[ ]*(?:[*+-]|\d\.)[ ]+/u;
const ITEM_RE = /^(?<indent>[ ]*)(?<marker>[*+-]|\d+\.)(?<space>[ ]+)(?<content>.*)$/u;
const LIST_TRIGGER_RE = /^[ ]*(?:[*+-]|\d+(?<dot>\.))[ ]+/u;
const WIDGET_RE = /^\/(?:poll|todo)(?:\s|$)/u;
const TABLE_SEPARATOR_RE = /^[ |:-]*-[ |:-]*$/u;
const INDENTED_CODE_RE = /^(?: {4}|\t)/u;

type BlockKind =
    | "paragraph"
    | "list"
    | "angle_quote"
    | "fence"
    | "heading"
    | "hr"
    | "table"
    | "indented_code"
    | "widget";

function is_blank(line: string): boolean {
    return /^[\t ]*$/u.test(line);
}

// ---- Entities ----

const NAMED_ENTITIES = new Map([
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", '"'],
    ["apos", "'"],
    ["nbsp", "\u00A0"],
]);

export function decode_entity(raw: string): string {
    const body = raw.slice(1, -1);
    let code: number;
    if (/^#x/iu.test(body)) {
        code = Number.parseInt(body.slice(2), 16);
    } else if (body.startsWith("#")) {
        code = Number.parseInt(body.slice(1), 10);
    } else {
        return NAMED_ENTITIES.get(body) ?? raw;
    }
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw;
}

export function encode_entity(char: string): string {
    return `&#${char.codePointAt(0)!};`;
}

// ---- Inline: tokens to nodes ----

function add_marks(marks: readonly Mark[], ...added: Mark[]): readonly Mark[] {
    let result = marks;
    for (const mark of added) {
        result = mark.addToSet(result);
    }
    return result;
}

function inline_atom(type: string, attrs: Record<string, unknown>, marks: readonly Mark[]): PMNode {
    return schema.node(type, attrs, undefined, marks);
}

function build_inline(
    tokens: InlineToken[],
    source: string,
    ctx: MarkdownContext,
    marks: readonly Mark[] = [],
): PMNode[] {
    const nodes: PMNode[] = [];
    for (const token of tokens) {
        const raw = source.slice(token.start, token.end);
        switch (token.type) {
            case "text":
            case "literal":
                nodes.push(schema.text(raw, marks));
                break;
            case "autolink":
                nodes.push(...build_inline(token.children, source, ctx, marks));
                break;
            case "br":
                nodes.push(schema.node("hard_break"));
                break;
            case "code":
                nodes.push(
                    schema.text(
                        raw.slice(token.ticks, -token.ticks),
                        add_marks(marks, schema.marks.code.create({ticks: token.ticks})),
                    ),
                );
                break;
            case "strong":
            case "em":
            case "strike":
                nodes.push(
                    ...build_inline(
                        token.children,
                        source,
                        ctx,
                        add_marks(marks, schema.marks[token.type].create()),
                    ),
                );
                break;
            case "strong_em":
                nodes.push(
                    ...build_inline(
                        token.children,
                        source,
                        ctx,
                        add_marks(marks, schema.marks.strong.create(), schema.marks.em.create()),
                    ),
                );
                break;
            case "mention":
            case "group_mention":
                nodes.push(
                    inline_atom(
                        "mention",
                        {
                            raw,
                            kind: token.type === "mention" ? "user" : "group",
                            silent: token.silent,
                            name: token.name,
                        },
                        marks,
                    ),
                );
                break;
            case "stream":
                nodes.push(
                    inline_atom(
                        "channel_link",
                        {
                            raw,
                            stream_name: token.stream_name,
                            topic: token.topic ?? null,
                            message_id: token.message_id ?? null,
                        },
                        marks,
                    ),
                );
                break;
            case "tex":
                nodes.push(schema.text(token.body, add_marks(marks, schema.marks.math.create())));
                break;
            case "time":
                nodes.push(inline_atom("time", {raw, time: token.time}, marks));
                break;
            case "image":
                nodes.push(
                    inline_atom(
                        "upload",
                        {raw, name: token.alt, url: token.src, embedded: true},
                        marks,
                    ),
                );
                break;
            case "entity":
                nodes.push(inline_atom("escape", {raw, char: decode_entity(raw)}, marks));
                break;
            case "emoji":
                nodes.push(inline_atom("emoji", {raw, name: token.name}, marks));
                break;
            case "link":
                nodes.push(...build_link(token, raw, source, ctx, marks));
                break;
        }
    }
    return nodes;
}

function build_link(
    token: Extract<InlineToken, {type: "link"}>,
    raw: string,
    source: string,
    ctx: MarkdownContext,
    marks: readonly Mark[],
): PMNode[] {
    const text = source.slice(token.text.start, token.text.end);
    if (token.href === "" || token.href.startsWith("/user_uploads/")) {
        // An uploaded file, or the "[Uploading …]()" placeholder before it.
        return [inline_atom("upload", {raw, name: text, url: token.href, embedded: false}, marks)];
    }
    if (text === ctx.video_call_label || text === ctx.audio_call_label) {
        return [
            inline_atom(
                "call_link",
                {
                    raw,
                    kind: text === ctx.video_call_label ? "video" : "audio",
                    label: text,
                    url: token.href,
                },
                marks,
            ),
        ];
    }
    // Link text is text, with entities standing for characters that
    // would otherwise be syntax ("[a&#93;b](…)").
    const plain = token.children.every((child) => child.type === "text" || child.type === "entity");
    if (!plain || text.trim() === "" || text.includes("\n")) {
        return [inline_atom("opaque_inline", {raw}, marks)];
    }
    const link = schema.marks.link.create({href: token.href});
    return build_inline(token.children, source, ctx, add_marks(marks, link));
}

// ---- Inline: nodes to Markdown ----

// Marks in the order they nest when written: strong outermost, and
// link, code or math innermost (Zulip formats nothing inside those).
const MARK_ORDER = ["strong", "em", "strike", "link", "code", "math"];
// Marks whose text the server takes as it is, entities included.
const VERBATIM_MARKS = new Set(["code", "math"]);
// Chips are written outside any formatting: a mention pill is not bold,
// and "**@**Iago** please**" would not be a mention to the server.
const CHIP_TYPES = new Set([
    "mention",
    "channel_link",
    "emoji",
    "time",
    "upload",
    "call_link",
    "opaque_inline",
]);
// zerver/lib/mention.py: what may come right before a mention or a
// channel link for the server to read it.
const BEFORE_MENTION_RE = /[\s'"({[/<]$/u;
const BEFORE_CHANNEL_RE = /[\s'"({/<]$/u;
// Control characters the server would not show; written as entities.
// eslint-disable-next-line no-control-regex -- control characters are what this matches
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/u;
// Rounds of escaping before every special character is escaped.
const MAX_ESCAPE_ROUNDS = 8;

// Zulip's Markdown cannot express every combination of formatting (its
// `**` and `*` delimiters pair up greedily), so a line is written in the
// first of these ways that reads back as the document. The first keeps
// the Markdown a parsed line came from; the others move whitespace at
// the edges of formatting outside it, which looks the same, and nest
// the marks in another order.
type WriteStrategy = {expel: string[]; order: string[]};
const WRITE_STRATEGIES: WriteStrategy[] = [
    // Zulip's EMPHASIS_RE allows no whitespace just inside `*`.
    {expel: ["em"], order: MARK_ORDER},
    {expel: ["link", "strike", "em", "strong"], order: MARK_ORDER},
    {expel: ["em"], order: ["em", "strong", "strike", "link", "code", "math"]},
    {
        expel: ["link", "strike", "em", "strong"],
        order: ["em", "strong", "strike", "link", "code", "math"],
    },
    {
        expel: ["link", "strike", "em", "strong"],
        order: ["strike", "strong", "em", "link", "code", "math"],
    },
];
// What the last-resort escaping pass escapes.
const SPECIAL_CHARS = new Set("*~\u0060$@#<[]!&:_>|\\");

function sorted_marks(marks: readonly Mark[], order = MARK_ORDER): Mark[] {
    return marks.toSorted((a, b) => order.indexOf(a.type.name) - order.indexOf(b.type.name));
}

// Moves whitespace at the edges of runs of the given marks outside them.
// A chip is never in a run, since it is written without marks.
function expel_whitespace(items: PMNode[], mark_names: string[]): PMNode[] {
    let result = items;
    for (const name of mark_names) {
        const type = schema.marks[name]!;
        const in_run = (node: PMNode): boolean =>
            !CHIP_TYPES.has(node.type.name) && type.isInSet(node.marks) !== undefined;
        const next: PMNode[] = [];
        for (const [i, node] of result.entries()) {
            if (!node.isText || type.isInSet(node.marks) === undefined) {
                next.push(node);
                continue;
            }
            const text = node.text!;
            const starts_run = i === 0 || !in_run(result[i - 1]!);
            const ends_run = i === result.length - 1 || !in_run(result[i + 1]!);
            const lead = starts_run ? /^\s*/u.exec(text)![0].length : 0;
            const trail = ends_run && lead < text.length ? /\s*$/u.exec(text)![0].length : 0;
            const without = type.removeFromSet(node.marks);
            if (lead > 0) {
                next.push(schema.text(text.slice(0, lead), without));
            }
            if (lead < text.length - trail) {
                next.push(node.cut(lead, text.length - trail));
            }
            if (trail > 0) {
                next.push(schema.text(text.slice(text.length - trail), without));
            }
        }
        result = next;
    }
    return result;
}

function backtick_fence(text: string, ticks: number | null): string {
    const runs = new Set((text.match(/\u0060+/gu) ?? []).map((run) => run.length));
    if (ticks !== null && !runs.has(ticks)) {
        return "\u0060".repeat(ticks);
    }
    let count = 1;
    while (runs.has(count)) {
        count += 1;
    }
    return "\u0060".repeat(count);
}

function mark_delimiters(mark: Mark): [string, string] {
    switch (mark.type.name) {
        case "strong":
            return ["**", "**"];
        case "em":
            return ["*", "*"];
        case "strike":
            return ["~~", "~~"];
        case "link":
            return ["[", `](${String(mark.attrs["href"])})`];
        case "math":
            return ["$$", "$$"];
        default:
            // Code spans are written together with their text.
            return ["", ""];
    }
}

type LineOutput = {
    text: string;
    // Where each character came from: literal text of item `node` at
    // UTF-16 index `index`, or (undefined) syntax the serialiser wrote.
    provenance: ({node: number; index: number} | undefined)[];
    // For each item, the offsets where its content starts and ends.
    boundaries: {before: number; after: number}[];
    // For text items with escaped characters, [index, offset] pairs
    // around every escaped character.
    unit_offsets: Map<number, [number, number][]>;
    // Items (mention and channel chips) written with a space before
    // them, which the server needs there to read the chip.
    spaced: Set<number>;
    // Something was written that cannot read back as it is: a chip
    // holding a link.
    lossy: boolean;
    // A chip was written right against a formatting delimiter
    // ("@**Iago**** please**"), which the server reads but nobody
    // wants to; another way of writing the line is preferred.
    ugly: boolean;
};

function chip_before_re(node: PMNode): RegExp | undefined {
    switch (node.type.name) {
        case "mention":
            return BEFORE_MENTION_RE;
        case "channel_link":
            return BEFORE_CHANNEL_RE;
        default:
            return undefined;
    }
}

// The marks a node is written with: chips take none (see CHIP_TYPES).
function written_marks(node: PMNode, order: string[]): Mark[] {
    return CHIP_TYPES.has(node.type.name) ? [] : sorted_marks(node.marks, order);
}

function write_line(items: PMNode[], escapes: Set<string>, order: string[]): LineOutput {
    let text = "";
    const provenance: LineOutput["provenance"] = [];
    const boundaries: LineOutput["boundaries"] = [];
    const unit_offsets: LineOutput["unit_offsets"] = new Map();
    const spaced = new Set<number>();
    let lossy = false;
    let ugly = false;
    const active: Mark[] = [];
    const emit = (syntax: string): void => {
        text += syntax;
        provenance.push(...Array.from({length: syntax.length}, () => undefined));
    };
    for (const [index, node] of items.entries()) {
        const marks = written_marks(node, order);
        let common = 0;
        while (
            common < active.length &&
            common < marks.length &&
            active[common]!.eq(marks[common]!) &&
            active[common]!.type.name !== "code"
        ) {
            common += 1;
        }
        const chip = CHIP_TYPES.has(node.type.name);
        const previous_chip = index > 0 && CHIP_TYPES.has(items[index - 1]!.type.name);
        while (active.length > common) {
            emit(mark_delimiters(active.pop()!)[1]);
            ugly ||= chip;
        }
        for (const mark of marks.slice(common)) {
            emit(mark_delimiters(mark)[0]);
            ugly ||= previous_chip;
            active.push(mark);
        }
        if (!node.isText) {
            if (chip) {
                lossy ||= node.marks.some((mark) => mark.type.name === "link");
                const before_re = chip_before_re(node);
                if (before_re !== undefined && text !== "" && !before_re.test(text)) {
                    emit(" ");
                    spaced.add(index);
                }
            }
            const before = text.length;
            emit(String(node.attrs["raw"]));
            boundaries.push({before, after: text.length});
            continue;
        }
        const value = node.text!;
        const code = marks.find((mark) => mark.type.name === "code");
        const fence =
            code === undefined ? "" : backtick_fence(value, number_attr(code.attrs, "ticks"));
        emit(fence);
        const before = text.length;
        const offsets: [number, number][] = [];
        // eslint-disable-next-line unicorn/no-for-loop -- offsets are UTF-16 units, as the anchors count
        for (let unit = 0; unit < value.length; unit += 1) {
            const char = value[unit]!;
            if (escapes.has(`${index}:${unit}`) || (code === undefined && CONTROL_RE.test(char))) {
                offsets.push([unit, text.length]);
                emit(encode_entity(char));
                offsets.push([unit + 1, text.length]);
            } else {
                text += char;
                provenance.push({node: index, index: unit});
            }
        }
        boundaries.push({before, after: text.length});
        emit(fence);
        if (offsets.length > 0) {
            unit_offsets.set(index, offsets);
        }
    }
    while (active.length > 0) {
        emit(mark_delimiters(active.pop()!)[1]);
    }
    return {text, provenance, boundaries, unit_offsets, spaced, lossy, ugly};
}

type Unit = string;

function marks_key(marks: readonly Mark[]): string {
    return sorted_marks(marks)
        .map((mark) =>
            mark.type.name === "link" ? `link(${String(mark.attrs["href"])})` : mark.type.name,
        )
        .join(",");
}

// What a line of inline content looks like to the reader: characters
// and chips with their formatting. Chips carry no formatting (see
// CHIP_TYPES), and an opaque chip reads as the Markdown it holds.
function to_units(nodes: readonly PMNode[], ctx: MarkdownContext, expand_opaque = true): Unit[] {
    const units: Unit[] = [];
    for (const node of nodes) {
        const marks = marks_key(node.marks);
        if (node.isText) {
            for (const char of node.text!) {
                units.push(`${marks}|c|${char}`);
            }
        } else if (node.type.name === "escape") {
            units.push(`${marks}|c|${String(node.attrs["char"])}`);
        } else if (node.type.name === "opaque_inline" && expand_opaque) {
            // Once: what the Markdown holds may be a chip again (a link
            // whose text is not plain text).
            const raw = String(node.attrs["raw"]);
            units.push(...to_units(build_inline(tokenize(raw, ctx), raw, ctx), ctx, false));
        } else {
            units.push(`|${node.type.name}|${String(node.attrs["raw"])}`);
        }
    }
    return units;
}

// The source offsets of a token's syntax to escape so that the server
// does not read the token: its opening delimiter, which is the least
// that does it, or with `closing` the first character of its closing
// delimiter too, which leaves nothing that pairs up again with the
// delimiters of the tokens around it (the closing backticks of code
// spans on a hundred pasted lines would otherwise pair up line by line,
// round after round).
function trigger_offsets(token: InlineToken, closing: boolean): number[] {
    switch (token.type) {
        case "text":
        case "literal":
        case "br":
        case "autolink":
            return [];
        case "strong":
        case "em":
        case "strike":
        case "strong_em": {
            const {start, end, delimiter} = token;
            const opening = Array.from({length: delimiter}, (_, i) => start + i);
            return closing ? [...opening, end - delimiter] : opening;
        }
        case "code":
            return closing ? [token.start, token.end - 1] : [token.start];
        // A math span or a link cannot be made anew from what escaping
        // its opening leaves behind.
        case "tex":
        case "link":
            return [token.start];
        default:
            return [token.start];
    }
}

// The offset of a character that makes a line start a block — a fence,
// heading, quote, rule, list item, table or indented code — or
// undefined. `previous` is the written line before this one, if any.
function line_trigger(
    line: string,
    block_start: boolean,
    previous: string | undefined,
): number | undefined {
    if (FENCE_RE.test(line) || HEADING_TRIGGER_RE.test(line)) {
        return 0;
    }
    const first = line.search(/\S/u);
    if (HR_RE.test(line) || QUOTE_TRIGGER_RE.test(line)) {
        return first;
    }
    // A table: a line with a pipe, then a separator line.
    if (previous?.includes("|") === true && TABLE_SEPARATOR_RE.test(line) && line.includes("-")) {
        return line.indexOf("-");
    }
    // A list starts at the start of a block, or right after a line of
    // text with a single-digit number (MarkdownListPreprocessor).
    const item = LIST_TRIGGER_RE.exec(line);
    const starts_list = block_start
        ? LIST_START_RE.test(line)
        : LI_RE.test(line) && LIST_START_RE.test(line);
    if (item !== null && starts_list) {
        return item.groups!["dot"] === undefined ? first : line.indexOf(".", first);
    }
    if (block_start && INDENTED_CODE_RE.test(line)) {
        return 0;
    }
    return undefined;
}

// `indent` is written after a hard break the editor made (one from
// Markdown remembers its own); inside a list item it is the item's.
type LineOptions = {block_start: boolean; line_triggers: boolean; indent?: string};

// A line of inline content: its nodes, and the indentation written
// before it (the continuation lines of a list item have some).
type SourceLine = {nodes: PMNode[]; indent: string};

type WrittenLine = {output: LineOutput; items: PMNode[]};
type WrittenGroup = {lines: WrittenLine[]; lossy: boolean; ugly: boolean};

function is_blank_line(nodes: PMNode[]): boolean {
    return nodes.every((node) => node.isText && is_blank(node.text!));
}

// Writes consecutive non-blank lines, which the server reads together as
// one paragraph (a code span or a mention can run across a line break).
function serialize_group(
    lines: SourceLine[],
    ctx: MarkdownContext,
    options: LineOptions,
): WrittenGroup {
    let first: WrittenGroup | undefined;
    let readable: WrittenGroup | undefined;
    for (const strategy of WRITE_STRATEGIES) {
        const result = write_group_with_strategy(lines, ctx, options, strategy);
        if (!result.lossy && !result.ugly) {
            return result;
        }
        if (!result.lossy) {
            readable ??= result;
        }
        first ??= result;
    }
    return readable ?? first!;
}

// Writes the lines, escaping literal characters until they read back as
// the document; lossy if they never do.
//
// Each round tokenizes what was written once and escapes one delimiter
// of every token that should not be there (a token that is escaped is
// not looked into, since escaping it may dissolve what it held), so the
// rounds are few whatever the text; after MAX_ESCAPE_ROUNDS every
// literal character that could take part in syntax is escaped.
function write_group_with_strategy(
    lines: SourceLine[],
    ctx: MarkdownContext,
    options: LineOptions,
    strategy: WriteStrategy,
): WrittenGroup {
    const items = lines.map((line) => expel_whitespace(line.nodes, strategy.expel));
    const break_units = to_units([schema.nodes.hard_break.create()], ctx);
    // The indentation written after each hard break (none before the
    // first line).
    const line_units = lines.map((line, index) =>
        index === 0 || line.indent === "" ? [] : to_units([schema.text(line.indent)], ctx),
    );
    const escapes = items.map(() => new Set<string>());
    const write = (): LineOutput[] =>
        items.map((line_items, index) => write_line(line_items, escapes[index]!, strategy.order));
    let outputs = write();
    // What the written text should read back as: the items, with the
    // space written before a chip where the server needs one.
    const expected = (): string =>
        items
            .flatMap((line_items, index) => [
                ...(index === 0 ? [] : break_units),
                ...line_units[index]!,
                ...line_items.flatMap((item, item_index) => [
                    ...(outputs[index]!.spaced.has(item_index) ? ["|c| "] : []),
                    ...to_units([item], ctx),
                ]),
            ])
            .join("\n");
    // The lines joined as they will be written, and where each starts.
    const join = (): {text: string; starts: number[]} => {
        let text = "";
        const starts: number[] = [];
        for (const [index, output] of outputs.entries()) {
            if (index > 0) {
                text += "\n" + lines[index]!.indent;
            }
            starts.push(text.length);
            text += output.text;
        }
        return {text, starts};
    };
    const try_escape = (line: number, offset: number): boolean => {
        const origin = outputs[line]!.provenance[offset];
        if (origin === undefined) {
            return false;
        }
        const node = items[line]![origin.node]!;
        const key = `${origin.node}:${origin.index}`;
        if (
            node.marks.some((mark) => VERBATIM_MARKS.has(mark.type.name)) ||
            escapes[line]!.has(key)
        ) {
            return false;
        }
        escapes[line]!.add(key);
        return true;
    };
    // Escapes the first special character at or after `offset` on the
    // line that is literal text (a block's trigger may be syntax the
    // serialiser wrote, as the "**" of a bold "*" is).
    const try_escape_from = (line: number, offset: number): boolean => {
        const text = outputs[line]!.text;
        for (let at = offset; at < text.length; at += 1) {
            if ((at === offset || SPECIAL_CHARS.has(text[at]!)) && try_escape(line, at)) {
                return true;
            }
        }
        return false;
    };
    const try_escape_joined = (starts: number[], offset: number): boolean => {
        let line = starts.length - 1;
        while (line > 0 && starts[line]! > offset) {
            line -= 1;
        }
        return try_escape(line, offset - starts[line]!);
    };
    const escape_tokens = (tokens: InlineToken[], starts: number[], closing: boolean): boolean => {
        let escaped = false;
        for (const token of tokens) {
            let here = false;
            for (const offset of trigger_offsets(token, closing)) {
                here = try_escape_joined(starts, offset) || here;
            }
            escaped ||= here;
            if (!here && "children" in token) {
                escaped = escape_tokens(token.children, starts, closing) || escaped;
            }
        }
        return escaped;
    };
    const finish = (lossy: boolean): WrittenGroup => ({
        lines: outputs.map((output, index) => ({output, items: items[index]!})),
        lossy: lossy || outputs.some((output) => output.lossy),
        ugly: outputs.some((output) => output.ugly),
    });
    let rounds = 0;
    let used_fallback = false;
    for (;;) {
        let block_escaped = false;
        if (options.line_triggers) {
            for (const [index, output] of outputs.entries()) {
                const trigger = line_trigger(
                    output.text,
                    index === 0 && options.block_start,
                    index === 0 ? undefined : outputs[index - 1]!.text,
                );
                if (trigger !== undefined && try_escape_from(index, trigger)) {
                    block_escaped = true;
                }
            }
        }
        if (block_escaped) {
            outputs = write();
            continue;
        }
        const {text, starts} = join();
        const tokens = tokenize(text, ctx);
        if (to_units(build_inline(tokens, text, ctx), ctx).join("\n") === expected()) {
            return finish(false);
        }
        rounds += 1;
        // The first rounds escape the least; after them, whole delimiters.
        let escaped = rounds <= MAX_ESCAPE_ROUNDS && escape_tokens(tokens, starts, rounds > 2);
        if (!escaped && !used_fallback) {
            // Our own syntax did not read back as intended; escape every
            // literal character that could take part in syntax.
            used_fallback = true;
            // eslint-disable-next-line unicorn/no-for-loop -- offsets are UTF-16 units, as the anchors count
            for (let offset = 0; offset < text.length; offset += 1) {
                if (SPECIAL_CHARS.has(text[offset]!)) {
                    escaped = try_escape_joined(starts, offset) || escaped;
                }
            }
        }
        if (!escaped) {
            return finish(true);
        }
        outputs = write();
    }
}

type InlineLines = {text: string; anchors: Anchor[]; lossy: boolean};

// Writes inline content (with hard breaks) as lines of Markdown, each
// hard break followed by its indentation. Anchors are relative to the
// content's first position (pos 0) and first character (off 0).
function serialize_inline_lines(
    nodes: readonly PMNode[],
    ctx: MarkdownContext,
    options: LineOptions,
): InlineLines {
    const lines: SourceLine[] = [{nodes: [], indent: ""}];
    for (const node of nodes) {
        if (node.type.name === "hard_break") {
            lines.push({
                nodes: [],
                indent: string_attr(node.attrs, "indent") ?? options.indent ?? "",
            });
        } else {
            lines.at(-1)!.nodes.push(node);
        }
    }
    // Written lines, in order: blank lines as they are, the others by the
    // group of non-blank lines they belong to.
    const written: WrittenLine[] = [];
    let lossy = false;
    let group: SourceLine[] = [];
    let group_block_start = options.block_start;
    const flush = (): void => {
        if (group.length > 0) {
            const result = serialize_group(group, ctx, {
                block_start: group_block_start,
                line_triggers: options.line_triggers,
            });
            lossy ||= result.lossy;
            written.push(...result.lines);
            group = [];
        }
    };
    for (const line of lines) {
        if (is_blank_line(line.nodes)) {
            flush();
            const text = line.nodes.map((node) => node.text!).join("");
            const boundaries: {before: number; after: number}[] = [];
            let end = 0;
            for (const node of line.nodes) {
                boundaries.push({before: end, after: end + node.text!.length});
                end += node.text!.length;
            }
            written.push({
                output: {
                    text,
                    provenance: [],
                    boundaries,
                    unit_offsets: new Map(),
                    spaced: new Set(),
                    lossy: false,
                    ugly: false,
                },
                items: line.nodes,
            });
            group_block_start = true;
        } else {
            if (group.length === 0 && written.length > 0) {
                group_block_start = is_blank(written.at(-1)!.output.text);
            }
            group.push(line);
        }
    }
    flush();

    let text = "";
    const anchors: Anchor[] = [];
    let pos = 0;
    for (const [index, line] of written.entries()) {
        if (index > 0) {
            text += "\n" + lines[index]!.indent;
            // The hard break before this line.
            pos += 1;
        }
        const base = text.length;
        anchors.push({pos, off: base, text: true});
        // Expelling whitespace only splits text nodes, so the items'
        // sizes still add up to the line's positions.
        let item_pos = pos;
        for (const [item_index, item] of line.items.entries()) {
            const boundary = line.output.boundaries[item_index]!;
            anchors.push({pos: item_pos, off: base + boundary.before, text: true});
            for (const [unit, offset] of line.output.unit_offsets.get(item_index) ?? []) {
                anchors.push({pos: item_pos + unit, off: base + offset, text: true});
            }
            item_pos += item.nodeSize;
            anchors.push({pos: item_pos, off: base + boundary.after, text: true});
        }
        pos = item_pos;
        text += line.output.text;
        anchors.push({pos, off: text.length, text: true});
    }
    return {text, anchors, lossy};
}

export function serialize_inline(
    nodes: readonly PMNode[],
    ctx: MarkdownContext = default_context,
): string {
    return serialize_inline_lines(nodes, ctx, {block_start: false, line_triggers: false}).text;
}

// ---- Blocks: Markdown to nodes ----

type ParsedBlock = {node: PMNode; first: number; last: number};

function inline_nodes_for_lines(lines: string[], ctx: MarkdownContext): PMNode[] {
    // The server tokenizes each paragraph on its own, and blank lines
    // separate paragraphs; within one, a newline is a <br> token.
    const nodes: PMNode[] = [];
    let group: string[] = [];
    const flush = (): void => {
        if (group.length > 0) {
            const text = group.join("\n");
            nodes.push(...build_inline(tokenize(text, ctx), text, ctx));
            group = [];
        }
    };
    for (const [index, line] of lines.entries()) {
        if (index > 0 && (is_blank(line) || is_blank(lines[index - 1]!))) {
            flush();
            nodes.push(schema.node("hard_break"));
        }
        if (!is_blank(line)) {
            group.push(line);
        } else if (line !== "") {
            nodes.push(schema.text(line));
        }
    }
    flush();
    return nodes;
}

// Inline content for lines, checked by writing it back; a line that
// does not write back exactly becomes a chip.
function checked_inline(lines: string[], ctx: MarkdownContext, line_triggers: boolean): PMNode[] {
    const options = {block_start: true, line_triggers};
    const source = lines.join("\n");
    const nodes = inline_nodes_for_lines(lines, ctx);
    if (serialize_inline_lines(nodes, ctx, options).text === source) {
        return nodes;
    }
    // Line by line, turning lines into chips from the first until the
    // whole writes back; with every line a chip it always does.
    const per_line = lines.map((line) => inline_nodes_for_lines([line], ctx));
    const joined = (): PMNode[] =>
        per_line.flatMap((line_nodes, index) =>
            index === 0 ? line_nodes : [schema.node("hard_break"), ...line_nodes],
        );
    for (const [index, line] of lines.entries()) {
        if (serialize_inline_lines(joined(), ctx, options).text === source) {
            break;
        }
        per_line[index] = line === "" ? [] : [schema.node("opaque_inline", {raw: line})];
    }
    return joined();
}

function chunk_end(lines: string[], from: number): number {
    let i = from;
    while (i + 1 < lines.length && !is_blank(lines[i + 1]!)) {
        i += 1;
    }
    return i;
}

function opaque(lines: string[], first: number, last: number, kind: BlockKind): ParsedBlock {
    return {
        node: schema.node("opaque_block", {raw: lines.slice(first, last + 1).join("\n"), kind}),
        first,
        last,
    };
}

type ListDraft = {ordered: boolean; items: ItemDraft[]};
type ItemDraft = {marker: string; lines: string[]; indents: string[]; children: ListDraft[]};

function parse_list(lines: string[], start: number, ctx: MarkdownContext): ParsedBlock {
    const is_ordered = (marker: string): boolean => /\d/u.test(marker);
    const top: ListDraft = {
        ordered: is_ordered(ITEM_RE.exec(lines[start]!)!.groups!["marker"]!),
        items: [],
    };
    // stack[d] is the list open at depth d.
    const stack: ListDraft[] = [top];
    let last = start;
    for (let i = start; i < lines.length; i += 1) {
        const line = lines[i]!;
        if (
            is_blank(line) ||
            FENCE_RE.test(line) ||
            HEADING_TRIGGER_RE.test(line) ||
            HR_RE.test(line)
        ) {
            break;
        }
        const item = ITEM_RE.exec(line);
        if (item === null) {
            if (QUOTE_TRIGGER_RE.test(line)) {
                // A quote inside a list item: not shown as a list.
                return opaque(lines, start, chunk_end(lines, i), "list");
            }
            // A continuation line of the last item.
            const current = stack.at(-1)!.items.at(-1)!;
            const indent = /^[ ]*/u.exec(line)![0];
            current.lines.push(line.slice(indent.length));
            current.indents.push(indent);
            last = i;
            continue;
        }
        const {indent, marker, space, content} = item.groups!;
        const ordered = is_ordered(marker!);
        const level = Math.min(Math.floor(indent!.length / 2), stack.length);
        let list: ListDraft;
        if (level === 0) {
            if (ordered !== top.ordered) {
                break;
            }
            list = top;
        } else {
            const parent = stack[level - 1]!.items.at(-1)!;
            const previous = parent.children.at(-1);
            if (previous?.ordered === ordered) {
                list = previous;
            } else {
                list = {ordered, items: []};
                parent.children.push(list);
            }
        }
        stack.length = level;
        stack.push(list);
        list.items.push({
            marker: indent! + marker! + space!,
            lines: [content!],
            indents: [],
            children: [],
        });
        last = i;
    }
    const build = (list: ListDraft): PMNode =>
        schema.node(
            list.ordered ? "ordered_list" : "bullet_list",
            null,
            list.items.map((item) => {
                let break_index = 0;
                const content = checked_inline(item.lines, ctx, true).map((node) => {
                    if (node.type.name !== "hard_break") {
                        return node;
                    }
                    // One indentation was taken from every line that
                    // continues the item, and one break made for each.
                    const indent = item.indents[break_index]!;
                    break_index += 1;
                    return schema.node("hard_break", {indent});
                });
                return schema.node("list_item", {marker: item.marker}, [
                    schema.node("paragraph", null, content),
                    ...item.children.map((child) => build(child)),
                ]);
            }),
        );
    return {node: build(top), first: start, last};
}

// The line that closes the fenced block opened at `start`, following
// nested fences inside quotes and spoilers as the server does; undefined
// when the block is never closed.
function find_fence_close(lines: string[], start: number): number | undefined {
    const stack: {fence: string; processes_contents: boolean}[] = [];
    const open = (line: string): void => {
        const groups = FENCE_RE.exec(line)!.groups!;
        const lang = (groups["lang"] ?? "").toLowerCase();
        stack.push({
            fence: groups["fence"]!,
            processes_contents: ["quote", "quoted", "spoiler"].includes(lang),
        });
    };
    open(lines[start]!);
    for (let i = start + 1; i < lines.length; i += 1) {
        const line = lines[i]!;
        const top = stack.at(-1)!;
        if (line.trimEnd() === top.fence) {
            stack.pop();
            if (stack.length === 0) {
                return i;
            }
        } else if (top.processes_contents && FENCE_RE.test(line)) {
            open(line);
        }
    }
    return undefined;
}

function parse_fence(lines: string[], start: number, ctx: MarkdownContext): ParsedBlock {
    const opening = lines[start]!;
    const groups = FENCE_RE.exec(opening)!.groups!;
    const fence = groups["fence"]!;
    const lang = (groups["lang"] ?? "").toLowerCase();
    const close_index = find_fence_close(lines, start);
    const body = lines.slice(start + 1, close_index ?? lines.length);
    const common = {
        fence,
        close: close_index === undefined ? null : lines[close_index]!,
        bodyless: body.length === 0,
    };
    const last = close_index ?? lines.length - 1;
    // Quotes and spoilers hold at least an empty paragraph to type in.
    const inner = common.bodyless ? [""] : body;
    let node: PMNode;
    if (lang === "quote" || lang === "quoted") {
        node = schema.node(
            "blockquote",
            {...common, style: "fence", info: opening.slice(fence.length)},
            parse_blocks(inner, ctx),
        );
    } else if (lang === "spoiler") {
        const header_start = opening.length - (groups["header"] ?? "").length;
        node = schema.node(
            "spoiler",
            {...common, info: opening.slice(fence.length, header_start)},
            [
                schema.node(
                    "spoiler_header",
                    null,
                    checked_inline([opening.slice(header_start)], ctx, false),
                ),
                ...parse_blocks(inner, ctx),
            ],
        );
    } else {
        const text = body.join("\n");
        node = schema.node(
            lang === "math" ? "math_block" : "code_block",
            {...common, info: opening.slice(fence.length)},
            text === "" ? [] : [schema.text(text)],
        );
    }
    return {node, first: start, last};
}

function parse_angle_quote(lines: string[], start: number, ctx: MarkdownContext): ParsedBlock {
    const last = chunk_end(lines, start);
    const quoted = lines.slice(start, last + 1);
    const strict = quoted.every((line) => line === ">" || line.startsWith("> "));
    // The server ignores a quote of nothing but empty "> " lines.
    const empty = quoted.every((line) => is_blank(line.slice(1)));
    if (!strict || empty) {
        return opaque(lines, start, last, "angle_quote");
    }
    return {
        node: schema.node(
            "blockquote",
            {style: "angle"},
            parse_blocks(
                quoted.map((line) => line.slice(2)),
                ctx,
            ),
        ),
        first: start,
        last,
    };
}

function parse_heading(lines: string[], i: number, ctx: MarkdownContext): ParsedBlock {
    const m = HEADING_RE.exec(lines[i]!);
    if (m === null || m.groups!["content"]!.endsWith("#")) {
        return opaque(lines, i, i, "heading");
    }
    return {
        node: schema.node(
            "heading",
            {level: m.groups!["hashes"]!.length},
            checked_inline([m.groups!["content"]!], ctx, false),
        ),
        first: i,
        last: i,
    };
}

function classify_line(
    lines: string[],
    i: number,
    block_start: boolean,
    after_text: boolean,
): BlockKind {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
        return "fence";
    }
    if (is_blank(line)) {
        return "paragraph";
    }
    if (HR_RE.test(line)) {
        return "hr";
    }
    if (HEADING_TRIGGER_RE.test(line)) {
        return "heading";
    }
    if (LIST_START_RE.test(line) && (block_start || (after_text && LI_RE.test(line)))) {
        return "list";
    }
    if (QUOTE_TRIGGER_RE.test(line)) {
        return "angle_quote";
    }
    if (block_start && INDENTED_CODE_RE.test(line)) {
        return "indented_code";
    }
    const next = lines[i + 1];
    if (block_start && line.includes("|") && next !== undefined && TABLE_SEPARATOR_RE.test(next)) {
        return "table";
    }
    return "paragraph";
}

// A parsed block has to write back to its own lines; one that does not
// is kept as a chip.
function checked_block(lines: string[], block: ParsedBlock, ctx: MarkdownContext): ParsedBlock {
    const source = lines.slice(block.first, block.last + 1).join("\n");
    if (
        block.node.type.name === "opaque_block" ||
        serialize_block(block.node, ctx, true, true).text === source
    ) {
        return block;
    }
    return opaque(lines, block.first, block.last, block_kind_of(block.node));
}

// Parses lines into blocks whose serialisation is lines.join("\n").
function parse_blocks(lines: string[], ctx: MarkdownContext): PMNode[] {
    const blocks: ParsedBlock[] = [];
    // Line indexes of paragraph text not yet made into a paragraph.
    let run: number[] = [];
    const flush_run = (block_follows: boolean): void => {
        if (run.length === 0) {
            return;
        }
        let first = run[0]!;
        let last = run.at(-1)!;
        run = [];
        if (lines.slice(first, last + 1).every((line) => line === "")) {
            // Empty lines between blocks, or before the first, are the
            // blocks' separation; after the last they are an empty
            // paragraph to type in.
            if (!block_follows) {
                blocks.push(paragraph(lines, first, last, ctx));
            }
            return;
        }
        if (blocks.length > 0) {
            while (lines[first] === "") {
                first += 1;
            }
        }
        if (block_follows) {
            while (lines[last] === "") {
                last -= 1;
            }
        }
        blocks.push(paragraph(lines, first, last, ctx));
    };
    let block_start = true;
    let after_text = false;
    let i = 0;
    while (i < lines.length) {
        const kind = classify_line(lines, i, block_start, after_text);
        let block: ParsedBlock;
        switch (kind) {
            case "fence":
                block = checked_block(lines, parse_fence(lines, i, ctx), ctx);
                break;
            case "list":
                block = checked_block(lines, parse_list(lines, i, ctx), ctx);
                break;
            case "heading":
                block = checked_block(lines, parse_heading(lines, i, ctx), ctx);
                break;
            case "angle_quote":
                block = checked_block(lines, parse_angle_quote(lines, i, ctx), ctx);
                break;
            case "hr":
                block = opaque(lines, i, i, "hr");
                break;
            case "table":
            case "indented_code":
                block = opaque(lines, i, chunk_end(lines, i), kind);
                break;
            default:
                run.push(i);
                block_start = is_blank(lines[i]!);
                after_text = !block_start;
                i += 1;
                continue;
        }
        flush_run(true);
        blocks.push(block);
        i = block.last + 1;
        // Fences, headings and rules end a block for the server; lists,
        // quotes, tables and indented code run to the next blank line,
        // so what follows them directly is a lazy line of theirs or a
        // new list.
        block_start = kind === "fence" || kind === "heading" || kind === "hr";
        after_text = !block_start;
    }
    // There is always a line, so this makes at least one block.
    flush_run(false);
    return blocks.map((block, index) =>
        block.node.type.create(
            {
                ...block.node.attrs,
                sep: index === 0 ? block.first : block.first - blocks[index - 1]!.last,
            },
            block.node.content,
        ),
    );
}

function paragraph(
    lines: string[],
    first: number,
    last: number,
    ctx: MarkdownContext,
): ParsedBlock {
    return {
        node: schema.node(
            "paragraph",
            null,
            checked_inline(lines.slice(first, last + 1), ctx, true),
        ),
        first,
        last,
    };
}

export function parse_markdown(markdown: string, ctx: MarkdownContext = default_context): PMNode {
    if (WIDGET_RE.test(markdown)) {
        return schema.node("doc", null, [
            schema.node("opaque_block", {raw: markdown, kind: "widget", sep: 0}),
        ]);
    }
    const doc = schema.node("doc", null, parse_blocks(markdown.split("\n"), ctx));
    if (serialize_markdown(doc, ctx).markdown === markdown) {
        return doc;
    }
    // Not expected: blocks that each write back exactly but not next to
    // each other. Keep the text exactly, as one chip.
    return schema.node("doc", null, [
        schema.node("opaque_block", {raw: markdown, kind: "paragraph", sep: 0}),
    ]);
}

// ---- Blocks: nodes to Markdown ----

type BlockOutput = {text: string; anchors: Anchor[]; lossy: boolean};

function block_kind_of(node: PMNode): BlockKind {
    switch (node.type.name) {
        case "bullet_list":
        case "ordered_list":
            return "list";
        case "blockquote":
            return node.attrs["style"] === "angle" ? "angle_quote" : "fence";
        case "code_block":
        case "math_block":
        case "spoiler":
            return "fence";
        case "heading":
            return "heading";
        case "opaque_block":
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the kind an opaque block was parsed as
            return node.attrs["kind"] as BlockKind;
        default:
            return "paragraph";
    }
}

// The fewest newlines between two blocks for the server to keep them
// apart as they are.
function min_sep(previous: PMNode, node: PMNode): number {
    const before = block_kind_of(previous);
    const after = block_kind_of(node);
    if (after === "paragraph" && is_empty_paragraph(node)) {
        // Blank lines never join the block before them.
        return 1;
    }
    // Fences are taken out before blocks are parsed, and headings and
    // rules split the block they are in.
    const splitting = new Set<BlockKind>(["fence", "heading", "hr"]);
    if (splitting.has(before) || splitting.has(after)) {
        return 1;
    }
    if (before === "list" && after === "list") {
        // Lists of different kinds split on their own; lists of the same
        // kind only at a blank line.
        return previous.type === node.type ? 2 : 1;
    }
    if (before !== "paragraph" && before !== "widget") {
        // Lists, "> " quotes, tables and indented code take a line of
        // text that follows them as a lazy continuation line.
        return 2;
    }
    if (after === "paragraph" || after === "indented_code" || after === "table") {
        return 2;
    }
    // A list kept as a chip holds its first line as it was written.
    const first_line =
        node.type.name === "opaque_block"
            ? String(node.attrs["raw"])
            : String(node.firstChild!.attrs["marker"] ?? "- ");
    if (after === "list" && !LI_RE.test(first_line)) {
        // "10. item" after text continues the paragraph.
        return 2;
    }
    return 1;
}

function is_empty_paragraph(node: PMNode): boolean {
    let empty = true;
    // eslint-disable-next-line unicorn/no-array-for-each -- a ProseMirror node, not an array
    node.forEach((child) => {
        empty &&= child.type.name === "hard_break" || (child.isText && is_blank(child.text!));
    });
    return empty;
}

function default_sep(previous: PMNode, node: PMNode): number {
    if (block_kind_of(node) === "paragraph" && is_empty_paragraph(node)) {
        // An empty line the user is about to type on, as pressing Enter
        // on the last empty item of a list leaves.
        return min_sep(previous, node);
    }
    return block_kind_of(previous) === "list" && block_kind_of(node) !== "list"
        ? 2
        : min_sep(previous, node);
}

function shift_anchors(anchors: Anchor[], pos: number, off: number): Anchor[] {
    return anchors.map((anchor) => ({...anchor, pos: anchor.pos + pos, off: anchor.off + off}));
}

function children_of(node: PMNode): PMNode[] {
    const children: PMNode[] = [];
    // eslint-disable-next-line unicorn/no-array-for-each -- a ProseMirror node, not an array
    node.forEach((child) => {
        children.push(child);
    });
    return children;
}

// Serialises the block children of `parent`, whose content starts at
// document position `content_start`. `at_end`: nothing follows `parent`
// in the document, so its last block may stay an unclosed fence.
// What a top-level block was last written as. ProseMirror keeps the
// nodes an edit did not touch, so after a keystroke only the block
// holding the cursor is written again.
type CachedBlock = {
    ctx: MarkdownContext;
    block_start: boolean;
    at_end: boolean;
    result: BlockOutput;
};
const block_cache = new WeakMap<PMNode, CachedBlock>();

function serialize_block_cached(
    node: PMNode,
    ctx: MarkdownContext,
    block_start: boolean,
    at_end: boolean,
): BlockOutput {
    const cached = block_cache.get(node);
    if (cached?.ctx === ctx && cached.block_start === block_start && cached.at_end === at_end) {
        return cached.result;
    }
    const result = serialize_block(node, ctx, block_start, at_end);
    block_cache.set(node, {ctx, block_start, at_end, result});
    return result;
}

function serialize_children(
    parent: PMNode,
    ctx: MarkdownContext,
    content_start: number,
    at_end: boolean,
): BlockOutput {
    let text = "";
    const anchors: Anchor[] = [];
    let lossy = false;
    let pos = content_start;
    let previous: PMNode | undefined;
    const children = children_of(parent);
    for (const [index, child] of children.entries()) {
        if (child.type.name === "spoiler_header") {
            pos += child.nodeSize;
            continue;
        }
        const stored = number_attr(child.attrs, "sep");
        let sep = stored ?? 0;
        let block_start = true;
        if (previous !== undefined) {
            sep = Math.max(stored ?? default_sep(previous, child), min_sep(previous, child));
            block_start = sep >= 2 || min_sep(previous, child) === 1;
        }
        text += "\n".repeat(sep);
        const write = parent.type.name === "doc" ? serialize_block_cached : serialize_block;
        const result = write(child, ctx, block_start, at_end && index === children.length - 1);
        anchors.push(...shift_anchors(result.anchors, pos, text.length));
        text += result.text;
        lossy ||= result.lossy;
        pos += child.nodeSize;
        previous = child;
    }
    return {text, anchors, lossy};
}

// Serialises one block; anchors are relative to the position before the
// node and to the block's first character.
// Writes the characters at `offsets` of `lines.text` as entities, moving
// the anchors after each along. Used where the server would drop or
// misread a character the inline writer has no reason to escape: the
// hashes ending a heading, a backtick in a spoiler's header.
function escape_offsets(lines: InlineLines, offsets: number[]): InlineLines {
    let {text, anchors} = lines;
    for (const offset of offsets.toSorted((a, b) => b - a)) {
        const entity = encode_entity(text[offset]!);
        text = text.slice(0, offset) + entity + text.slice(offset + 1);
        const added = entity.length - 1;
        anchors = anchors.map((anchor) =>
            anchor.off > offset ? {...anchor, off: anchor.off + added} : anchor,
        );
    }
    return {text, anchors, lossy: lines.lossy};
}

function serialize_block(
    node: PMNode,
    ctx: MarkdownContext,
    block_start: boolean,
    at_end: boolean,
): BlockOutput {
    switch (node.type.name) {
        case "paragraph":
        case "heading": {
            const is_heading = node.type.name === "heading";
            const prefix = is_heading ? "#".repeat(Number(node.attrs["level"])) + " " : "";
            let inline = serialize_inline_lines(children_of(node), ctx, {
                block_start: block_start && !is_heading,
                line_triggers: !is_heading,
            });
            // The server drops hashes at the end of a heading.
            const trailing = is_heading ? /#+$/u.exec(inline.text) : null;
            if (trailing !== null) {
                inline = escape_offsets(inline, [trailing.index]);
            }
            const text = prefix + inline.text;
            return {
                text,
                anchors: [
                    {pos: 0, off: 0},
                    ...shift_anchors(inline.anchors, 1, prefix.length),
                    {pos: node.nodeSize, off: text.length},
                ],
                lossy: inline.lossy,
            };
        }
        case "code_block":
        case "math_block":
            return serialize_code_block(node, at_end);
        case "blockquote":
            return node.attrs["style"] === "angle"
                ? serialize_angle_quote(node, ctx, at_end)
                : serialize_fenced_container(node, ctx, at_end);
        case "spoiler":
            return serialize_fenced_container(node, ctx, at_end);
        case "bullet_list":
        case "ordered_list":
            return serialize_list(node, ctx, 0);
        default: {
            const raw = String(node.attrs["raw"]);
            return {
                text: raw,
                anchors: [
                    {pos: 0, off: 0},
                    {pos: node.nodeSize, off: raw.length},
                ],
                lossy: false,
            };
        }
    }
}

// Zulip's get_unused_fence: a fence longer than any inside. Tildes
// where a backtick fence could not carry the block's info string.
function unused_fence(content: string, char: string): string {
    let length = 3;
    const runs = new RegExp(`^ {0,3}(${char}{3,})`, "gmu");
    for (const match of content.matchAll(runs)) {
        length = Math.max(length, match[1]!.length + 1);
    }
    return char.repeat(length);
}

// The fence and closing line to write for a fenced block. The stored
// ones are kept unless the contents would close the block early; a block
// that was never closed stays unclosed at the end of the message.
function fence_lines(
    node: PMNode,
    content: string,
    would_close: (fence: string) => boolean,
    at_end: boolean,
    info = "",
): {fence: string; close: string | null} {
    const stored = string_attr(node.attrs, "fence");
    const backtick_in_info = info.includes("\u0060");
    if (
        stored !== null &&
        !would_close(stored) &&
        !(backtick_in_info && stored.startsWith("\u0060"))
    ) {
        const close = string_attr(node.attrs, "close");
        return {fence: stored, close: close ?? (at_end ? null : stored)};
    }
    const fence = unused_fence(content, backtick_in_info ? "~" : "\u0060");
    return {fence, close: fence};
}

function serialize_code_block(node: PMNode, at_end: boolean): BlockOutput {
    const content = node.textContent;
    const info = String(node.attrs["info"]);
    const {fence, close} = fence_lines(
        node,
        content,
        (fence) => content.split("\n").some((line) => line.trimEnd() === fence),
        at_end,
        info,
    );
    const opening = fence + info;
    const bodyless = content === "" && node.attrs["bodyless"] === true;
    const content_off = opening.length + (bodyless ? 0 : 1);
    const text = opening + (bodyless ? "" : "\n" + content) + (close === null ? "" : "\n" + close);
    return {
        text,
        anchors: [
            {pos: 0, off: 0},
            {pos: 1, off: content_off, text: true},
            {pos: 1 + content.length, off: content_off + content.length, text: true},
            {pos: node.nodeSize, off: text.length},
        ],
        lossy: false,
    };
}

// Whether a line of a quote's or spoiler's contents would close it: the
// server closes it on the first line equal to its fence that is not
// inside a block nested in it.
function closes_early(content: string, fence: string): boolean {
    let nested: string | undefined;
    for (const line of content.split("\n")) {
        if (nested !== undefined) {
            if (line.trimEnd() === nested) {
                nested = undefined;
            }
        } else if (line.trimEnd() === fence) {
            return true;
        } else {
            nested = FENCE_RE.exec(line)?.groups!["fence"];
        }
    }
    return false;
}

function serialize_fenced_container(
    node: PMNode,
    ctx: MarkdownContext,
    at_end: boolean,
): BlockOutput {
    const is_spoiler = node.type.name === "spoiler";
    const inner = serialize_children(node, ctx, 1, at_end);
    let header: InlineLines = {text: "", anchors: [], lossy: false};
    if (is_spoiler) {
        const header_nodes = children_of(node.firstChild!);
        header = serialize_inline_lines(header_nodes, ctx, {
            block_start: false,
            line_triggers: false,
        });
        // The header is one line: a backtick or tilde in it would end
        // the fence line early, and the server trims it.
        const escaped: number[] = [];
        for (const [offset, char] of [...header.text].entries()) {
            if (char === "\u0060" || char === "~") {
                escaped.push(offset);
            }
        }
        if (header.text.startsWith(" ")) {
            escaped.push(0);
        }
        if (header.text.length > 1 && header.text.endsWith(" ")) {
            escaped.push(header.text.length - 1);
        }
        header = escape_offsets(header, escaped);
        header.lossy ||= header_nodes.some((child) => child.type.name === "hard_break");
    }
    const {fence, close} = fence_lines(
        node,
        inner.text,
        (fence) => closes_early(inner.text, fence),
        at_end,
    );
    let info = string_attr(node.attrs, "info") ?? (is_spoiler ? "spoiler" : "quote");
    if (is_spoiler && header.text !== "" && !info.endsWith(" ")) {
        info += " ";
    }
    const opening = fence + info;
    const bodyless = inner.text === "" && node.attrs["bodyless"] === true;
    const head = opening + header.text;
    const content_off = head.length + (bodyless ? 0 : 1);
    const text = head + (bodyless ? "" : "\n" + inner.text) + (close === null ? "" : "\n" + close);
    return {
        text,
        anchors: [
            {pos: 0, off: 0},
            ...shift_anchors(header.anchors, 2, opening.length),
            ...shift_anchors(inner.anchors, 0, content_off),
            {pos: node.nodeSize, off: text.length},
        ],
        lossy: inner.lossy || header.lossy,
    };
}

function serialize_angle_quote(node: PMNode, ctx: MarkdownContext, at_end: boolean): BlockOutput {
    const inner = serialize_children(node, ctx, 1, at_end);
    const lines = inner.text.split("\n");
    // For every inner line: where it starts, and how many characters the
    // prefixes up to and including its own add.
    const starts: number[] = [];
    const added: number[] = [];
    let offset = 0;
    let total = 0;
    for (const line of lines) {
        starts.push(offset);
        offset += line.length + 1;
        total += line === "" ? 1 : 2;
        added.push(total);
    }
    const text = lines.map((line) => (line === "" ? ">" : "> " + line)).join("\n");
    const anchors = inner.anchors.map((anchor) => {
        let line = 0;
        while (line + 1 < starts.length && starts[line + 1]! <= anchor.off) {
            line += 1;
        }
        return {...anchor, off: anchor.off + added[line]!};
    });
    return {
        text,
        anchors: [{pos: 0, off: 0}, ...anchors, {pos: node.nodeSize, off: text.length}],
        lossy: inner.lossy,
    };
}

function list_marker(list: PMNode, item: PMNode, index: number, depth: number): string {
    const ordered = list.type.name === "ordered_list";
    const stored = string_attr(item.attrs, "marker");
    const m = stored === null ? null : ITEM_RE.exec(stored + "x");
    if (m !== null) {
        const leading = m.groups!["indent"]!.length;
        const fits = leading === depth * 2 || leading === depth * 2 + 1;
        if (fits && /\d/u.test(m.groups!["marker"]!) === ordered) {
            return stored!;
        }
    }
    return "  ".repeat(depth) + (ordered ? `${index + 1}. ` : "- ");
}

function serialize_list(node: PMNode, ctx: MarkdownContext, depth: number): BlockOutput {
    let text = "";
    const anchors: Anchor[] = [{pos: 0, off: 0}];
    let lossy = false;
    let item_pos = 1;
    for (const [index, item] of children_of(node).entries()) {
        if (index > 0) {
            text += "\n";
        }
        const marker = list_marker(node, item, index, depth);
        let child_pos = item_pos + 1;
        for (const [child_index, child] of children_of(item).entries()) {
            if (child_index === 0) {
                const inline = serialize_inline_lines(children_of(child), ctx, {
                    block_start: false,
                    line_triggers: true,
                    indent: " ".repeat(marker.length),
                });
                text += marker;
                anchors.push(...shift_anchors(inline.anchors, child_pos + 1, text.length));
                text += inline.text;
                lossy ||= inline.lossy;
            } else {
                text += "\n";
                const nested = serialize_list(child, ctx, depth + 1);
                anchors.push(...shift_anchors(nested.anchors, child_pos, text.length));
                text += nested.text;
                lossy ||= nested.lossy;
            }
            child_pos += child.nodeSize;
        }
        item_pos += item.nodeSize;
    }
    anchors.push({pos: node.nodeSize, off: text.length});
    return {text, anchors, lossy};
}

export function serialize_markdown(
    doc: PMNode,
    ctx: MarkdownContext = default_context,
): SerializeResult {
    const result = serialize_children(doc, ctx, 0, true);
    const anchors = result.anchors.toSorted((a, b) => a.pos - b.pos || a.off - b.off);
    // A poll or to-do list is the whole message to the server.
    const widget_among_others =
        doc.childCount > 1 &&
        children_of(doc).some(
            (child) => child.type.name === "opaque_block" && child.attrs["kind"] === "widget",
        );
    return {markdown: result.text, anchors, lossy: result.lossy || widget_among_others};
}

// ---- Positions ----

// Text anchors next to each other with equal distances in positions and
// offsets enclose plain text, where the two advance together.
function interpolate(
    before: Anchor | undefined,
    after: Anchor | undefined,
    from: "pos" | "off",
    value: number,
): number | undefined {
    if (before?.text !== true || after?.text !== true) {
        return undefined;
    }
    const to = from === "pos" ? "off" : "pos";
    if (after.pos - before.pos !== after.off - before.off) {
        return undefined;
    }
    return before[to] + (value - before[from]);
}

// Anchors must be sorted by position, then offset. At a position with
// several offsets (at formatting boundaries) the last one is used.
export function pos_to_offset(anchors: Anchor[], pos: number): number {
    let before: Anchor | undefined;
    let after: Anchor | undefined;
    for (const anchor of anchors) {
        if (anchor.pos > pos) {
            after = anchor;
            break;
        }
        before = anchor;
    }
    if (before === undefined) {
        return 0;
    }
    if (before.pos === pos) {
        return before.off;
    }
    return interpolate(before, after, "pos", pos) ?? before.off;
}

// A position for a Markdown offset: inside a textblock where there is
// one, and inside syntax (a chip's Markdown, a delimiter) at its nearer
// end.
export function offset_to_pos(anchors: Anchor[], off: number): number {
    const all = anchors.toSorted((a, b) => a.off - b.off || a.pos - b.pos);
    const exact = all.filter((anchor) => anchor.off === off);
    if (exact.length > 0) {
        return (exact.find((anchor) => anchor.text === true) ?? exact[0]!).pos;
    }
    const text_anchors = all.filter((anchor) => anchor.text === true);
    const by_offset = text_anchors.length > 0 ? text_anchors : all;
    let before: Anchor | undefined;
    let after: Anchor | undefined;
    for (const anchor of by_offset) {
        if (anchor.off > off) {
            after = anchor;
            break;
        }
        before = anchor;
    }
    if (before === undefined) {
        return after?.pos ?? 0;
    }
    const exact_pos = interpolate(before, after, "off", off);
    if (exact_pos !== undefined) {
        return exact_pos;
    }
    return after === undefined || off - before.off <= after.off - off ? before.pos : after.pos;
}
