// The document schema of the 옆커폰 rich composer.
//
// Every node that stands for Markdown syntax keeps what is needed to
// write that syntax back byte for byte (see ykphone_rich_markdown.ts):
// block nodes remember how many newlines came before them (`sep`), fenced
// blocks their fence lines, list items their marker, and chips (mentions,
// channel links, emoji, times, uploads, calls and anything the editor
// cannot show) the exact Markdown they were made from (`raw`).
//
// The DOM these specs produce is what the clipboard carries between
// editors; the chips' visible rendering is done by node views in
// ykphone_rich_views.ts.

import {
    type Attrs,
    type DOMOutputSpec,
    type Mark,
    type Node as PMNode,
    Schema,
} from "prosemirror-model";

import {sanitize_href} from "./ykphone_rich_inline.ts";

const sep = {default: null};

// Chips carry their attributes as data attributes (data-yk-stream-name
// for stream_name; null attributes are left out), so that a chip copied
// from one editor and pasted into another stays a chip.
function chip_dom(tag: string, node: PMNode, class_name: string): DOMOutputSpec {
    const data: Record<string, string> = {class: class_name};
    for (const [key, value] of Object.entries(node.attrs)) {
        if (value !== null) {
            data["data-yk-" + key.replaceAll("_", "-")] = String(value);
        }
    }
    return [tag, data, node.textContent];
}

// A block's own attributes (its fence, a list item's marker) travel with
// it through the clipboard; `sep`, which says how many blank lines come
// before it, belongs to the document it ends up in.
function block_dom_attrs(node: PMNode): Record<string, string> {
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(node.attrs)) {
        if (value !== null && key !== "sep") {
            data["data-yk-" + key.replaceAll("_", "-")] = String(value);
        }
    }
    return data;
}

function chip_parse_attrs(
    dom: HTMLElement,
    {numbers = [], booleans = []}: {numbers?: string[]; booleans?: string[]} = {},
): Record<string, unknown> {
    const attrs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dom.dataset)) {
        if (key.startsWith("yk") && value !== undefined) {
            const name = key.slice("yk".length).replaceAll(/[A-Z]/gu, (c) => "_" + c.toLowerCase());
            attrs[name.slice(1)] = value;
        }
    }
    for (const key of numbers) {
        if (typeof attrs[key] === "string") {
            attrs[key] = Number(attrs[key]);
        }
    }
    for (const key of booleans) {
        attrs[key] = attrs[key] === "true";
    }
    return attrs;
}

// A node's or mark's attribute that holds a string or null (a fence, a
// marker), as the attribute's type.
export function string_attr(attrs: Attrs, name: string): string | null {
    const value: unknown = attrs[name];
    return typeof value === "string" ? value : null;
}

// The same for an attribute holding a number or null (a separation, a
// code span's backtick count).
export function number_attr(attrs: Attrs, name: string): number | null {
    const value: unknown = attrs[name];
    return typeof value === "number" ? value : null;
}

