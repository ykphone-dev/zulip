// The 옆커폰 rich composer: an editor in place of the compose textarea
// that shows formatting and chips instead of Markdown syntax.
//
// The textarea stays in the page, invisible under the editor, and holds
// the message as Markdown for everything upstream does with it
// (ykphone_rich_sync.ts keeps the two in step). This module is the
// editor's DOM side: mounting it, drawing chips, keyboard handling that
// defers to upstream where upstream decides (Enter sending, Tab to the
// send button, formatting shortcuts), focus, paste, the link form, and
// mirroring the textarea's placeholder, state classes and height limit.
//
// Upstream code reaches the editor through ykphone_rich_hooks.ts.

import isUrl from "is-url";
import $ from "jquery";
import {baseKeymap} from "prosemirror-commands";
import {history, redo, undo} from "prosemirror-history";
import {undoInputRule} from "prosemirror-inputrules";
import {keymap} from "prosemirror-keymap";
import {DOMParser, DOMSerializer, Fragment, type Node as PMNode, Slice} from "prosemirror-model";
import {type Command, EditorState, Plugin, TextSelection} from "prosemirror-state";
import {Decoration, DecorationSet, EditorView, type NodeView} from "prosemirror-view";
import * as tippy from "tippy.js";

import render_ykphone_rich_chip from "../templates/ykphone_rich_chip.hbs";
import render_ykphone_rich_link_bubble from "../templates/ykphone_rich_link_bubble.hbs";
import render_ykphone_rich_link_popover from "../templates/ykphone_rich_link_popover.hbs";
import render_ykphone_rich_widget_card from "../templates/ykphone_rich_widget_card.hbs";

import * as blueslip from "./blueslip.ts";
import * as channel from "./channel.ts";
import * as compose_banner from "./compose_banner.ts";
import * as compose_paste from "./compose_paste.ts";
import * as compose_ui from "./compose_ui.ts";
import * as compose_validate from "./compose_validate.ts";
import * as composebox_typeahead from "./composebox_typeahead.ts";
import * as emoji from "./emoji.ts";
import {$t} from "./i18n.ts";
import * as markdown from "./markdown.ts";
import * as people from "./people.ts";
import {postprocess_content} from "./postprocess_content.ts";
import * as rendered_markdown from "./rendered_markdown.ts";
import * as rtl from "./rtl.ts";
import * as stream_data from "./stream_data.ts";
import * as upload from "./upload.ts";
import * as user_groups from "./user_groups.ts";
import * as util from "./util.ts";
import {sanitize_fragment} from "./ykphone_rich_clipboard.ts";
import * as ykphone_rich_commands from "./ykphone_rich_commands.ts";
import * as ykphone_rich_hooks from "./ykphone_rich_hooks.ts";
import {is_allowed_url} from "./ykphone_rich_inline.ts";
import type {MarkdownContext} from "./ykphone_rich_markdown.ts";
import {offset_to_pos, parse_markdown} from "./ykphone_rich_markdown.ts";
import {schema} from "./ykphone_rich_schema.ts";
import {type ComposeSync, create_sync, serialize_cached} from "./ykphone_rich_sync.ts";
import * as ykphone_rich_typeahead from "./ykphone_rich_typeahead.ts";

const WILDCARD_MENTIONS = new Set(["all", "everyone", "stream", "channel", "topic"]);
// Classes upstream puts on the textarea that change how the box looks.
const MIRRORED_CLASSES = [
    "invalid",
    "textarea-over-limit",
    "textarea-approaching-limit",
    "flash",
    "rtl",
];

let view: EditorView | undefined;
let sync: ComposeSync | undefined;
let textarea: HTMLTextAreaElement | undefined;
let context: MarkdownContext | undefined;
let shift_pressed = false;
let link_popover: tippy.Instance | undefined;
let link_bubble: tippy.Instance | undefined;
let bubble_link: {href: string; from: number; to: number} | undefined;

// ---- Server data for the Markdown grammar ----

function make_context(): MarkdownContext {
    return {
        is_user_mention(name) {
            if (WILDCARD_MENTIONS.has(name)) {
                return true;
            }
            const with_id = /^(?<full_name>.*)\|(?<id>\d+)$/u.exec(name);
            if (with_id !== null) {
                const user = people.maybe_get_user_by_id(Number(with_id.groups!["id"]), true);
                const full_name = with_id.groups!["full_name"]!;
                return user !== undefined && (full_name === "" || user.full_name === full_name);
            }
            return people.get_user_id_from_name(name) !== undefined;
        },
        is_group_mention: (name) => user_groups.get_user_group_from_name(name) !== undefined,
        is_stream: (name) => stream_data.get_sub(name) !== undefined,
        is_emoji: (name) =>
            name === "zulip" ||
            emoji.active_realm_emojis.has(name) ||
            emoji.get_emoji_codepoint(name) !== undefined,
        video_call_label: $t({defaultMessage: "Join video call."}),
        audio_call_label: $t({defaultMessage: "Join voice call."}),
    };
}

// ---- Chips ----

type ChipData = {
    class_name: string;
    text?: string;
    icon?: string;
    emoji_code?: string;
    image_url?: string;
    title?: string;
};

function chip_element(data: ChipData): HTMLElement {
    const element = util.the($(render_ykphone_rich_chip(data)));
    element.contentEditable = "false";
    return element;
}

