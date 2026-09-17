// How the 옆커폰 rich editors draw what is not plain text: chips for
// mentions, channel links, emoji, times, uploads and calls, cards for
// widgets, and the blocks with a label of their own (code, math,
// spoilers). Also the server data the Markdown grammar needs.
//
// Everything here is shared by every rich editor (the compose box, edit
// forms, the thread panel); ykphone_rich_editor.ts puts it together.

import $ from "jquery";
import type {Node as PMNode} from "prosemirror-model";
import type {EditorView, NodeView} from "prosemirror-view";
import * as tippy from "tippy.js";

import render_ykphone_rich_chip from "../templates/ykphone_rich_chip.hbs";
import render_ykphone_rich_language_menu from "../templates/ykphone_rich_language_menu.hbs";
import render_ykphone_rich_widget_card from "../templates/ykphone_rich_widget_card.hbs";

import * as channel from "./channel.ts";
import * as composebox_typeahead from "./composebox_typeahead.ts";
import * as emoji from "./emoji.ts";
import {$t} from "./i18n.ts";
import * as markdown from "./markdown.ts";
import * as people from "./people.ts";
import {postprocess_content} from "./postprocess_content.ts";
import * as realm_playground from "./realm_playground.ts";
import * as rendered_markdown from "./rendered_markdown.ts";
import * as stream_data from "./stream_data.ts";
import * as typeahead_helper from "./typeahead_helper.ts";
import * as user_groups from "./user_groups.ts";
import * as util from "./util.ts";
import * as ykphone_rich_commands from "./ykphone_rich_commands.ts";
import type {MarkdownContext} from "./ykphone_rich_markdown.ts";

const WILDCARD_MENTIONS = new Set(["all", "everyone", "stream", "channel", "topic"]);

// ---- Server data for the Markdown grammar ----

