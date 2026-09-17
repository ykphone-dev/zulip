// Editing commands of the 옆커폰 rich composer: formatting marks, links,
// what Enter and Tab do, and Markdown typed as formatting.
//
// Block formatting from the toolbar (lists, quotes, spoilers, code and
// math blocks) is left to upstream's compose_ui.format_text working on
// the textarea's Markdown, so it produces exactly upstream's syntax; the
// sync then shows the result. What only makes sense in a rich editor is
// here: marks toggled over the selection (or for the next characters
// typed), links, lists continued and indented, and a way out of a quote.
//
// Markdown the user types is shown as what it means as soon as it means
// something, the way the server would read the same keystrokes: after a
// character that can complete syntax, the paragraph's Markdown with the
// character inserted is parsed again, and if it now reads differently
// the paragraph is replaced. Backspace right after that undoes it.

import {
    Fragment,
    type Mark,
    type MarkType,
    type Node as PMNode,
    type ResolvedPos,
    Slice,
} from "prosemirror-model";
import {
    type Command,
    type EditorState,
    NodeSelection,
    type Plugin,
    TextSelection,
    type Transaction,
} from "prosemirror-state";
import {newlineInCode, toggleMark} from "prosemirror-commands";
import {InputRule, inputRules} from "prosemirror-inputrules";
import {liftListItem, sinkListItem, splitListItem} from "prosemirror-schema-list";

import {sanitize_href} from "./ykphone_rich_inline.ts";
import {
    FENCE_RE,
    type MarkdownContext,
    offset_to_pos,
    parse_markdown,
    pos_to_offset,
    serialize_markdown,
} from "./ykphone_rich_markdown.ts";
import {schema} from "./ykphone_rich_schema.ts";

const CODE_TEXTBLOCKS = new Set(["code_block", "math_block"]);

function mark_type(name: string): MarkType {
    return schema.marks[name]!;
}

export function in_code(state: EditorState): boolean {
    return CODE_TEXTBLOCKS.has(state.selection.$from.parent.type.name);
}

// Whether the selection is text on one line: within one textblock that
// is not code, with no line break inside.
export function is_single_line_selection(state: EditorState): boolean {
    const {$from, $to, empty} = state.selection;
    if (empty || !$from.sameParent($to) || !$from.parent.isTextblock || in_code(state)) {
        return false;
    }
    let has_break = false;
    state.doc.nodesBetween($from.pos, $to.pos, (node) => {
        has_break ||= node.type.name === "hard_break";
    });
    return !has_break;
}

// The selection without the whitespace at its edges, as upstream's
// format_text trims it: delimiters cannot hold whitespace just inside.
function trimmed_selection(state: EditorState): {from: number; to: number} | undefined {
    const {from, to, empty} = state.selection;
    if (empty) {
        return {from, to};
    }
    const text = state.doc.textBetween(from, to, "\uFFFC", "\uFFFC");
    const lead = /^\s*/u.exec(text)![0].length;
    const trail = /\s*$/u.exec(text)![0].length;
    return lead + trail >= text.length ? undefined : {from: from + lead, to: to - trail};
}

// Bold, italic and strikethrough: over the selection (whitespace at its
// edges left out, as upstream's format_text trims it), or for what is
// typed next when nothing is selected. Text that is only partly
// formatted gets the formatting, as in other rich text editors.
// Formatting that Markdown could not carry to the server as shown (a
// code span ending in a backtick, math holding "$$") is refused.
export function toggle_format(name: "strong" | "em" | "strike" | "code" | "math"): Command {
    return (state, dispatch) => {
        if (in_code(state)) {
            return false;
        }
        const range = trimmed_selection(state);
        if (range === undefined) {
            return false;
        }
        const trimmed = state.apply(
            state.tr.setSelection(TextSelection.create(state.doc, range.from, range.to)),
        );
        // A textblock selection always takes a mark, so the command
        // never declines here.
        let captured: Transaction | undefined;
        toggleMark(mark_type(name), null, {removeWhenPresent: false})(trimmed, (tr) => {
            captured = tr;
        });
        const toggled = captured!;
        if (!serialize_markdown(state.doc).lossy && serialize_markdown(toggled.doc).lossy) {
            return false;
        }
        if (dispatch) {
            const tr = state.tr;
            for (const step of toggled.steps) {
                tr.step(step);
            }
            tr.setSelection(
                TextSelection.create(tr.doc, toggled.selection.from, toggled.selection.to),
            );
            tr.setStoredMarks(toggled.storedMarks);
            dispatch(tr.scrollIntoView());
        }
        return true;
    };
}