const IMAGE_EXTENSION_RE = /\.(?:avif|bmp|gif|jpe?g|png|webp|heic)$/iu;

function upload_chip(node: PMNode): ChipData {
    const name = String(node.attrs["name"]);
    const url = String(node.attrs["url"]);
    if (url === "") {
        return {class_name: "ykphone-rich-upload uploading", icon: "loader-circle", text: name};
    }
    if (node.attrs["embedded"] === true && IMAGE_EXTENSION_RE.test(url)) {
        return {class_name: "ykphone-rich-upload image", image_url: url, text: name, title: name};
    }
    return {class_name: "ykphone-rich-upload", icon: "attachment", text: name, title: name};
}

function render_chip(node: PMNode): HTMLElement {
    switch (node.type.name) {
        case "upload":
            return chip_element(upload_chip(node));
        case "call_link":
            return chip_element({
                class_name: "ykphone-rich-call",
                icon: node.attrs["kind"] === "audio" ? "voice-call" : "video-call",
                text: String(node.attrs["label"]).replace(/\.$/u, ""),
                title: String(node.attrs["url"]),
            });
        case "escape": {
            const element = document.createElement("span");
            element.className = "ykphone-rich-escape";
            element.contentEditable = "false";
            element.textContent = String(node.attrs["char"]);
            return element;
        }
        default: {
            // Mentions, channel links, emoji, times and anything else kept
            // as Markdown look exactly as they will in the message.
            const element = document.createElement("span");
            element.className = `ykphone-rich-chip ykphone-rich-${node.type.name.replaceAll("_", "-")}`;
            element.contentEditable = "false";
            show_rendered(element, String(node.attrs["raw"]), true);
            return element;
        }
    }
}

const rendered_cache = new Map<string, string>();

// Shows Markdown the editor keeps as it is, rendered the way the message
// will look: by the web app's Markdown processor, or by the server for
// syntax only it knows.
function show_rendered(element: HTMLElement, raw: string, inline: boolean): void {
    const fill = (html: string): void => {
        element.innerHTML = postprocess_content(html);
        const only_child = element.firstElementChild;
        if (inline && element.childNodes.length === 1 && only_child?.tagName === "P") {
            // An inline chip holds the paragraph's contents, not the
            // paragraph.
            only_child.replaceWith(...only_child.childNodes);
        }
        rendered_markdown.update_elements($(element));
    };
    const cached = rendered_cache.get(raw);
    if (cached !== undefined) {
        fill(cached);
        return;
    }
    if (!markdown.contains_backend_only_syntax(raw)) {
        const html = markdown.render(raw).content;
        rendered_cache.set(raw, html);
        fill(html);
        return;
    }
    element.textContent = raw;
    void channel.post({
        url: "/json/messages/render",
        data: {content: raw},
        success(response) {
            const html = (response as {rendered: string}).rendered;
            rendered_cache.set(raw, html);
            fill(html);
        },
    });
}

class ChipView implements NodeView {
    dom: HTMLElement;
    node: PMNode;

    constructor(node: PMNode) {
        this.node = node;
        this.dom = render_chip(node);
    }

    update(node: PMNode): boolean {
        return node.sameMarkup(this.node);
    }

    ignoreMutation(): boolean {
        return true;
    }
}

function widget_card(raw: string): HTMLElement {
    const [first_line = "", ...rest] = raw.split("\n");
    const is_poll = first_line.startsWith("/poll");
    const title = first_line.replace(/^\/(?:poll|todo)\s*/u, "");
    const items = rest.map((line) => line.trim()).filter((line) => line !== "");
    const element = util.the(
        $(
            render_ykphone_rich_widget_card({
                icon: is_poll ? "poll" : "todo-list",
                kind_label: is_poll
                    ? $t({defaultMessage: "Poll"})
                    : $t({defaultMessage: "To-do list"}),
                title: title === "" && !is_poll ? $t({defaultMessage: "Task list"}) : title,
                items,
                has_items: items.length > 0,
            }),
        ),
    );
    return element;
}

class OpaqueBlockView implements NodeView {
    dom: HTMLElement;
    node: PMNode;

    constructor(node: PMNode) {
        this.node = node;
        this.dom = document.createElement("div");
        this.dom.className = "ykphone-rich-opaque-block";
        this.dom.contentEditable = "false";
        const raw = String(node.attrs["raw"]);
        if (node.attrs["kind"] === "widget") {
            this.dom.append(widget_card(raw));
        } else {
            const content = document.createElement("div");
            content.className = "rendered_markdown";
            show_rendered(content, raw, false);
            this.dom.append(content);
        }
    }

    update(node: PMNode): boolean {
        return node.sameMarkup(this.node);
    }

    ignoreMutation(): boolean {
        return true;
    }
}

// Code and math blocks: the text is edited in place, under a label.
class CodeBlockView implements NodeView {
    dom: HTMLElement;
    contentDOM: HTMLElement;
    label: HTMLElement;
    node: PMNode;

    constructor(node: PMNode) {
        this.node = node;
        this.dom = document.createElement("div");
        this.dom.className = `ykphone-rich-code-block ${node.type.name === "math_block" ? "math" : ""}`;
        this.label = document.createElement("div");
        this.label.className = "ykphone-rich-code-label";
        this.label.contentEditable = "false";
        const pre = document.createElement("pre");
        this.contentDOM = document.createElement("code");
        pre.append(this.contentDOM);
        this.dom.append(this.label, pre);
        this.set_label(node);
    }