export function make_context(): MarkdownContext {
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

// Rendered HTML by Markdown; the oldest entries are dropped past the
// limit (a math preview adds one per paused formula).
const rendered_cache = new Map<string, string>();
const RENDERED_CACHE_LIMIT = 500;

function cache_rendered(raw: string, html: string): void {
    rendered_cache.set(raw, html);
    if (rendered_cache.size > RENDERED_CACHE_LIMIT) {
        rendered_cache.delete(rendered_cache.keys().next().value!);
    }
}

// Shows Markdown the editor keeps as it is, rendered the way the message
// will look: by the web app's Markdown processor, or by the server for
// syntax only it knows. When the element is asked to show something else
// before the server answers, the late answer is dropped.
export function show_rendered(element: HTMLElement, raw: string, inline: boolean): void {
    element.dataset["ykRendering"] = raw;
    const fill = (html: string): void => {
        if (element.dataset["ykRendering"] !== raw) {
            return;
        }
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
        cache_rendered(raw, html);
        fill(html);
        return;
    }
    element.textContent = raw;
    void channel.post({
        url: "/json/messages/render",
        data: {content: raw},
        success(response) {
            const html = (response as {rendered: string}).rendered;
            cache_rendered(raw, html);
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

type ViewMutationRecord = MutationRecord | {type: "selection"; target: DOMNode};
type DOMNode = globalThis.Node;
type GetPos = () => number | undefined;

// ---- The code block's language menu ----

// At most this many languages are listed for what was typed, as in
// upstream's code block typeahead.
const MAX_LANGUAGES_LISTED = 8;

type LanguageMenu = {
    instance: tippy.Instance;
    editor: EditorView;
    button: HTMLElement;
};

let language_menu: LanguageMenu | undefined;
let language_menus_opened = 0;

function close_language_menu(): void {
    if (language_menu === undefined) {
        return;
    }
    language_menu.button.setAttribute("aria-expanded", "false");
    language_menu.instance.destroy();
    language_menu = undefined;
}

// Closes the menus an editor's node views opened, when the editor goes.
export function close_menus_of(editor: EditorView): void {
    if (language_menu?.editor === editor) {
        close_language_menu();
    }
}

// The languages upstream's code block typeahead offers for `query`, in
// its order; Markdown's own block names are not code languages.
function languages_for(query: string): string[] {
    const matcher = composebox_typeahead.get_language_matcher(query);
    const matches = realm_playground
        .get_pygments_typeahead_list_for_composebox()
        .filter((language) => matcher(language))
        .map((language) => ({language, type: "syntax" as const}));
    return typeahead_helper
        .sort_languages(matches, query)
        .map((item) => item.language)
        .filter((language) => ykphone_rich_commands.is_code_language(language))
        .slice(0, MAX_LANGUAGES_LISTED);
}

// Opens the menu of languages under the label of the code block at
// `get_pos()`: a search field that is a combobox over the listed
// languages. Choosing one (or "Plain text") sets the block's language;
// Enter with no listed match takes what was typed, if it can be one.
// Escape or Tab closes it and gives the focus back to where it came
// from: the label when the menu was opened from the keyboard.
function open_language_menu(
    editor: EditorView,
    get_pos: GetPos,
    button: HTMLElement,
    from_keyboard: boolean,
): void {
    close_language_menu();
    language_menus_opened += 1;
    const list_id = `ykphone-rich-language-list-${language_menus_opened}`;
    const $menu = $(render_ykphone_rich_language_menu({list_id}));
    const $search = $menu.find<HTMLInputElement>(".ykphone-rich-language-search");
    const $list = $menu.find(".ykphone-rich-language-list");
    let options: string[] = [];
    let active = 0;

    const give_back_focus = (): void => {
        if (from_keyboard && button.isConnected) {
            button.focus();
        } else if (!editor.isDestroyed) {
            editor.focus();
        }
    };
    const choose = (language: string): void => {
        close_language_menu();
        // The editor may have gone while the menu was open (its message
        // row re-rendered, its panel closed).
        if (editor.isDestroyed) {
            return;
        }
        editor.focus();
        const pos = get_pos();
        if (pos !== undefined) {
            ykphone_rich_commands.set_code_block_language(pos, language)(
                editor.state,
                editor.dispatch,
            );
        }
    };
    const render = (): void => {
        const query = ($search.val() ?? "").trim();
        options = ["", ...languages_for(query)];
        if (query !== "") {
            // "Plain text" is for an empty search.
            options.shift();
        }
        active = Math.min(active, Math.max(options.length - 1, 0));
        $list.empty();
        for (const [index, language] of options.entries()) {
            $("<li>")
                .addClass("ykphone-rich-language-option")
                .toggleClass("active", index === active)
                .attr({
                    id: `${list_id}-${index}`,
                    role: "option",
                    "data-index": index,
                    "aria-selected": index === active,
                })
                .text(language === "" ? $t({defaultMessage: "Plain text"}) : language)
                .appendTo($list);
        }
        if (options.length > 0) {
            $search.attr("aria-activedescendant", `${list_id}-${active}`);
        } else {
            $search.removeAttr("aria-activedescendant");
        }
    };

    const instance = tippy.default(button, {
        content: util.the($menu),
        placement: "bottom-start",
        trigger: "manual",
        interactive: true,
        arrow: false,
        theme: "popover-menu",
        appendTo: () => document.body,
        onClickOutside() {
            close_language_menu();
        },
        onMount() {
            $search.trigger("focus");
        },
    });
    language_menu = {instance, editor, button};
    button.setAttribute("aria-expanded", "true");
    render();
    instance.show();

    $search.on("input", () => {
        active = 0;
        render();
    });
    $menu.on("mousedown", "li", (e) => {
        // The search field keeps the focus until the choice is made.
        e.preventDefault();
    });
    $menu.on("click", "li", function (this: HTMLElement) {
        choose(options[Number($(this).attr("data-index"))]!);
    });
    $menu.on("keydown", (e) => {
        switch (e.key) {
            case "ArrowDown":
            case "ArrowUp":
                if (options.length > 0) {
                    const step = e.key === "ArrowDown" ? 1 : options.length - 1;
                    active = (active + step) % options.length;
                    render();
                }
                break;
            case "Enter": {
                const typed = ($search.val() ?? "").trim();
                const choice = options[active];
                if (choice !== undefined) {
                    choose(choice);
                } else if (ykphone_rich_commands.is_code_language(typed)) {
                    choose(typed);
                }
                break;
            }
            case "Escape":
            case "Tab":
                close_language_menu();
                give_back_focus();
                break;
            default:
                return;
        }
        e.preventDefault();
        e.stopPropagation();
    });
}

// Tab in a code block moves the focus to the block's language button.
export function focus_code_block_label(editor: EditorView): boolean {
    const {$from} = editor.state.selection;
    if ($from.parent.type.name !== "code_block" || !editor.editable) {
        return false;
    }
    const dom = editor.nodeDOM($from.before());
    const label =
        dom instanceof HTMLElement
            ? dom.querySelector<HTMLElement>("button.ykphone-rich-code-label")
            : null;
    if (label === null) {
        return false;
    }
    label.focus();
    return true;
}

// ---- Blocks ----

// Code and math blocks: the text is edited in place, under a label. A
// code block's label is a button that opens the language menu; a math
// block shows the formula as it will be rendered under its source.
class CodeBlockView implements NodeView {
    dom: HTMLElement;
    contentDOM: HTMLElement;
    label: HTMLElement;
    preview: HTMLElement | undefined;
    node: PMNode;
    render_timer: ReturnType<typeof setTimeout> | undefined;

    constructor(node: PMNode, editor: EditorView, get_pos: GetPos) {
        this.node = node;
        this.dom = document.createElement("div");
        const pre = document.createElement("pre");
        this.contentDOM = document.createElement("code");
        pre.append(this.contentDOM);
        if (node.type.name === "math_block") {
            this.dom.className = "ykphone-rich-code-block math";
            this.label = document.createElement("div");
            this.preview = document.createElement("div");
            this.preview.className = "ykphone-rich-math-preview rendered_markdown";
            this.preview.contentEditable = "false";
            this.dom.append(this.label, pre, this.preview);
            this.render_preview();
        } else {
            this.dom.className = "ykphone-rich-code-block";
            const button = document.createElement("button");
            button.type = "button";
            button.title = $t({defaultMessage: "Code block language"});
            button.setAttribute("aria-haspopup", "listbox");
            button.setAttribute("aria-expanded", "false");
            button.addEventListener("mousedown", (e) => {
                // The editor keeps its selection.
                e.preventDefault();
            });
            button.addEventListener("click", (e) => {
                e.preventDefault();
                if (editor.editable) {
                    // A click from Enter or Space has no pointer position.
                    open_language_menu(editor, get_pos, button, e.detail === 0);
                }
            });
            button.addEventListener("keydown", (e) => {
                if (e.key === "Tab") {
                    return;
                }
                // Keys on the button are the button's: not typing in the
                // editor, and not the app's hotkeys.
                e.stopPropagation();
                if (e.key === "ArrowDown" && editor.editable) {
                    e.preventDefault();
                    open_language_menu(editor, get_pos, button, true);
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    editor.focus();
                }
            });
            this.label = button;
            this.dom.append(this.label, pre);
        }
        this.label.classList.add("ykphone-rich-code-label");
        this.label.contentEditable = "false";
        this.set_label(node);
    }

    set_label(node: PMNode): void {
        if (node.type.name === "math_block") {
            this.label.textContent = $t({defaultMessage: "Math (LaTeX)"});
            return;
        }
        const language = ykphone_rich_commands.code_block_language(String(node.attrs["info"]));
        this.label.textContent = language === "" ? $t({defaultMessage: "Code"}) : language;
        const chevron = document.createElement("i");
        chevron.className = "zulip-icon zulip-icon-chevron-down";
        chevron.ariaHidden = "true";
        this.label.append(chevron);
    }

    // The formula as the message will show it, redrawn shortly after
    // typing pauses.
    render_preview(): void {
        const preview = this.preview!;
        const text = this.node.textContent;
        if (text.trim() === "") {
            delete preview.dataset["ykRendering"];
            preview.replaceChildren();
            return;
        }
        // A fence longer than any run of backticks starting a line of
        // the formula, which would otherwise close it early.
        const runs = [...text.matchAll(/^ {0,3}(`{3,})/gmu)].map((match) => match[1]!.length);
        const fence = "`".repeat(Math.max(3, ...runs.map((length) => length + 1)));
        show_rendered(preview, `${fence}math\n${text}\n${fence}`, false);
    }

    update(node: PMNode): boolean {
        if (node.type !== this.node.type) {
            return false;
        }
        const text_changed = node.textContent !== this.node.textContent;
        this.node = node;
        this.set_label(node);
        if (this.preview !== undefined && text_changed) {
            clearTimeout(this.render_timer);
            this.render_timer = setTimeout(() => {
                this.render_preview();
            }, 200);
        }
        return true;
    }

    ignoreMutation(mutation: ViewMutationRecord): boolean {
        return !this.contentDOM.contains(mutation.target);
    }

    stopEvent(event: Event): boolean {
        return event.target instanceof Node && this.label.contains(event.target);
    }

    destroy(): void {
        clearTimeout(this.render_timer);
    }
}

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

type NodeViewConstructor = (node: PMNode, view: EditorView, get_pos: GetPos) => NodeView;

export const node_views: Record<string, NodeViewConstructor> = {
    mention: (node) => new ChipView(node),
    channel_link: (node) => new ChipView(node),
    emoji: (node) => new ChipView(node),
    time: (node) => new ChipView(node),
    upload: (node) => new ChipView(node),
    call_link: (node) => new ChipView(node),
    opaque_inline: (node) => new ChipView(node),
    escape: (node) => new ChipView(node),
    opaque_block: (node) => new OpaqueBlockView(node),
    code_block: (node, view, get_pos) => new CodeBlockView(node, view, get_pos),
    math_block: (node, view, get_pos) => new CodeBlockView(node, view, get_pos),
    spoiler: () => new SpoilerView(),
    ordered_list: (node) => new OrderedListView(node),
};