// The link the cursor sits in, or that holds the whole selection.
export function link_at_selection(
    state: EditorState,
    at?: number,
): {href: string; from: number; to: number} | undefined {
    const from = at ?? state.selection.from;
    const to = at ?? state.selection.to;
    const $from = state.doc.resolve(from);
    const type = mark_type("link");
    const base = $from.start();
    let found: {href: string; from: number; to: number} | undefined;
    let run: {mark: Mark; from: number} | undefined;
    const close = (end: number): void => {
        if (run !== undefined && run.from <= from && to <= end) {
            found ??= {href: String(run.mark.attrs["href"]), from: run.from, to: end};
        }
        run = undefined;
    };
    $from.parent.forEach((child, offset) => {
        const link = type.isInSet(child.marks);
        if (run !== undefined && (link === undefined || !link.eq(run.mark))) {
            close(base + offset);
        }
        if (link !== undefined) {
            run ??= {mark: link, from: base + offset};
        }
    });
    close(base + $from.parent.content.size);
    return found;
}

// Makes the selection a link to `href`; with nothing selected, inserts
// `text` (or the address itself) as the link.
export function apply_link(href: string, text?: string): Command {
    return (state, dispatch) => {
        if (in_code(state) || href.trim() === "") {
            return false;
        }
        const address = sanitize_href(href);
        if (address === undefined) {
            return false;
        }
        const link = mark_type("link").create({href: address});
        if (dispatch) {
            const {from, to, empty} = state.selection;
            const tr = state.tr;
            const existing = link_at_selection(state);
            if (empty && existing !== undefined) {
                tr.removeMark(existing.from, existing.to, mark_type("link"));
                tr.addMark(existing.from, existing.to, link);
                tr.setSelection(TextSelection.create(tr.doc, existing.to));
            } else if (empty) {
                const label = (text ?? "").trim() || address;
                const marks = link
                    .addToSet(state.storedMarks ?? state.selection.$from.marks())
                    .filter((mark) => !["code", "math"].includes(mark.type.name));
                tr.insert(from, schema.text(label, marks));
                tr.setSelection(TextSelection.create(tr.doc, from + label.length));
            } else {
                tr.removeMark(from, to, mark_type("code"));
                tr.removeMark(from, to, mark_type("math"));
                tr.addMark(from, to, link);
                // The cursor lands after the link, as it does in Slack,
                // so what is typed next is not swallowed by it.
                tr.setSelection(TextSelection.create(tr.doc, to));
            }
            dispatch(tr.scrollIntoView());
        }
        return true;
    };
}