    set_label(node: PMNode): void {
        if (node.type.name === "math_block") {
            this.label.textContent = $t({defaultMessage: "Math (LaTeX)"});
            return;
        }
        const language = /^[ {.]*(?<lang>[\w+\-./#]*)/u.exec(String(node.attrs["info"]))!.groups![
            "lang"
        ]!;
        this.label.textContent = language === "" ? $t({defaultMessage: "Code"}) : language;
    }

    update(node: PMNode): boolean {
        if (node.type !== this.node.type) {
            return false;
        }
        this.node = node;
        this.set_label(node);
        return true;
    }

    ignoreMutation(mutation: ViewMutationRecord): boolean {
        return !this.contentDOM.contains(mutation.target);
    }
}

type ViewMutationRecord = MutationRecord | {type: "selection"; target: DOMNode};
type DOMNode = globalThis.Node;

class SpoilerView implements NodeView {
    dom: HTMLElement;
    contentDOM: HTMLElement;

    constructor() {
        this.dom = document.createElement("div");
        this.dom.className = "ykphone-rich-spoiler";
        const label = document.createElement("div");
        label.className = "ykphone-rich-spoiler-label";
        label.contentEditable = "false";
        label.textContent = $t({defaultMessage: "Spoiler"});
        this.contentDOM = document.createElement("div");
        this.contentDOM.className = "ykphone-rich-spoiler-content";
        this.dom.append(label, this.contentDOM);
    }

    ignoreMutation(mutation: ViewMutationRecord): boolean {
        return !this.contentDOM.contains(mutation.target);
    }
}

// Numbered lists start at their first item's number, as rendered.
class OrderedListView implements NodeView {
    dom: HTMLOListElement;
    contentDOM: HTMLOListElement;
    node: PMNode;

    constructor(node: PMNode) {
        this.node = node;
        this.dom = document.createElement("ol");
        this.contentDOM = this.dom;
        this.set_start(node);
    }

    set_start(node: PMNode): void {
        const marker = String(node.firstChild?.attrs["marker"] ?? "1.");
        this.dom.start = Number(/\d+/u.exec(marker)?.[0] ?? "1");
    }

    update(node: PMNode): boolean {
        if (node.type !== this.node.type) {
            return false;
        }
        this.node = node;
        this.set_start(node);
        return true;
    }
}

// ---- Placeholder ----

function placeholder_plugin(): Plugin {
    return new Plugin({
        props: {
            decorations(state) {
                const decorations: Decoration[] = [];
                const doc = state.doc;
                const first = doc.firstChild!;
                if (
                    doc.childCount === 1 &&
                    first.type.name === "paragraph" &&
                    first.content.size === 0
                ) {
                    decorations.push(
                        Decoration.node(0, first.nodeSize, {
                            class: "ykphone-rich-empty",
                            "data-placeholder": textarea?.placeholder ?? "",
                        }),
                    );
                }
                doc.descendants((node, pos) => {
                    if (node.type.name === "spoiler_header" && node.content.size === 0) {
                        decorations.push(
                            Decoration.node(pos, pos + node.nodeSize, {
                                class: "ykphone-rich-empty",
                                "data-placeholder": $t({defaultMessage: "Header"}),
                            }),
                        );
                    }
                    return node.isBlock;
                });
                return DecorationSet.create(doc, decorations);
            },
        },
    });
}

// ---- Pasting HTML ----

// Zulip's own rendered message HTML, pasted from a message, becomes
// chips: mentions, channel links, emoji, times and math are swapped for
// the chip markup the schema reads, built from the Markdown they came
// from. Everything else is read with the schema's rules (bold, italic,
// links, lists, quotes, code), and its text stays text.
function prepare_pasted_html(body: HTMLElement): void {
    const serializer = DOMSerializer.fromSchema(schema);
    const replace_with_markdown = (element: Element, raw: string): void => {
        const paragraph = parse_markdown(raw, context!).firstChild;
        if (paragraph?.type.name !== "paragraph" || paragraph.childCount === 0) {
            element.replaceWith(element.textContent ?? "");
            return;
        }
        element.replaceWith(serializer.serializeFragment(paragraph.content, {document}));
    };
    for (const element of body.querySelectorAll(
        ".message_inline_image, .message_embed, .message_inline_video, .copy_codeblock, .code_external_link, img, video, audio",
    )) {
        element.remove();
    }
    for (const element of body.querySelectorAll<HTMLElement>(
        "span.user-mention, span.topic-mention",
    )) {
        const silent = element.classList.contains("silent");
        const text = (element.textContent ?? "").replace(/^@/u, "");
        const user_id = Number(element.dataset["userId"]);
        const user = Number.isNaN(user_id) ? undefined : people.maybe_get_user_by_id(user_id, true);
        replace_with_markdown(
            element,
            user === undefined
                ? `@${silent ? "_" : ""}**${text}**`
                : people.get_mention_syntax(user.full_name, user.user_id, silent),
        );
    }
    for (const element of body.querySelectorAll<HTMLElement>("span.user-group-mention")) {
        const silent = element.classList.contains("silent");
        const group = user_groups.maybe_get_user_group_from_id(
            Number(element.dataset["userGroupId"]),
        );
        const name = group?.name ?? (element.textContent ?? "").replace(/^@/u, "");
        replace_with_markdown(element, `@${silent ? "_" : ""}*${name}*`);
    }
    for (const element of body.querySelectorAll<HTMLAnchorElement>(
        "a.stream, a.stream-topic, a.message-link",
    )) {
        const syntax = compose_paste.try_stream_topic_syntax_text(element.href);
        if (syntax !== null) {
            replace_with_markdown(element, syntax);
        }
    }
    for (const element of body.querySelectorAll("span.emoji, img.emoji")) {
        const name = (
            element.getAttribute("title") ??
            element.getAttribute("aria-label") ??
            element.getAttribute("alt") ??
            ""
        ).replaceAll(":", "");
        replace_with_markdown(element, `:${name.replaceAll(" ", "_")}:`);
    }
    for (const element of body.querySelectorAll("time[datetime]")) {
        replace_with_markdown(element, `<time:${element.getAttribute("datetime")}>`);
    }
    for (const element of body.querySelectorAll("span.katex")) {
        const math = document.createElement("span");
        math.className = "ykphone-rich-math-inline";
        math.textContent =
            element.querySelector("annotation[encoding='application/x-tex']")?.textContent ?? "";
        element.replaceWith(math);
    }
}

// Whatever the clipboard claimed the slice was, its nodes are rebuilt
// from what can be checked (ykphone_rich_clipboard.ts).
function checked_slice(slice: Slice): Slice {
    return new Slice(sanitize_fragment(slice.content, context!), slice.openStart, slice.openEnd);
}

// ---- Inserting ----

// Text as lines: line breaks between them, except in a spoiler's header,
// which is one line. Control characters are left out.
function text_slice(text: string, state: EditorState): Slice {
    const in_header = state.selection.$from.parent.type.name === "spoiler_header";
    const clean = text.replaceAll(/[\x00-\x08\x0B-\x1F\x7F]/gu, "");
    const nodes: PMNode[] = [];
    for (const [index, line] of clean.split(/\r?\n/u).entries()) {
        if (index > 0 && !in_header) {
            nodes.push(schema.nodes["hard_break"]!.create());
        }
        const piece = in_header && index > 0 ? " " + line : line;
        if (piece !== "") {
            nodes.push(schema.text(piece));
        }
    }
    return new Slice(Fragment.from(nodes), 0, 0);
}

function insert_literal_text(text: string): void {
    const state = view!.state;
    view!.dispatch(state.tr.replaceSelection(text_slice(text, state)).scrollIntoView());
}

function insert_markdown(markdown_text: string): void {
    sync!.insert_text(markdown_text, false, true);
}

function handle_paste(editor: EditorView, event: ClipboardEvent): boolean {
    const data = event.clipboardData;
    if (data === null) {
        return false;
    }
    if ([...data.items].some((item) => item.kind === "file")) {
        // upload.ts takes pasted files from #compose.
        return true;
    }
    const html = data.getData("text/html");
    const text = data.getData("text/plain");
    if (html.includes("data-pm-slice")) {
        // From an editor like this one: the schema knows its HTML, and
        // transformPasted checks what it read.
        return false;
    }
    if (text.length >= compose_paste.MINIMUM_PASTE_SIZE_FOR_FILE_TREATMENT) {
        const existing = sync!.markdown();
        const avoid_direct_paste =
            text.length >= compose_paste.MINIMUM_PASTE_SIZE_TO_AVOID_DIRECT_PASTE;
        const filename = `${$t({defaultMessage: "PastedText"})}.txt`;
        const $banner = compose_banner.show_convert_pasted_text_to_file_banner({
            show_paste_button: avoid_direct_paste,
            convert_to_file_cb() {
                sync!.set_markdown(existing, existing.length);
                upload.upload_pasted_file(
                    textarea!,
                    new File([new Blob([text], {type: "text/plain"})], filename, {
                        type: "text/plain",
                    }),
                );
            },
            paste_to_compose_cb() {
                insert_literal_text(text);
            },
            $textarea: $(textarea!),
        });
        setTimeout(() => {
            $(textarea!).one("input", () => {
                $banner.remove();
            });
        }, 0);
        if (avoid_direct_paste) {
            return true;
        }
    }
    if (ykphone_rich_commands.in_code(editor.state)) {
        insert_literal_text(text);
        return true;
    }
    const trimmed = text.trim();
    if (isUrl(trimmed)) {
        if (!editor.state.selection.empty && !shift_pressed) {
            return ykphone_rich_commands.apply_link(trimmed)(editor.state, editor.dispatch);
        }
        const syntax = shift_pressed ? null : compose_paste.try_stream_topic_syntax_text(trimmed);
        const reverse = shift_pressed ? null : compose_ui.reverse_linkify_text(trimmed);
        if (syntax !== null || reverse !== null) {
            insert_markdown(syntax === null ? reverse! : syntax + " ");
            return true;
        }
    }
    if (html !== "" && !shift_pressed && !compose_paste.is_single_image(html)) {
        const body = new window.DOMParser().parseFromString(
            compose_paste.maybe_transform_html(html, text),
            "text/html",
        ).body;
        prepare_pasted_html(body);
        const slice = DOMParser.fromSchema(schema).parseSlice(body, {preserveWhitespace: false});
        editor.dispatch(editor.state.tr.replaceSelection(checked_slice(slice)).scrollIntoView());
        return true;
    }
    insert_literal_text(text);
    return true;
}

// What a click inside the composer must not reach upstream's handlers.
const CHIP_SELECTORS = [
    ".ykphone-rich-mention",
    ".ykphone-rich-channel",
    ".ykphone-rich-emoji",
    ".ykphone-rich-time",
    ".ykphone-rich-upload",
    ".ykphone-rich-call",
    ".ykphone-rich-opaque",
    ".ykphone-rich-opaque-block",
    ".ykphone-rich-widget-card",
].join(", ");

// ---- The link the cursor is in ----

function close_link_bubble(): void {
    link_bubble?.reference.remove();
    link_bubble?.destroy();
    link_bubble = undefined;
    bubble_link = undefined;
}

// Clicking a link only puts the cursor in it, as clicking text does.
// What offers to open, change or remove it is a small bubble over the
// link the cursor is in, the way Slack shows one. Its buttons take no
// focus and no selection: mousedown is prevented, so the cursor stays
// where the user put it.
function update_link_bubble(): void {
    const editor = view;
    const link =
        editor !== undefined && editor.hasFocus() && editor.state.selection.empty
            ? ykphone_rich_commands.link_at_selection(editor.state)
            : undefined;
    if (editor === undefined || link === undefined || link_popover !== undefined) {
        close_link_bubble();
        return;
    }
    if (
        bubble_link?.href === link.href &&
        bubble_link.from === link.from &&
        bubble_link.to === link.to
    ) {
        link_bubble?.popperInstance?.update();
        return;
    }
    close_link_bubble();
    bubble_link = link;
    const $bubble = $(render_ykphone_rich_link_bubble({href: link.href}));
    const anchor = document.createElement("span");
    anchor.className = "ykphone-rich-link-anchor";
    document.body.append(anchor);
    link_bubble = tippy.default(anchor, {
        getReferenceClientRect() {
            const start = editor.coordsAtPos(link.from);
            const end = editor.coordsAtPos(link.to);
            // Over the compose box rather than over the link, so that
            // the formatting buttons between the text being written and
            // the message list stay clickable.
            const box = (editor.dom.closest("#compose") ?? editor.dom).getBoundingClientRect();
            const top = Math.min(start.top, box.top);
            return new DOMRect(
                start.left,
                top,
                Math.max(end.right - start.left, 1),
                Math.max(start.bottom - top, 1),
            );
        },
        content: util.the($bubble),
        placement: "top-start",
        trigger: "manual",
        interactive: true,
        hideOnClick: false,
        arrow: false,
        theme: "popover-menu",
        appendTo: () => document.body,
    });
    link_bubble.show();
    $bubble.on("mousedown", (e) => {
        e.preventDefault();
    });
    $bubble.on("click", ".ykphone-rich-link-open", () => {
        if (is_allowed_url(link.href)) {
            window.open(link.href, "_blank", "noopener,noreferrer");
        }
    });
    $bubble.on("click", ".ykphone-rich-link-edit", () => {
        open_link_popover(link.from);
    });
    $bubble.on("click", ".ykphone-rich-link-drop", () => {
        close_link_bubble();
        editor.focus();
        ykphone_rich_commands.remove_link(editor.state, editor.dispatch);
    });
}

// ---- The link form ----

function close_link_popover(): void {
    link_popover?.reference.remove();
    link_popover?.destroy();
    link_popover = undefined;
}

export function open_link_popover(at?: number): void {
    if (view === undefined || ykphone_rich_commands.in_code(view.state)) {
        return;
    }
    close_link_popover();
    close_link_bubble();
    const editor = view;
    const existing = ykphone_rich_commands.link_at_selection(editor.state, at);
    if (existing !== undefined) {
        // Editing a link works on the whole link.
        editor.dispatch(
            editor.state.tr.setSelection(
                TextSelection.create(editor.state.doc, existing.from, existing.to),
            ),
        );
    }
    const {from, to, empty} = editor.state.selection;
    const show_text = empty && existing === undefined;
    const $form = $(
        render_ykphone_rich_link_popover({
            show_text,
            text: "",
            href: existing?.href ?? "",
        }),
    );
    const $text = $form.find<HTMLInputElement>(".ykphone-rich-link-text");
    const $url = $form.find<HTMLInputElement>(".ykphone-rich-link-url");
    const start = editor.coordsAtPos(from);
    const end = editor.coordsAtPos(to);
    const anchor = document.createElement("span");
    anchor.className = "ykphone-rich-link-anchor";
    document.body.append(anchor);
    link_popover = tippy.default(anchor, {
        getReferenceClientRect: () =>
            new DOMRect(
                start.left,
                start.top,
                Math.max(end.right - start.left, 1),
                end.bottom - start.top,
            ),
        content: util.the($form),
        placement: "top-start",
        trigger: "manual",
        interactive: true,
        arrow: false,
        theme: "popover-menu",
        appendTo: () => document.body,
        onClickOutside() {
            close_link_popover();
        },
        onMount() {
            (show_text ? $text : $url).trigger("focus");
        },
    });
    link_popover.show();

    // The editor gets the focus back before the form goes, so that the
    // form's removal cannot leave the focus on the page itself.
    const finish = (command?: Command): void => {
        editor.focus();
        close_link_popover();
        if (command !== undefined) {
            command(editor.state, editor.dispatch);
            editor.focus();
        }
    };
    const submit = (): void => {
        const result = ykphone_rich_commands.link_form_submission(
            show_text ? ($text.val() ?? "") : undefined,
            $url.val() ?? "",
        );
        if (result === undefined) {
            // Nothing that is a link yet: the link field is where it goes.
            $url.trigger("focus");
            return;
        }
        finish(ykphone_rich_commands.apply_link(result.href, result.text));
    };
    $form.on("submit", (e) => {
        e.preventDefault();
        submit();
    });
    $form.on("keydown", "input", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            submit();
        }
    });
    $form.on("click", ".ykphone-rich-link-remove", (e) => {
        e.preventDefault();
        finish(ykphone_rich_commands.remove_link);
    });
    $form.on("keydown", (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish();
        }
    });
}