export const schema = new Schema({
    nodes: {
        doc: {content: "block+"},
        paragraph: {
            content: "inline*",
            group: "block",
            attrs: {sep},
            parseDOM: [{tag: "p"}],
            toDOM: () => ["p", 0],
        },
        heading: {
            content: "inline*",
            group: "block",
            defining: true,
            attrs: {sep, level: {default: 1}},
            parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({tag: `h${level}`, attrs: {level}})),
            toDOM: (node) => [`h${node.attrs["level"]}`, 0],
        },
        blockquote: {
            content: "block+",
            group: "block",
            defining: true,
            // style "fence" is ```quote, "angle" is lines starting with "> ".
            attrs: {
                sep,
                style: {default: "fence"},
                fence: {default: null},
                info: {default: null},
                close: {default: null},
                bodyless: {default: false},
            },
            parseDOM: [
                {
                    tag: "blockquote",
                    getAttrs: (dom) => chip_parse_attrs(dom, {booleans: ["bodyless"]}),
                },
            ],
            toDOM: (node) => ["blockquote", block_dom_attrs(node), 0],
        },
        spoiler: {
            content: "spoiler_header block+",
            group: "block",
            defining: true,
            isolating: true,
            attrs: {
                sep,
                fence: {default: null},
                info: {default: null},
                close: {default: null},
                bodyless: {default: false},
            },
            parseDOM: [
                {
                    tag: "div.ykphone-rich-spoiler",
                    getAttrs: (dom) => chip_parse_attrs(dom, {booleans: ["bodyless"]}),
                },
            ],
            toDOM: (node) => ["div", {class: "ykphone-rich-spoiler", ...block_dom_attrs(node)}, 0],
        },
        spoiler_header: {
            content: "inline*",
            defining: true,
            parseDOM: [{tag: "div.ykphone-rich-spoiler-header"}],
            toDOM: () => ["div", {class: "ykphone-rich-spoiler-header"}, 0],
        },
        code_block: {
            content: "text*",
            marks: "",
            group: "block",
            code: true,
            defining: true,
            attrs: {
                sep,
                fence: {default: null},
                info: {default: ""},
                close: {default: null},
                bodyless: {default: false},
            },
            parseDOM: [
                {
                    tag: "pre",
                    preserveWhitespace: "full",
                    getAttrs: (dom) => chip_parse_attrs(dom, {booleans: ["bodyless"]}),
                },
            ],
            toDOM: (node) => ["pre", block_dom_attrs(node), ["code", 0]],
        },
        math_block: {
            content: "text*",
            marks: "",
            group: "block",
            code: true,
            defining: true,
            attrs: {
                sep,
                fence: {default: null},
                info: {default: "math"},
                close: {default: null},
                bodyless: {default: false},
            },
            parseDOM: [
                {
                    tag: "pre.ykphone-rich-math",
                    preserveWhitespace: "full",
                    priority: 60,
                    getAttrs: (dom) => chip_parse_attrs(dom, {booleans: ["bodyless"]}),
                },
            ],
            toDOM: (node) => [
                "pre",
                {class: "ykphone-rich-math", ...block_dom_attrs(node)},
                ["code", 0],
            ],
        },
        bullet_list: {
            content: "list_item+",
            group: "block",
            attrs: {sep},
            parseDOM: [{tag: "ul"}],
            toDOM: () => ["ul", 0],
        },
        ordered_list: {
            content: "list_item+",
            group: "block",
            attrs: {sep},
            parseDOM: [{tag: "ol"}],
            toDOM: () => ["ol", 0],
        },
        list_item: {
            content: "paragraph (bullet_list | ordered_list)*",
            defining: true,
            // The item's Markdown prefix, indentation included ("- ", "  1. ").
            attrs: {marker: {default: null}},
            parseDOM: [{tag: "li", getAttrs: (dom) => chip_parse_attrs(dom)}],
            toDOM: (node) => ["li", block_dom_attrs(node), 0],
        },
        // Block Markdown the editor does not show as editable content
        // (tables, polls, indented code…); written back as it was.
        opaque_block: {
            group: "block",
            atom: true,
            selectable: true,
            attrs: {sep, raw: {default: ""}, kind: {default: "block"}},
            parseDOM: [
                {
                    tag: "div[data-yk-raw]",
                    getAttrs: (dom) => chip_parse_attrs(dom, {numbers: ["sep"]}),
                },
            ],
            toDOM: (node) => chip_dom("div", node, "ykphone-rich-opaque-block"),
        },
        text: {group: "inline"},
        hard_break: {
            inline: true,
            group: "inline",
            selectable: false,
            // Spaces before a continuation line of a list item, as they
            // were in the Markdown; null for a break the editor made.
            attrs: {indent: {default: null}},
            parseDOM: [{tag: "br"}],
            toDOM: () => ["br"],
            leafText: () => "\n",
        },
        // A character written as an HTML entity (&#42;) so that it is
        // not read as syntax.
        escape: {
            inline: true,
            group: "inline",
            atom: true,
            attrs: {raw: {default: ""}, char: {default: ""}},
            parseDOM: [{tag: "span.ykphone-rich-escape", getAttrs: (dom) => chip_parse_attrs(dom)}],
            toDOM: (node) => chip_dom("span", node, "ykphone-rich-escape"),
            leafText: (node) => String(node.attrs["char"]),
        },
        mention: {
            inline: true,
            group: "inline",
            atom: true,
            // kind: user | group; wildcard mentions are users named
            // all/everyone/channel/stream/topic.
            attrs: {
                raw: {default: ""},
                kind: {default: "user"},
                silent: {default: false},
                name: {default: ""},
            },
            parseDOM: [
                {
                    tag: "span.ykphone-rich-mention",
                    getAttrs: (dom) => chip_parse_attrs(dom, {booleans: ["silent"]}),
                },
            ],
            toDOM: (node) => chip_dom("span", node, "ykphone-rich-mention"),
            leafText: (node) => String(node.attrs["raw"]),
        },
        channel_link: {
            inline: true,
            group: "inline",
            atom: true,
            attrs: {
                raw: {default: ""},
                stream_name: {default: ""},
                topic: {default: null},
                message_id: {default: null},
            },
            parseDOM: [
                {tag: "span.ykphone-rich-channel", getAttrs: (dom) => chip_parse_attrs(dom)},
            ],
            toDOM: (node) => chip_dom("span", node, "ykphone-rich-channel"),
            leafText: (node) => String(node.attrs["raw"]),
        },
        emoji: {
            inline: true,
            group: "inline",
            atom: true,
            attrs: {raw: {default: ""}, name: {default: ""}},
            parseDOM: [{tag: "span.ykphone-rich-emoji", getAttrs: (dom) => chip_parse_attrs(dom)}],
            toDOM: (node) => chip_dom("span", node, "ykphone-rich-emoji"),
            leafText: (node) => String(node.attrs["raw"]),
        },
        time: {
            inline: true,
            group: "inline",
            atom: true,
            attrs: {raw: {default: ""}, time: {default: ""}},
            parseDOM: [{tag: "span.ykphone-rich-time", getAttrs: (dom) => chip_parse_attrs(dom)}],
            toDOM: (node) => chip_dom("span", node, "ykphone-rich-time"),
            leafText: (node) => String(node.attrs["raw"]),
        },
        // An uploaded file ([name](/user_uploads/…)), image or audio
        // (![name](/user_uploads/…)), or the "[Uploading …]()" placeholder
        // while it is on its way (url "").
        upload: {
            inline: true,
            group: "inline",
            atom: true,
            attrs: {
                raw: {default: ""},
                name: {default: ""},
                url: {default: ""},
                embedded: {default: false},
            },
            parseDOM: [
                {
                    tag: "span.ykphone-rich-upload",
                    getAttrs: (dom) => chip_parse_attrs(dom, {booleans: ["embedded"]}),
                },
            ],
            toDOM: (node) => chip_dom("span", node, "ykphone-rich-upload"),
            leafText: (node) => String(node.attrs["raw"]),
        },
        // A video or voice call link from the compose buttons.
        call_link: {
            inline: true,
            group: "inline",
            atom: true,
            attrs: {
                raw: {default: ""},
                kind: {default: "video"},
                label: {default: ""},
                url: {default: ""},
            },
            parseDOM: [{tag: "span.ykphone-rich-call", getAttrs: (dom) => chip_parse_attrs(dom)}],
            toDOM: (node) => chip_dom("span", node, "ykphone-rich-call"),
            leafText: (node) => String(node.attrs["raw"]),
        },
        // Inline Markdown the editor does not show as editable content.
        opaque_inline: {
            inline: true,
            group: "inline",
            atom: true,
            attrs: {raw: {default: ""}},
            parseDOM: [{tag: "span.ykphone-rich-opaque", getAttrs: (dom) => chip_parse_attrs(dom)}],
            toDOM: (node) => chip_dom("span", node, "ykphone-rich-opaque"),
            leafText: (node) => String(node.attrs["raw"]),
        },
    },
    // The order is the nesting order when written as Markdown: strong
    // outermost, then em, strike, and link, code or math innermost —
    // Zulip allows no formatting inside link text, code or math.
    marks: {
        strong: {
            parseDOM: [
                {tag: "strong"},
                {
                    tag: "b",
                    getAttrs: (node) => node.style.fontWeight !== "normal" && null,
                },
                {
                    style: "font-weight=400",
                    clearMark: (m: Mark) => m.type.name === "strong",
                },
                {
                    style: "font-weight",
                    getAttrs: (value) => /^(?:bold(?:er)?|[5-9]\d{2})$/u.test(value) && null,
                },
            ],
            toDOM: () => ["strong", 0],
        },
        em: {
            parseDOM: [{tag: "i"}, {tag: "em"}, {style: "font-style=italic"}],
            toDOM: () => ["em", 0],
        },
        strike: {
            parseDOM: [
                {tag: "s"},
                {tag: "del"},
                {tag: "strike"},
                {style: "text-decoration=line-through"},
            ],
            toDOM: () => ["s", 0],
        },
        link: {
            attrs: {href: {}},
            inclusive: false,
            excludes: "code math",
            parseDOM: [
                {
                    tag: "a[href]",
                    // An address the server would refuse is no link.
                    getAttrs(dom) {
                        const href = sanitize_href(dom.getAttribute("href")!);
                        return href === undefined ? false : {href};
                    },
                },
            ],
            toDOM: (mark) => [
                "a",
                {href: String(mark.attrs["href"]), rel: "noopener noreferrer"},
                0,
            ],
        },
        code: {
            // The number of backticks around the span, when it came from
            // Markdown; null lets the serialiser choose.
            attrs: {ticks: {default: null}},
            excludes: "link math",
            parseDOM: [{tag: "code"}],
            toDOM: () => ["code", 0],
        },
        math: {
            excludes: "link code",
            parseDOM: [{tag: "span.ykphone-rich-math-inline"}],
            toDOM: () => ["span", {class: "ykphone-rich-math-inline"}, 0],
        },
    },
});