// The address a link form entry stands for: one with a scheme or an
// absolute path as it is, a bare domain with https:// in front, and
// anything else nothing.
export function normalize_href(value: string): string | undefined {
    const trimmed = value.trim();
    if (/^(?:https?|ftp):\/\/\S+$/iu.test(trimmed) || /^(?:mailto|tel):\S+$/iu.test(trimmed)) {
        return trimmed;
    }
    if (trimmed.startsWith("/") && !/\s/u.test(trimmed)) {
        return trimmed;
    }
    if (/^(?:www\.)?[\w-]+(?:\.[\w-]+)+(?:[/?#]\S*)?$/u.test(trimmed)) {
        return "https://" + trimmed;
    }
    return undefined;
}

// What Enter in the link form makes of its fields: `text` is the text
// field, which the form only has when nothing is selected, and `href`
// the link field. With the link field empty, an address typed as the
// text is taken as the link. Undefined means there is no link yet and
// the link field should get the focus.
export function link_form_submission(
    text: string | undefined,
    href: string,
): {href: string; text: string | undefined} | undefined {
    const link = normalize_href(href);
    if (link !== undefined) {
        return {href: link, text};
    }
    const from_text = text === undefined ? undefined : normalize_href(text);
    if (href.trim() === "" && from_text !== undefined) {
        return {href: from_text, text: undefined};
    }
    return undefined;
}

// ---- Code block languages ----

const FENCED_BLOCK_NAMES = new Set(["quote", "quoted", "spoiler", "math"]);
const INFO_LANGUAGE_RE = /^(?<prefix>[ {.]*)(?<lang>[\w+\-./#]*)(?<rest>.*)$/su;

// The language a code block's info string (what follows its fence) names.
export function code_block_language(info: string): string {
    return INFO_LANGUAGE_RE.exec(info)!.groups!["lang"]!;
}

// Whether `language` can be written as a code block's language: the
// characters a fence line allows, and not a name that makes the block a
// quote, spoiler or math block.
export function is_code_language(language: string): boolean {
    return /^[\w+\-./#]+$/u.test(language) && !FENCED_BLOCK_NAMES.has(language.toLowerCase());
}

// The info string with its language replaced; "" leaves plain code.
function info_with_language(info: string, language: string): string {
    const {prefix, lang, rest} = INFO_LANGUAGE_RE.exec(info)!.groups!;
    if (language === "") {
        return "";
    }
    return lang === "" ? language : prefix! + language + rest!;
}

// Sets the language of the code block at `pos` ("" for none).
export function set_code_block_language(pos: number, language: string): Command {
    return (state, dispatch) => {
        const node = state.doc.nodeAt(pos);
        if (node?.type.name !== "code_block" || (language !== "" && !is_code_language(language))) {
            return false;
        }
        if (dispatch) {
            const info = info_with_language(String(node.attrs["info"]), language);
            dispatch(state.tr.setNodeMarkup(pos, undefined, {...node.attrs, info}));
        }
        return true;
    };
}

export const remove_link: Command = (state, dispatch) => {
    const link = link_at_selection(state);
    if (link === undefined) {
        return false;
    }
    if (dispatch) {
        dispatch(state.tr.removeMark(link.from, link.to, mark_type("link")));
    }
    return true;
};

// The marker for a list item added after `item`: the same bullet, or the
// next number, with the same indentation.
export function next_marker(item: PMNode): string | null {
    const marker = item.attrs["marker"] as string | null;
    if (marker === null) {
        return null;
    }
    return marker.replace(/\d+/u, (number) => String(Number(number) + 1));
}

// A line after a selected block chip (a table, a poll), rather than
// the chip's replacement by a line break.
function paragraph_after_selected_block(
    state: EditorState,
    dispatch?: (tr: Transaction) => void,
): boolean {
    const {selection} = state;
    if (!(selection instanceof NodeSelection) || !selection.node.isBlock) {
        return false;
    }
    if (dispatch) {
        const tr = state.tr.insert(selection.to, schema.nodes["paragraph"]!.create());
        dispatch(tr.setSelection(TextSelection.create(tr.doc, selection.to + 1)).scrollIntoView());
    }
    return true;
}

function insert_hard_break(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
    if (dispatch) {
        const marks = state.storedMarks ?? state.selection.$from.marks();
        const tr = state.tr.replaceSelectionWith(schema.nodes["hard_break"]!.create());
        dispatch(tr.setStoredMarks(marks).scrollIntoView());
    }
    return true;
}

// Enter on an empty last line of a quote or spoiler leaves it.
const exit_container: Command = (state, dispatch) => {
    const {$from, empty} = state.selection;
    if (!empty || $from.depth < 2 || $from.parent.type.name !== "paragraph") {
        return false;
    }
    const container = $from.node(-1);
    if (!["blockquote", "spoiler"].includes(container.type.name)) {
        return false;
    }
    const paragraph = $from.parent;
    const is_last = $from.index(-1) === container.childCount - 1;
    const last = paragraph.lastChild;
    const on_empty_line =
        paragraph.content.size === 0 ||
        (last?.type.name === "hard_break" && $from.parentOffset === paragraph.content.size);
    const min_children = container.type.name === "spoiler" ? 3 : 2;
    if (
        !is_last ||
        !on_empty_line ||
        (paragraph.content.size === 0 && container.childCount < min_children)
    ) {
        return false;
    }
    if (dispatch) {
        const tr = state.tr;
        if (paragraph.content.size === 0) {
            tr.delete($from.before(), $from.after());
        } else {
            tr.delete($from.pos - 1, $from.pos);
        }
        const after_container = tr.mapping.map($from.after(-1));
        tr.insert(after_container, schema.nodes["paragraph"]!.create());
        tr.setSelection(TextSelection.create(tr.doc, after_container + 1));
        dispatch(tr.scrollIntoView());
    }
    return true;
};

// Enter that does not send: a new line of code, a new list item (or out
// of an empty one), a way out of a quote, a paragraph after a heading,
// the spoiler's content after its header, and otherwise a line break —
// the same text a newline in the textarea gives.
export const enter_without_sending: Command = (state, dispatch) => {
    if (paragraph_after_selected_block(state, dispatch)) {
        return true;
    }
    const {$from} = state.selection;
    const parent = $from.parent;
    if (CODE_TEXTBLOCKS.has(parent.type.name)) {
        return newlineInCode(state, dispatch);
    }
    if (exit_container(state, dispatch)) {
        return true;
    }
    if ($from.depth >= 2 && $from.node(-1).type.name === "list_item") {
        const item_type = schema.nodes["list_item"]!;
        // An empty item at the end of a list ends the list.
        return (
            splitListItem(item_type, {marker: next_marker($from.node(-1))})(state, dispatch) ||
            liftListItem(item_type)(state, dispatch)
        );
    }
    if (parent.type.name === "heading") {
        if (dispatch) {
            const tr = state.tr.split($from.pos, 1, [{type: schema.nodes["paragraph"]!}]);
            dispatch(tr.scrollIntoView());
        }
        return true;
    }
    if (parent.type.name === "spoiler_header") {
        if (dispatch) {
            const body = $from.after();
            dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(body + 1))));
        }
        return true;
    }
    return insert_hard_break(state, dispatch);
};

export const indent_list_item: Command = (state, dispatch) =>
    sinkListItem(schema.nodes["list_item"]!)(state, dispatch);

export const outdent_list_item: Command = (state, dispatch) =>
    liftListItem(schema.nodes["list_item"]!)(state, dispatch);

// At the very end of the message inside a quote, list, code block or
// the like, moving down (or right) adds a line after it to type on.
export const leave_block_at_end: Command = (state, dispatch) => {
    const {$from, empty} = state.selection;
    if (!empty || $from.depth < 1 || $from.parentOffset < $from.parent.content.size) {
        return false;
    }
    if ($from.after(1) !== state.doc.content.size) {
        return false;
    }
    const top = $from.node(1);
    if (top.type.name === "paragraph" || top.type.name === "heading") {
        return false;
    }
    for (let depth = $from.depth; depth > 1; depth -= 1) {
        if ($from.index(depth - 1) !== $from.node(depth - 1).childCount - 1) {
            return false;
        }
    }
    if (dispatch) {
        const end = state.doc.content.size;
        const tr = state.tr.insert(end, schema.nodes["paragraph"]!.create());
        tr.setSelection(TextSelection.create(tr.doc, end + 1));
        dispatch(tr.scrollIntoView());
    }
    return true;
};

// ---- Markdown typed as formatting ----

function is_top_level_container(node: PMNode): boolean {
    return ["doc", "blockquote", "spoiler"].includes(node.type.name);
}

// The offset in its paragraph where the line holding `pos` starts.
function line_start_offset(state: EditorState, pos: number): number {
    const $pos = state.doc.resolve(pos);
    let start = 0;
    $pos.parent.forEach((child, offset) => {
        if (child.type.name === "hard_break" && offset < $pos.parentOffset) {
            start = offset + 1;
        }
    });
    return start;
}

const OBJECT_REPLACEMENT = String.fromCodePoint(0xfffc);

// The same kind of block, apart from how far it sits from the block
// before it, which a block of its own has nothing to say about.
function same_kind_of_block(node: PMNode, other: PMNode): boolean {
    return (
        node.type === other.type &&
        Object.entries(node.attrs).every(
            ([name, value]) => name === "sep" || other.attrs[name] === value,
        )
    );
}

// The textblock around `$pos` as a document of its own, and where the
// textblock's content starts in it. A spoiler's header is read as the
// header of an otherwise empty spoiler, since it is Markdown only there.
function standalone_textblock($pos: ResolvedPos): {
    doc: PMNode;
    content_start: number;
    textblock: (doc: PMNode) => PMNode | undefined;
} {
    const block = $pos.parent;
    if (block.type.name === "spoiler_header") {
        const spoiler = $pos.node(-1);
        return {
            doc: schema.node("doc", null, [
                spoiler.type.create({...spoiler.attrs, sep: null}, [
                    block,
                    schema.nodes["paragraph"]!.create(),
                ]),
            ]),
            content_start: 2,
            // Still one spoiler: its header is what the typing changed.
            // (Its info string is not compared; a header makes the
            // writer add a space after "spoiler".) A space at the end of
            // the header was written as an entity, since the server trims
            // it; followed by what was typed it is a space again.
            textblock(doc) {
                const reparsed = doc.childCount === 1 ? doc.firstChild! : undefined;
                if (reparsed?.type !== spoiler.type) {
                    return undefined;
                }
                const header = reparsed.firstChild!;
                return header.type.create(
                    header.attrs,
                    header.children.map((child) =>
                        child.type.name === "escape" && child.attrs["char"] === " "
                            ? schema.text(" ", child.marks)
                            : child,
                    ),
                );
            },
        };
    }
    // On its own the block starts the document, whatever it followed.
    return {
        doc: schema.node("doc", null, [
            block.type.create({...block.attrs, sep: null}, block.content),
        ]),
        content_start: 1,
        textblock(doc) {
            const reparsed = doc.childCount === 1 ? doc.firstChild! : undefined;
            return reparsed !== undefined && same_kind_of_block(reparsed, block)
                ? reparsed
                : undefined;
        },
    };
}

// Re-reads the Markdown of the block around `pos` with `text` inserted
// at `pos`: a paragraph, a heading or a spoiler's header, the textblocks
// outside code, whose text is Markdown. Returns a transaction replacing the block's content when the
// text makes the Markdown mean something new, or null.
function reparse_with_typed_text(
    state: EditorState,
    pos: number,
    text: string,
    ctx: MarkdownContext,
): Transaction | null {
    const $pos = state.doc.resolve(pos);
    const standalone = standalone_textblock($pos);
    const {markdown, anchors} = serialize_markdown(standalone.doc, ctx);
    const at = standalone.content_start + $pos.parentOffset;
    const offset = pos_to_offset(anchors, at);
    const before = markdown.slice(0, offset);
    const typed = before + text + markdown.slice(offset);
    const inserted = schema.text(text, state.storedMarks ?? $pos.marks());
    const literal = standalone.doc.replace(at, at, new Slice(Fragment.from(inserted), 0, 0));
    if (serialize_markdown(literal, ctx).markdown === typed) {
        return null;
    }
    const reparsed = parse_markdown(typed, ctx);
    const textblock = standalone.textblock(reparsed);
    if (textblock === undefined) {
        // Only inline syntax is completed this way; typed block syntax
        // has rules of its own.
        return null;
    }
    const cursor = offset_to_pos(
        serialize_markdown(reparsed, ctx).anchors,
        before.length + text.length,
    );
    const tr = state.tr;
    tr.replaceWith($pos.start(), $pos.end(), textblock.content);
    tr.setSelection(
        TextSelection.near(tr.doc.resolve($pos.start() + cursor - standalone.content_start)),
    );
    // What is typed next continues outside the syntax just completed, as
    // it would in the textarea.
    tr.setStoredMarks(state.storedMarks ?? $pos.marks());
    return tr;
}

// Characters that can complete inline syntax. A line break in the text
// the rules are matched against is an object replacement character, like
// every other leaf node.
const INLINE_TRIGGER_RE = /[\x60)*:>$~]$/u;
const LINE_START = String.raw`(?:^|\n|\uFFFC)`;
const BULLET_RE = new RegExp(`${LINE_START}(?<prefix>[ ]?[*+-][ ])$`, "u");
const ORDERED_RE = new RegExp(`${LINE_START}(?<prefix>[ ]?\\d+\\.[ ])$`, "u");
const QUOTE_RE = new RegExp(`${LINE_START}(?<prefix>> )$`, "u");
const HEADING_RE_TYPED = new RegExp(`${LINE_START}(?<prefix>#{1,6} )$`, "u");

// Replaces the line the cursor is on with a block built from the rest of
// that line, keeping the lines around it as paragraphs. This is what
// typing a list bullet, a quote marker or a heading's hashes does.
function replace_line_with_block(
    state: EditorState,
    pos: number,
    prefix_length: number,
    build: (content: Fragment) => PMNode,
): Transaction | null {
    const $pos = state.doc.resolve(pos);
    const paragraph = $pos.parent;
    if (paragraph.type.name !== "paragraph" || !is_top_level_container($pos.node(-1))) {
        return null;
    }
    const line_start = line_start_offset(state, pos);
    let line_end = paragraph.content.size;
    paragraph.forEach((child, offset) => {
        if (
            child.type.name === "hard_break" &&
            offset >= $pos.parentOffset &&
            line_end === paragraph.content.size
        ) {
            line_end = offset;
        }
    });
    const content = paragraph.content.cut(line_start + prefix_length, line_end);
    const blocks: PMNode[] = [];
    if (line_start > 0) {
        blocks.push(
            paragraph.type.create(paragraph.attrs, paragraph.content.cut(0, line_start - 1)),
        );
    }
    const block_index = blocks.length;
    blocks.push(build(content));
    if (line_end < paragraph.content.size) {
        blocks.push(paragraph.type.create(null, paragraph.content.cut(line_end + 1)));
    }
    const tr = state.tr;
    const start = $pos.before();
    tr.replaceWith(start, $pos.after(), blocks);
    let block_start = start;
    for (const block of blocks.slice(0, block_index)) {
        block_start += block.nodeSize;
    }
    const inside = TextSelection.near(tr.doc.resolve(block_start + 1), 1);
    const offset = $pos.parentOffset - line_start - prefix_length;
    tr.setSelection(
        TextSelection.create(tr.doc, Math.min(inside.from + offset, tr.doc.content.size)),
    );
    return tr;
}

// The Markdown a typed line becomes: a list, a quote or a heading, as
// the same characters would in the textarea.
function typed_block_rules(): InputRule[] {
    const list_rule = (regex: RegExp, ordered: boolean): InputRule =>
        new InputRule(regex, (state, match, _start, end) => {
            const prefix = match.groups!["prefix"]!;
            return replace_line_with_block(state, end, prefix.length - 1, (content) =>
                schema.nodes[ordered ? "ordered_list" : "bullet_list"]!.create(null, [
                    schema.nodes["list_item"]!.create({marker: prefix}, [
                        schema.nodes["paragraph"]!.create(null, content),
                    ]),
                ]),
            );
        });
    return [
        list_rule(BULLET_RE, false),
        list_rule(ORDERED_RE, true),
        new InputRule(QUOTE_RE, (state, _match, _start, end) =>
            replace_line_with_block(state, end, 1, (content) =>
                schema.nodes["blockquote"]!.create({style: "angle"}, [
                    schema.nodes["paragraph"]!.create(null, content),
                ]),
            ),
        ),
        new InputRule(HEADING_RE_TYPED, (state, match, _start, end) => {
            const prefix = match.groups!["prefix"]!;
            return replace_line_with_block(state, end, prefix.length - 1, (content) =>
                schema.nodes["heading"]!.create({level: prefix.trim().length}, content),
            );
        }),
    ];
}

export function markdown_input_rules(context: () => MarkdownContext): Plugin {
    const inline_rule = new InputRule(INLINE_TRIGGER_RE, (state, match, start, end) => {
        if (!state.selection.empty || in_code(state) || state.selection.from !== end) {
            return null;
        }
        // The rule sees the typed text at the end of the match.
        const text = match[0].slice(end - start);
        const marks = state.selection.$from.marks();
        if (marks.some((mark: Mark) => ["code", "math", "link"].includes(mark.type.name))) {
            return null;
        }
        return reparse_with_typed_text(state, end, text, context());
    });
    return inputRules({rules: [...typed_block_rules(), inline_rule]});
}

// Enter after a fence line ("```python", "```quote") starts that block,
// as the same keystrokes would in the textarea. The block is closed,
// like the one the toolbar's code button writes.
export const enter_after_fence: Command = (state, dispatch) => {
    const {$from, empty} = state.selection;
    if (!empty || $from.parent.type.name !== "paragraph") {
        return false;
    }
    const line_start = line_start_offset(state, $from.pos);
    const line = $from.parent.textBetween(
        line_start,
        $from.parentOffset,
        undefined,
        OBJECT_REPLACEMENT,
    );
    const match = FENCE_RE.exec(line);
    if (match === null) {
        return false;
    }
    const fence = match.groups!["fence"]!;
    const lang = (match.groups!["lang"] ?? "").toLowerCase();
    const header = match.groups!["header"] ?? "";
    const info = line.slice(fence.length, line.length - header.length);
    const attrs = {fence, info, close: fence, bodyless: false};
    const tr = replace_line_with_block(
        state,
        $from.pos,
        $from.parentOffset - line_start,
        (content) => {
            if (lang === "quote" || lang === "quoted") {
                return schema.nodes["blockquote"]!.create({...attrs, style: "fence"}, [
                    schema.nodes["paragraph"]!.create(null, content),
                ]);
            }
            if (lang === "spoiler") {
                return schema.nodes["spoiler"]!.create(attrs, [
                    schema.nodes["spoiler_header"]!.create(
                        null,
                        header === "" ? undefined : schema.text(header),
                    ),
                    schema.nodes["paragraph"]!.create(null, content),
                ]);
            }
            const text = content.textBetween(0, content.size, undefined, OBJECT_REPLACEMENT);
            return schema.nodes[lang === "math" ? "math_block" : "code_block"]!.create(
                attrs,
                text === "" ? undefined : schema.text(text),
            );
        },
    );
    if (tr === null) {
        return false;
    }
    if (lang === "spoiler") {
        // The header came from the fence line; typing goes on in the
        // spoiler's content.
        tr.setSelection(TextSelection.create(tr.doc, tr.selection.$from.after() + 1));
    }
    if (dispatch) {
        dispatch(tr.scrollIntoView());
    }
    return true;
};