// ---- Sending ----

// Why the message cannot be sent as shown, if it cannot: the document
// holds formatting Zulip's Markdown cannot carry to the server.
function send_error(show_banner: boolean): string | undefined {
    sync!.flush();
    if (!sync!.is_lossy()) {
        return undefined;
    }
    const message = $t({defaultMessage: "This formatting cannot be sent as written."});
    if (show_banner) {
        compose_banner.show_error_message(
            message,
            compose_banner.CLASSNAMES.generic_compose_error,
            $("#compose_banners"),
            $(textarea!),
        );
    }
    return message;
}

// Upstream disables the send button while the message cannot be sent,
// and decides that when the box opens or its recipient changes; the
// formatting can change with every write.
let last_lossy = false;

function on_flush(lossy: boolean): void {
    if (lossy !== last_lossy) {
        last_lossy = lossy;
        compose_validate.validate_and_update_send_button_status();
    }
}

// ---- Upstream's formatting ----

function run(command: Command): true {
    const editor = view!;
    command(editor.state, editor.dispatch);
    editor.focus();
    return true;
}

function format_text(type: string, inserted_content: string | undefined): boolean {
    const state = view!.state;
    // What is left to upstream works on the textarea's Markdown.
    sync?.flush();
    switch (type) {
        case "bold":
            return run(ykphone_rich_commands.toggle_format("strong"));
        case "italic":
            return run(ykphone_rich_commands.toggle_format("em"));
        case "strikethrough":
            return run(ykphone_rich_commands.toggle_format("strike"));
        case "code":
        case "latex":
            if (ykphone_rich_commands.is_single_line_selection(state)) {
                return run(ykphone_rich_commands.toggle_format(type === "code" ? "code" : "math"));
            }
            if (type === "code" && state.selection.empty && !ykphone_rich_commands.in_code(state)) {
                insert_empty_code_block();
                return true;
            }
            // Blocks: upstream's Markdown, shown by the sync.
            return false;
        case "link":
            open_link_popover();
            return true;
        case "linked":
            return run(ykphone_rich_commands.apply_link(inserted_content ?? ""));
        default:
            // Lists, quotes and spoilers: upstream's Markdown.
            return false;
    }
}

