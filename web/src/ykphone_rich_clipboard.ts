// What comes in from the clipboard is data, not the editor's own: any
// page can put the composer's chip markup in what it copies. Every node
// of a pasted slice is rebuilt from what it can be checked against —
// a chip from the Markdown it says it holds, a link from an address the
// server would accept, a fenced block from its language alone — and
// what cannot be checked becomes plain text.

import {Fragment, type Mark, type Node as PMNode} from "prosemirror-model";

import {sanitize_href} from "./ykphone_rich_inline.ts";
import {type MarkdownContext, parse_markdown} from "./ykphone_rich_markdown.ts";
import {schema} from "./ykphone_rich_schema.ts";

const CHIPS = new Set([
    "mention",
    "channel_link",
    "emoji",
    "time",
    "upload",
    "call_link",
    "escape",
    "opaque_inline",
]);
const FENCED = new Set(["code_block", "math_block", "blockquote", "spoiler"]);
// eslint-disable-next-line no-control-regex -- control characters are what this matches
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/gu;
const INFO_RE = /^[\w+\-./#]*$/u;
const MARKER_RE = /^ *(?:[*+-]|\d+\.) +$/u;

function sanitize_marks(marks: readonly Mark[]): Mark[] {
    const result: Mark[] = [];
    for (const mark of marks) {
        if (mark.type.name !== "link") {
            result.push(mark);
            continue;
        }
        const href = sanitize_href(String(mark.attrs["href"]));
        if (href !== undefined) {
            result.push(mark.type.create({href}));
        }
    }
    return result;
}

// The chip its Markdown stands for, when that is one chip of the same
// kind; otherwise the Markdown as text.
function sanitize_chip(node: PMNode, ctx: MarkdownContext): PMNode[] {
    const raw = String(node.attrs["raw"]);
    const parsed = parse_markdown(raw, ctx).firstChild;
    const chip =
        parsed?.type.name === "paragraph" && parsed.childCount === 1 ? parsed.firstChild! : null;
    if (chip !== null && chip.type === node.type) {
        return [chip.mark(sanitize_marks(node.marks))];
    }
    return text_nodes(raw, sanitize_marks(node.marks));
}

// Text as text nodes with hard breaks for its newlines.
function text_nodes(text: string, marks: Mark[]): PMNode[] {
    const nodes: PMNode[] = [];
    for (const [index, line] of text.split("\n").entries()) {
        if (index > 0) {
            nodes.push(schema.nodes.hard_break.create());
        }
        if (line !== "") {
            nodes.push(schema.text(line, marks));
        }
    }
    return nodes;
}

function sanitize_node(node: PMNode, ctx: MarkdownContext): PMNode[] {
    if (node.isText) {
        return text_nodes(node.text!.replaceAll(CONTROL_RE, ""), sanitize_marks(node.marks));
    }
    if (CHIPS.has(node.type.name)) {
        return sanitize_chip(node, ctx);
    }
    if (node.type.name === "opaque_block") {
        // Whatever the Markdown is, parsed afresh.
        return children_of_fragment(parse_markdown(String(node.attrs["raw"]), ctx).content);
    }
    const content = sanitize_fragment(node.content, ctx);
    let attrs: Record<string, unknown> = {...node.attrs, sep: null};
    if (node.type.name === "hard_break") {
        attrs = {indent: null};
    } else if (FENCED.has(node.type.name)) {
        const info = String(node.attrs["info"] ?? "");
        attrs = {
            ...attrs,
            fence: null,
            close: null,
            bodyless: false,
            info: node.type.name === "code_block" && INFO_RE.test(info) ? info : null,
        };
        if (node.type.name === "math_block") {
            attrs["info"] = "math";
        }
        if (node.type.name === "code_block" && attrs["info"] === null) {
            attrs["info"] = "";
        }
    } else if (node.type.name === "list_item") {
        const marker: unknown = node.attrs["marker"];
        attrs = {marker: typeof marker === "string" && MARKER_RE.test(marker) ? marker : null};
    } else if (node.type.name === "heading") {
        const level = Number(node.attrs["level"]);
        attrs = {...attrs, level: Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1};
    }
    try {
        return [node.type.createChecked(attrs, content, sanitize_marks(node.marks))];
    } catch {
        // Content the node cannot hold once cleaned; what is left goes
        // where the node was.
        return children_of_fragment(content);
    }
}

function children_of_fragment(fragment: Fragment): PMNode[] {
    const result: PMNode[] = [];
    // eslint-disable-next-line unicorn/no-array-for-each -- a ProseMirror fragment, not an array
    fragment.forEach((child) => {
        result.push(child);
    });
    return result;
}

export function sanitize_fragment(fragment: Fragment, ctx: MarkdownContext): Fragment {
    const nodes: PMNode[] = [];
    // eslint-disable-next-line unicorn/no-array-for-each -- a ProseMirror fragment, not an array
    fragment.forEach((child) => {
        nodes.push(...sanitize_node(child, ctx));
    });
    return Fragment.from(nodes);
}