// Upstream's empty code block, without opening its language menu on the
// hidden textarea.
function insert_empty_code_block(): void {
    const text = sync!.markdown();
    const {start, end} = sync!.selection_offsets();
    let opening = "```\n";
    let closing = "\n```";
    if (start > 0 && text[start - 1] !== "\n") {
        opening = "\n" + opening;
    }
    if (end < text.length && text[end] !== "\n") {
        closing += "\n";
    }
    sync!.set_markdown(
        text.slice(0, start) + opening + closing + text.slice(end),
        start + opening.length,
    );
    view!.focus();
}

// ---- Keys ----

function upstream_keydown(event: KeyboardEvent): JQuery.Event {
    return $.Event("keydown", {
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        which: event.which,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        originalEvent: event,
    });
}

// Runs upstream's keydown handlers for the compose textarea (bound on the
// textarea and on the compose form) on a key pressed in the editor, as
// if the textarea had it; returns whether they handled it. The key then
// bubbles as the textarea's, so the editor's own event stops here.
function forward_keydown(event: KeyboardEvent): boolean {
    // Upstream's handler may read the textarea and its cursor.
    sync?.flush();
    const jq_event = upstream_keydown(event);
    $(textarea!).trigger(jq_event);
    event.stopPropagation();
    return jq_event.isDefaultPrevented();
}

function handle_key_down(editor: EditorView, event: KeyboardEvent): boolean {
    shift_pressed = event.shiftKey;
    if (event.isComposing || event.keyCode === 229) {
        return false;
    }
    if (ykphone_rich_typeahead.handle_key(event)) {
        event.stopPropagation();
        return true;
    }
    const {state, dispatch} = editor;
    const modifier = event.ctrlKey || event.metaKey || event.altKey;
    if (event.key === "Enter") {
        if (
            composebox_typeahead.should_enter_send(
                upstream_keydown(event) as unknown as JQuery.KeyDownEvent,
            )
        ) {
            // Upstream would refuse the send silently, through the
            // disabled send button; the reason is shown instead.
            if (send_error(true) !== undefined) {
                event.preventDefault();
                return true;
            }
            forward_keydown(event);
            return true;
        }
        return (
            ykphone_rich_commands.enter_after_fence(state, dispatch) ||
            ykphone_rich_commands.enter_without_sending(state, dispatch)
        );
    }
    if (event.key === "Tab" && !modifier) {
        const in_list = state.selection.$from.node(-1)?.type.name === "list_item";
        if (in_list) {
            if (event.shiftKey) {
                ykphone_rich_commands.outdent_list_item(state, dispatch);
            } else {
                ykphone_rich_commands.indent_list_item(state, dispatch);
            }
            return true;
        }
        return event.shiftKey ? false : forward_keydown(event);
    }
    if ((event.ctrlKey || event.metaKey) && /^[bilc]$/iu.test(event.key)) {
        return forward_keydown(event);
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowRight") && !modifier && !event.shiftKey) {
        return ykphone_rich_commands.leave_block_at_end(state, dispatch);
    }
    return false;
}

// ---- Focus ----

function dispatch_on_textarea(type: "focus" | "focusin" | "blur" | "focusout"): void {
    textarea!.dispatchEvent(
        new FocusEvent(type, {bubbles: type.startsWith("focus") && type !== "focus"}),
    );
}

function take_focus_from_textarea(frames_left: number): void {
    const editor = view!;
    if (document.activeElement !== textarea) {
        return;
    }
    sync?.flush();
    sync?.check_textarea();
    if (link_popover !== undefined) {
        // The toolbar's link button focuses the textarea after
        // opening the link form.
        $(link_popover.popper).find("input").first().trigger("focus");
        return;
    }
    editor.focus();
    if (!editor.hasFocus()) {
        // Upstream focuses the textarea before the box is shown (the
        // class that shows it comes on the next frame); until the
        // editor can be focused, the textarea keeps the focus. A timer
        // rather than an animation frame, which a hidden tab never gets.
        if (frames_left > 0) {
            setTimeout(() => {
                take_focus_from_textarea(frames_left - 1);
            }, 50);
        }
        return;
    }
    // Upstream may have put the textarea's cursor somewhere (the end
    // of a restored draft); the editor's cursor goes there too.
    const {start, end} = sync!.selection_offsets();
    if (textarea!.selectionStart !== start || textarea!.selectionEnd !== end) {
        sync!.select_offsets(textarea!.selectionStart, textarea!.selectionEnd);
    }
}

function install_focus_proxy(editor: EditorView): void {
    editor.dom.addEventListener("focus", () => {
        update_link_bubble();
        $("#message-content-container").addClass("ykphone-rich-focused");
        // Upstream's focus handlers for the textarea (placeholder, topic
        // display, the last-focused input) run as if it were focused.
        dispatch_on_textarea("focus");
        dispatch_on_textarea("focusin");
    });
    editor.dom.addEventListener("blur", (event) => {
        ykphone_rich_typeahead.close();
        close_link_bubble();
        if (event.relatedTarget === textarea) {
            return;
        }
        $("#message-content-container").removeClass("ykphone-rich-focused");
        dispatch_on_textarea("blur");
        dispatch_on_textarea("focusout");
    });
    // Upstream focuses the textarea to put the user in the compose box;
    // once its code has finished, the editor takes the focus.
    textarea!.addEventListener("focus", (event) => {
        if (!event.isTrusted) {
            return;
        }
        queueMicrotask(() => {
            take_focus_from_textarea(3);
        });
    });
}

// ---- Mirroring the textarea ----

function mirror_textarea(root: HTMLElement): void {
    const apply = (records?: MutationRecord[]): void => {
        for (const class_name of MIRRORED_CLASSES) {
            root.classList.toggle(class_name, textarea!.classList.contains(class_name));
        }
        root.style.maxHeight = textarea!.style.maxHeight;
        const editable = !textarea!.disabled;
        if (view !== undefined && view.editable !== editable) {
            view.setProps({editable: () => editable});
        }
        // The placeholder decoration reads the attribute. Upstream's
        // autosize touches the style on every keystroke, which is
        // nothing the editor needs to redraw for.
        if (records?.every((record) => record.attributeName === "style") !== true) {
            view?.dispatch(view.state.tr.setMeta("ykphone-rich-refresh", true));
        }
    };

    new MutationObserver(apply).observe(textarea!, {
        attributes: true,
        attributeFilter: ["class", "style", "disabled", "placeholder"],
    });
    apply();
    // Upstream may focus the textarea before it shows the box; when
    // the box comes on, the editor takes the focus it could not yet.
    const box = textarea!.closest("#compose");
    if (box !== null) {
        new MutationObserver(() => {
            if (document.activeElement === textarea) {
                take_focus_from_textarea(0);
            }
        }).observe(box, {attributes: true, attributeFilter: ["class", "style"]});
    }
}

function after_update(): void {
    if (textarea === undefined) {
        return;
    }
    rtl.set_rtl_class_for_textarea($(textarea));
    ykphone_rich_typeahead.update();
    update_link_bubble();
}

function create_state(doc: PMNode): EditorState {
    return EditorState.create({
        doc,
        plugins: [
            ykphone_rich_commands.markdown_input_rules(() => context!),
            keymap({
                "Mod-z": undo,
                "Shift-Mod-z": redo,
                "Mod-y": redo,
                Backspace: undoInputRule,
            }),
            keymap(baseKeymap),
            history(),
            placeholder_plugin(),
        ],
    });
}

const OBJECT_REPLACEMENT = String.fromCodePoint(0xfffc);

function markdown_offset_rect(offset: number): DOMRect | undefined {
    if (view === undefined) {
        return undefined;
    }
    const {anchors} = serialize_cached(view.state.doc, context!);
    const pos = Math.min(offset_to_pos(anchors, offset), view.state.doc.content.size);
    const coords = view.coordsAtPos(pos);
    return new DOMRect(coords.left, coords.top, 1, coords.bottom - coords.top);
}

// Whether the Markdown from `start` to `end` is text as it was typed:
// no chips, escapes or formatting syntax in between.
function is_plain_text(editor: EditorView, start: number, end: number): boolean {
    const {anchors} = serialize_cached(editor.state.doc, context!);
    const from = offset_to_pos(anchors, start);
    const to = offset_to_pos(anchors, end);
    const text = editor.state.doc.textBetween(from, to, undefined, OBJECT_REPLACEMENT);
    return (
        !ykphone_rich_commands.in_code(editor.state) &&
        to - from === end - start &&
        text.length === end - start &&
        !text.includes(OBJECT_REPLACEMENT)
    );
}

export function mount(): void {
    const element = document.querySelector<HTMLTextAreaElement>("textarea#compose-textarea");
    if (element === null || view !== undefined) {
        return;
    }
    textarea = element;
    context = make_context();
    const root = document.createElement("div");
    root.className = "ykphone-rich-editor";
    textarea.after(root);
    textarea.tabIndex = -1;
    textarea.setAttribute("aria-hidden", "true");
    $("#compose").addClass("ykphone-rich-compose");

    const editor = new EditorView(root, {
        state: create_state(parse_markdown(textarea.value, context)),
        nodeViews: {
            mention: (node) => new ChipView(node),
            channel_link: (node) => new ChipView(node),
            emoji: (node) => new ChipView(node),
            time: (node) => new ChipView(node),
            upload: (node) => new ChipView(node),
            call_link: (node) => new ChipView(node),
            opaque_inline: (node) => new ChipView(node),
            escape: (node) => new ChipView(node),
            opaque_block: (node) => new OpaqueBlockView(node),
            code_block: (node) => new CodeBlockView(node),
            math_block: (node) => new CodeBlockView(node),
            spoiler: () => new SpoilerView(),
            ordered_list: (node) => new OrderedListView(node),
        },
        attributes: {
            class: "ykphone-rich-content rendered_markdown",
            role: "textbox",
            "aria-multiline": "true",
            "aria-label": textarea.getAttribute("aria-label") ?? "",
        },
        dispatchTransaction(tr) {
            editor.updateState(editor.state.apply(tr));
            sync?.after_transaction(tr);
            after_update();
        },
        handleKeyDown: handle_key_down,
        handlePaste: (editor_view, event) => handle_paste(editor_view, event),
        transformPasted: (slice) => checked_slice(slice),
        handleDrop(_editor_view, event) {
            // upload.ts takes dropped files from #compose.
            return (event.dataTransfer?.files.length ?? 0) > 0;
        },
    });
    view = editor;
    editor.dom.addEventListener("keyup", (event) => {
        shift_pressed = event.shiftKey;
    });
    // A chip is made of what the server renders, and upstream's
    // handlers for that markup open a user card or follow a channel
    // link. In the composer a chip is a piece of the message being
    // written, so a click on one only places the cursor.
    editor.dom.addEventListener(
        "click",
        (event) => {
            if (event.target instanceof Element && event.target.closest(CHIP_SELECTORS) !== null) {
                event.stopPropagation();
            }
        },
        true,
    );

    sync = create_sync({
        view: editor,
        textarea,
        context: () => context!,
        create_state,
        on_lossy(markdown_text) {
            blueslip.debug("Rich composer: formatting that Markdown cannot hold", {
                markdown: markdown_text,
            });
        },
        on_flush,
    });

    ykphone_rich_hooks.register({
        owns: (candidate) => candidate === textarea,
        has_focus: () => editor.hasFocus(),
        send_error,
        format_text,
        replace_syntax: (old_syntax, new_syntax) => sync!.replace_syntax(old_syntax, new_syntax),
        insert_text: (content, replace_all, keep_undo) => {
            sync!.insert_text(content, replace_all, keep_undo);
        },
    });

    ykphone_rich_typeahead.set_host({
        markdown: () => sync!.markdown(),
        selection_offsets: () => sync!.selection_offsets(),
        rect_at_offset: markdown_offset_rect,
        is_plain_text: (start, end) => is_plain_text(editor, start, end),
        set_markdown: (markdown_text, caret) => {
            sync!.set_markdown(markdown_text, caret);
            editor.focus();
        },
        is_composing: () => editor.composing,
        line_before_cursor: () => {
            const {$from} = editor.state.selection;
            return $from.parent
                .textBetween(0, $from.parentOffset, "\n", "\uFFFC")
                .split("\n")
                .at(-1)!;
        },
    });

    install_focus_proxy(editor);
    mirror_textarea(root);
    // On a page load into a conversation, upstream has opened the box
    // and focused the textarea before the composer is mounted.
    queueMicrotask(() => {
        take_focus_from_textarea(3);
    });
}
