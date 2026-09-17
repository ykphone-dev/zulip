// A 옆커폰 rich editor: an editor in place of a message textarea that
// shows formatting and chips instead of Markdown syntax.
//
// The textarea stays in the page, invisible under the editor, and holds
// the message as Markdown for everything upstream does with it
// (ykphone_rich_sync.ts keeps the two in step). This module is the
// editor's DOM side: keyboard handling that defers to upstream where
// upstream decides (Enter sending or saving, Tab, formatting shortcuts),
// focus, paste, the link bubble and form, and mirroring the textarea's
// placeholder, state classes, height limit and read-only state.
//
// Several can exist at once — the compose box (ykphone_rich_compose.ts),
// a form for every message being edited and the thread panel's reply box
// (ykphone_rich_surfaces.ts) — each described by a RichEditorHost.
// Upstream code reaches them through ykphone_rich_hooks.ts.

import isUrl from "is-url";
import $ from "jquery";
import {baseKeymap} from "prosemirror-commands";
import {history, redo, undo} from "prosemirror-history";
import {undoInputRule} from "prosemirror-inputrules";
import {keymap} from "prosemirror-keymap";
import {DOMParser, DOMSerializer, Fragment, type Node as PMNode, Slice} from "prosemirror-model";
import {type Command, EditorState, Plugin, TextSelection} from "prosemirror-state";
import {Decoration, DecorationSet, EditorView} from "prosemirror-view";
import * as tippy from "tippy.js";

import render_ykphone_rich_link_bubble from "../templates/ykphone_rich_link_bubble.hbs";
import render_ykphone_rich_link_popover from "../templates/ykphone_rich_link_popover.hbs";

import * as blueslip from "./blueslip.ts";
import * as compose_banner from "./compose_banner.ts";
import * as compose_paste from "./compose_paste.ts";
import * as compose_ui from "./compose_ui.ts";
import * as composebox_typeahead from "./composebox_typeahead.ts";
import {$t} from "./i18n.ts";
import * as people from "./people.ts";
import * as rtl from "./rtl.ts";
import * as upload from "./upload.ts";
import * as user_groups from "./user_groups.ts";
import * as util from "./util.ts";
import {sanitize_fragment} from "./ykphone_rich_clipboard.ts";
import * as ykphone_rich_commands from "./ykphone_rich_commands.ts";
import type {RichComposeHandlers} from "./ykphone_rich_hooks.ts";
import {is_allowed_url} from "./ykphone_rich_inline.ts";
import type {MarkdownContext} from "./ykphone_rich_markdown.ts";
import {offset_to_pos, parse_markdown} from "./ykphone_rich_markdown.ts";
import {schema} from "./ykphone_rich_schema.ts";
import {type ComposeSync, create_sync, serialize_cached} from "./ykphone_rich_sync.ts";
import * as ykphone_rich_typeahead from "./ykphone_rich_typeahead.ts";
import * as ykphone_rich_views from "./ykphone_rich_views.ts";

// Classes upstream puts on the textarea that change how the box looks.
const MIRRORED_CLASSES = [
    "invalid",
    "textarea-over-limit",
    "textarea-approaching-limit",
    "flash",
    "rtl",
];

// What a click inside the editor must not reach upstream's handlers.
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

const OBJECT_REPLACEMENT = String.fromCodePoint(0xfffc);

// Where an editor is and what sending means there.
export type RichEditorHost = {
    textarea: HTMLTextAreaElement;
    // The box the editor sits in: the link bubble is placed over it,
    // and upstream showing it gives the editor the focus.
    box: HTMLElement;
    // Gets the ykphone-rich-focused class while the editor has the focus.
    focus_container: HTMLElement;
    // A view of the message that cannot be changed (view source).
    read_only: boolean;
    // Whether Enter, pressed as in `event`, sends (or saves).
    enter_sends: (event: KeyboardEvent) => boolean;
    // Sends, once the document is known to be sendable. By default the
    // key goes to upstream's handlers for the textarea, which send.
    send?: (event: KeyboardEvent) => void;
    // Shows why the message cannot be sent as it is shown.
    show_send_error: (message: string) => void;
    // Whether upstream has keydown handlers for the textarea (Tab to the
    // send button, formatting shortcuts) that keys pressed in the editor
    // go to.
    upstream_keys: boolean;
    // Whether files can be uploaded here (long pasted text can become one).
    uploads: boolean;
    // Whether "/poll" and "/todo" can start a widget here.
    widgets: boolean;
    // Whether wildcard mentions are offered: not without a recipient.
    wildcard_mentions: boolean;
    // The textarea upstream's typeahead reads, holding `text` with the
    // cursor at `caret`; it finds the recipient and the banners from it.
    typeahead_input: (text: string, caret: number) => JQuery<HTMLTextAreaElement>;
    // Called after every write to the textarea, with whether the
    // document holds formatting Markdown cannot carry.
    on_flush?: (lossy: boolean) => void;
    // Why upstream would not send the message now (a Save button it
    // has disabled, say), once the editor's formatting can be sent; with
    // show_banner, it is also shown the way upstream shows it.
    send_blocked?: (show_banner: boolean) => string | undefined;
    // Called when the editor's box has left the page for good.
    on_removed?: () => void;
};

// Sits in an editor and says when the editor has been taken out of the
// page, however that happened (a panel emptied, a modal or a message row
// removed). Being moved elsewhere in the page is not leaving it.
class LifetimeElement extends HTMLElement {
    on_removed: (() => void) | undefined;

    disconnectedCallback(): void {
        queueMicrotask(() => {
            if (!this.isConnected) {
                this.on_removed?.();
            }
        });
    }
}

const LIFETIME_ELEMENT = "ykphone-rich-lifetime";

export class RichEditor {
    readonly host: RichEditorHost;
    readonly textarea: HTMLTextAreaElement;
    readonly root: HTMLElement;
    readonly view: EditorView;
    readonly sync: ComposeSync;
    readonly handlers: RichComposeHandlers;
    private readonly context: MarkdownContext;
    private readonly typeahead_host: ykphone_rich_typeahead.TypeaheadHost;
    private readonly observers: MutationObserver[] = [];
    private readonly on_textarea_focus: (event: FocusEvent) => void;
    private shift_pressed = false;
    private link_popover: tippy.Instance | undefined;
    private link_bubble: tippy.Instance | undefined;
    private bubble_link: {href: string; from: number; to: number} | undefined;
    private destroyed = false;

    constructor(host: RichEditorHost) {
        this.host = host;
        const textarea = host.textarea;
        this.textarea = textarea;
        this.context = ykphone_rich_views.make_context();
        this.root = document.createElement("div");
        this.root.className = "ykphone-rich-editor";
        textarea.after(this.root);
        textarea.tabIndex = -1;
        textarea.setAttribute("aria-hidden", "true");

        const editor = new EditorView(this.root, {
            state: this.create_state(parse_markdown(textarea.value, this.context)),
            nodeViews: ykphone_rich_views.node_views,
            attributes: {
                class: "ykphone-rich-content rendered_markdown",
                role: "textbox",
                "aria-multiline": "true",
                "aria-label": textarea.getAttribute("aria-label") ?? "",
            },
            editable: () => this.is_editable(),
            dispatchTransaction: (tr) => {
                editor.updateState(editor.state.apply(tr));
                this.sync?.after_transaction(tr);
                this.after_update();
            },
            handleKeyDown: (editor_view, event) => this.handle_key_down(editor_view, event),
            handlePaste: (editor_view, event) => this.handle_paste(editor_view, event),
            transformPasted: (slice) => this.checked_slice(slice),
            handleDrop(_editor_view, event) {
                // upload.ts takes dropped files from the box.
                return (event.dataTransfer?.files.length ?? 0) > 0;
            },
        });
        this.view = editor;
        editor.dom.addEventListener("keyup", (event) => {
            this.shift_pressed = event.shiftKey;
        });
        // A chip is made of what the server renders, and upstream's
        // handlers for that markup open a user card or follow a channel
        // link. In the editor a chip is a piece of the message being
        // written, so a click on one only places the cursor.
        editor.dom.addEventListener(
            "click",
            (event) => {
                if (
                    event.target instanceof Element &&
                    event.target.closest(CHIP_SELECTORS) !== null
                ) {
                    event.stopPropagation();
                }
            },
            true,
        );

        this.sync = create_sync({
            view: editor,
            textarea,
            context: () => this.context,
            create_state: (doc) => this.create_state(doc),
            on_lossy(markdown_text) {
                blueslip.debug("Rich editor: formatting that Markdown cannot hold", {
                    markdown: markdown_text,
                });
            },
            on_flush(lossy) {
                host.on_flush?.(lossy);
            },
        });

        this.handlers = {
            textarea,
            has_focus: () => !this.destroyed && editor.hasFocus(),
            flush: () => {
                this.sync.flush();
            },
            send_error: (show_banner) => this.send_error(show_banner),
            format_text: (type, inserted_content) => this.format_text(type, inserted_content),
            replace_syntax: (old_syntax, new_syntax) =>
                this.sync.replace_syntax(old_syntax, new_syntax),
            insert_text: (content, replace_all, keep_undo) => {
                this.sync.insert_text(content, replace_all, keep_undo);
            },
        };

        this.typeahead_host = {
            markdown: () => this.sync.markdown(),
            selection_offsets: () => this.sync.selection_offsets(),
            rect_at_offset: (offset) => this.markdown_offset_rect(offset),
            is_plain_text: (start, end) => this.is_plain_text(start, end),
            set_markdown: (markdown_text, caret) => {
                this.sync.set_markdown(markdown_text, caret);
                editor.focus();
            },
            is_composing: () => editor.composing,
            line_before_cursor() {
                const {$from} = editor.state.selection;
                return $from.parent
                    .textBetween(0, $from.parentOffset, "\n", OBJECT_REPLACEMENT)
                    .split("\n")
                    .at(-1)!;
            },
            input: host.typeahead_input,
            widgets: host.widgets,
            wildcard_mentions: host.wildcard_mentions,
        };

        this.on_textarea_focus = (event) => {
            if (!event.isTrusted) {
                return;
            }
            queueMicrotask(() => {
                this.take_focus_from_textarea(3);
            });
        };
        this.install_focus_proxy();
        this.mirror_textarea();
        if (host.on_removed !== undefined) {
            if (customElements.get(LIFETIME_ELEMENT) === undefined) {
                customElements.define(LIFETIME_ELEMENT, LifetimeElement);
            }
            const lifetime = new LifetimeElement();
            lifetime.hidden = true;
            lifetime.on_removed = host.on_removed;
            this.root.append(lifetime);
        }
    }

    // Upstream may have focused the textarea before the editor was
    // mounted (a page load into a conversation, a box opened with the
    // focus in it); the editor takes that focus.
    take_initial_focus(): void {
        queueMicrotask(() => {
            this.take_focus_from_textarea(3);
        });
    }

    destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.close_link_popover();
        this.close_link_bubble();
        if (this.view.hasFocus()) {
            ykphone_rich_typeahead.close();
        }
        // The language menu has the focus while it is open.
        ykphone_rich_views.close_menus_of(this.view);
        ykphone_rich_typeahead.remove_host(this.typeahead_host);
        this.sync.destroy();
        this.destroyed = true;
        for (const observer of this.observers) {
            observer.disconnect();
        }
        this.textarea.removeEventListener("focus", this.on_textarea_focus);
        this.view.destroy();
        for (const lifetime of this.root.querySelectorAll<LifetimeElement>(LIFETIME_ELEMENT)) {
            lifetime.on_removed = undefined;
        }
        this.root.remove();
        this.textarea.removeAttribute("tabindex");
        this.textarea.removeAttribute("aria-hidden");
    }

    private is_editable(): boolean {
        return !this.host.read_only && !this.textarea.disabled && !this.textarea.readOnly;
    }

    // ---- Placeholder ----

    private placeholder_plugin(): Plugin {
        const textarea = this.textarea;
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
                                "data-placeholder": textarea.placeholder,
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

    private create_state(doc: PMNode): EditorState {
        return EditorState.create({
            doc,
            plugins: [
                ykphone_rich_commands.markdown_input_rules(() => this.context),
                keymap({
                    "Mod-z": undo,
                    "Shift-Mod-z": redo,
                    "Mod-y": redo,
                    Backspace: undoInputRule,
                }),
                keymap(baseKeymap),
                history(),
                this.placeholder_plugin(),
            ],
        });
    }

    // ---- Pasting HTML ----

    // Zulip's own rendered message HTML, pasted from a message, becomes
    // chips: mentions, channel links, emoji, times and math are swapped
    // for the chip markup the schema reads, built from the Markdown they
    // came from. Everything else is read with the schema's rules (bold,
    // italic, links, lists, quotes, code), and its text stays text.
    private prepare_pasted_html(body: HTMLElement): void {
        const serializer = DOMSerializer.fromSchema(schema);
        const replace_with_markdown = (element: Element, raw: string): void => {
            const paragraph = parse_markdown(raw, this.context).firstChild;
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
            const user = Number.isNaN(user_id)
                ? undefined
                : people.maybe_get_user_by_id(user_id, true);
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
                element.querySelector("annotation[encoding='application/x-tex']")?.textContent ??
                "";
            element.replaceWith(math);
        }
    }

    // Whatever the clipboard claimed the slice was, its nodes are rebuilt
    // from what can be checked (ykphone_rich_clipboard.ts).
    private checked_slice(slice: Slice): Slice {
        return new Slice(
            sanitize_fragment(slice.content, this.context),
            slice.openStart,
            slice.openEnd,
        );
    }

    // ---- Inserting ----

    // Text as lines: line breaks between them, except in a spoiler's
    // header, which is one line. Control characters are left out.
    private text_slice(text: string, state: EditorState): Slice {
        const in_header = state.selection.$from.parent.type.name === "spoiler_header";
        // eslint-disable-next-line no-control-regex -- control characters are what this removes
        const clean = text.replaceAll(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, "");
        const nodes: PMNode[] = [];
        for (const [index, line] of clean.split(/\r?\n/u).entries()) {
            if (index > 0 && !in_header) {
                nodes.push(schema.nodes.hard_break.create());
            }
            const piece = in_header && index > 0 ? " " + line : line;
            if (piece !== "") {
                nodes.push(schema.text(piece));
            }
        }
        return new Slice(Fragment.from(nodes), 0, 0);
    }

    private insert_literal_text(text: string): void {
        const state = this.view.state;
        this.view.dispatch(
            state.tr.replaceSelection(this.text_slice(text, state)).scrollIntoView(),
        );
    }

    private handle_paste(editor: EditorView, event: ClipboardEvent): boolean {
        const data = event.clipboardData;
        if (data === null) {
            return false;
        }
        if ([...data.items].some((item) => item.kind === "file")) {
            // upload.ts takes pasted files from the box.
            return true;
        }
        const html = data.getData("text/html");
        const text = data.getData("text/plain");
        if (html.includes("data-pm-slice")) {
            // From an editor like this one: the schema knows its HTML,
            // and transformPasted checks what it read.
            return false;
        }
        if (
            this.host.uploads &&
            text.length >= compose_paste.MINIMUM_PASTE_SIZE_FOR_FILE_TREATMENT
        ) {
            const existing = this.sync.markdown();
            const avoid_direct_paste =
                text.length >= compose_paste.MINIMUM_PASTE_SIZE_TO_AVOID_DIRECT_PASTE;
            const filename = `${$t({defaultMessage: "PastedText"})}.txt`;
            const $banner = compose_banner.show_convert_pasted_text_to_file_banner({
                show_paste_button: avoid_direct_paste,
                convert_to_file_cb: () => {
                    this.sync.set_markdown(existing, existing.length);
                    upload.upload_pasted_file(
                        this.textarea,
                        new File([new Blob([text], {type: "text/plain"})], filename, {
                            type: "text/plain",
                        }),
                    );
                },
                paste_to_compose_cb: () => {
                    this.insert_literal_text(text);
                },
                $textarea: $(this.textarea),
            });
            setTimeout(() => {
                $(this.textarea).one("input", () => {
                    $banner.remove();
                });
            }, 0);
            if (avoid_direct_paste) {
                return true;
            }
        }
        if (ykphone_rich_commands.in_code(editor.state)) {
            this.insert_literal_text(text);
            return true;
        }
        const trimmed = text.trim();
        if (isUrl(trimmed)) {
            if (!editor.state.selection.empty && !this.shift_pressed) {
                return ykphone_rich_commands.apply_link(trimmed)(editor.state, editor.dispatch);
            }
            const syntax = this.shift_pressed
                ? null
                : compose_paste.try_stream_topic_syntax_text(trimmed);
            const reverse = this.shift_pressed ? null : compose_ui.reverse_linkify_text(trimmed);
            if (syntax !== null || reverse !== null) {
                this.sync.insert_text(syntax === null ? reverse! : syntax + " ", false, true);
                return true;
            }
        }
        if (html !== "" && !this.shift_pressed && !compose_paste.is_single_image(html)) {
            const body = new window.DOMParser().parseFromString(
                compose_paste.maybe_transform_html(html, text),
                "text/html",
            ).body;
            this.prepare_pasted_html(body);
            const slice = DOMParser.fromSchema(schema).parseSlice(body, {
                preserveWhitespace: false,
            });
            editor.dispatch(
                editor.state.tr.replaceSelection(this.checked_slice(slice)).scrollIntoView(),
            );
            return true;
        }
        this.insert_literal_text(text);
        return true;
    }

    // ---- The link the cursor is in ----

    private close_link_bubble(): void {
        this.link_bubble?.reference.remove();
        this.link_bubble?.destroy();
        this.link_bubble = undefined;
        this.bubble_link = undefined;
    }

    // Clicking a link only puts the cursor in it, as clicking text does.
    // What offers to open, change or remove it is a small bubble over the
    // link the cursor is in, the way Slack shows one. Its buttons take no
    // focus and no selection: mousedown is prevented, so the cursor stays
    // where the user put it.
    private update_link_bubble(): void {
        const editor = this.view;
        const link =
            !this.destroyed &&
            editor.hasFocus() &&
            editor.state.selection.empty &&
            this.is_editable()
                ? ykphone_rich_commands.link_at_selection(editor.state)
                : undefined;
        if (link === undefined || this.link_popover !== undefined) {
            this.close_link_bubble();
            return;
        }
        const shown = this.bubble_link;
        if (shown?.href === link.href && shown.from === link.from && shown.to === link.to) {
            void this.link_bubble?.popperInstance?.update();
            return;
        }
        this.close_link_bubble();
        this.bubble_link = link;
        const $bubble = $(render_ykphone_rich_link_bubble({href: link.href}));
        const anchor = document.createElement("span");
        anchor.className = "ykphone-rich-link-anchor";
        document.body.append(anchor);
        const box = this.host.box;
        this.link_bubble = tippy.default(anchor, {
            getReferenceClientRect() {
                const start = editor.coordsAtPos(link.from);
                const end = editor.coordsAtPos(link.to);
                // Over the box rather than over the link, so that the
                // formatting buttons between the text being written and
                // the message list stay clickable.
                const top = Math.min(start.top, box.getBoundingClientRect().top);
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
        this.link_bubble.show();
        $bubble.on("mousedown", (e) => {
            e.preventDefault();
        });
        $bubble.on("click", ".ykphone-rich-link-open", () => {
            if (is_allowed_url(link.href)) {
                window.open(link.href, "_blank", "noopener,noreferrer");
            }
        });
        $bubble.on("click", ".ykphone-rich-link-edit", () => {
            this.open_link_popover(link.from);
        });
        $bubble.on("click", ".ykphone-rich-link-drop", () => {
            this.close_link_bubble();
            editor.focus();
            ykphone_rich_commands.remove_link(editor.state, editor.dispatch);
        });
    }

    // ---- The link form ----

    private close_link_popover(): void {
        this.link_popover?.reference.remove();
        this.link_popover?.destroy();
        this.link_popover = undefined;
    }

    private open_link_popover(at?: number): void {
        const editor = this.view;
        if (!this.is_editable() || ykphone_rich_commands.in_code(editor.state)) {
            return;
        }
        this.close_link_popover();
        this.close_link_bubble();
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
        this.link_popover = tippy.default(anchor, {
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
            onClickOutside: () => {
                this.close_link_popover();
            },
            onMount() {
                (show_text ? $text : $url).trigger("focus");
            },
        });
        this.link_popover.show();

        // The editor gets the focus back before the form goes, so that
        // the form's removal cannot leave the focus on the page itself.
        const finish = (command?: Command): void => {
            editor.focus();
            this.close_link_popover();
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
                // Nothing that is a link yet: the link field is where it
                // goes.
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

    // Why the message cannot be sent as shown, if it cannot: the
    // document holds formatting Zulip's Markdown cannot carry to the
    // server.
    private send_error(show_banner: boolean): string | undefined {
        this.sync.flush();
        if (!this.sync.is_lossy()) {
            return this.host.send_blocked?.(show_banner);
        }
        const message = $t({defaultMessage: "This formatting cannot be sent as written."});
        if (show_banner) {
            this.host.show_send_error(message);
        }
        return message;
    }

    // ---- Upstream's formatting ----

    private run(command: Command): true {
        command(this.view.state, this.view.dispatch);
        this.view.focus();
        return true;
    }

    private format_text(type: string, inserted_content: string | undefined): boolean {
        const state = this.view.state;
        if (!this.is_editable()) {
            return true;
        }
        // What is left to upstream works on the textarea's Markdown.
        this.sync.flush();
        switch (type) {
            case "bold":
                return this.run(ykphone_rich_commands.toggle_format("strong"));
            case "italic":
                return this.run(ykphone_rich_commands.toggle_format("em"));
            case "strikethrough":
                return this.run(ykphone_rich_commands.toggle_format("strike"));
            case "code":
            case "latex":
                if (ykphone_rich_commands.is_single_line_selection(state)) {
                    return this.run(
                        ykphone_rich_commands.toggle_format(type === "code" ? "code" : "math"),
                    );
                }
                if (
                    type === "code" &&
                    state.selection.empty &&
                    !ykphone_rich_commands.in_code(state)
                ) {
                    this.insert_empty_code_block();
                    return true;
                }
                // Blocks: upstream's Markdown, shown by the sync.
                return false;
            case "link":
                this.open_link_popover();
                return true;
            case "linked":
                return this.run(ykphone_rich_commands.apply_link(inserted_content ?? ""));
            default:
                // Lists, quotes and spoilers: upstream's Markdown.
                return false;
        }
    }

    // Upstream's empty code block, without opening its language menu on
    // the hidden textarea.
    private insert_empty_code_block(): void {
        const text = this.sync.markdown();
        const {start, end} = this.sync.selection_offsets();
        let opening = "```\n";
        let closing = "\n```";
        if (start > 0 && text[start - 1] !== "\n") {
            opening = "\n" + opening;
        }
        if (end < text.length && text[end] !== "\n") {
            closing += "\n";
        }
        this.sync.set_markdown(
            text.slice(0, start) + opening + closing + text.slice(end),
            start + opening.length,
        );
        this.view.focus();
    }

    // ---- Keys ----

    // Runs upstream's keydown handlers for the textarea (bound on the
    // textarea and on its form) on a key pressed in the editor, as if the
    // textarea had it; returns whether they handled it. The key then
    // bubbles as the textarea's, so the editor's own event stops here.
    private forward_keydown(event: KeyboardEvent): boolean {
        // Upstream's handler may read the textarea and its cursor.
        this.sync.flush();
        const jq_event = upstream_keydown(event);
        $(this.textarea).trigger(jq_event);
        event.stopPropagation();
        return jq_event.isDefaultPrevented();
    }

    private handle_key_down(editor: EditorView, event: KeyboardEvent): boolean {
        this.shift_pressed = event.shiftKey;
        // Some IMEs send keydown with keyCode 229 and no isComposing.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
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
            if (this.host.enter_sends(event)) {
                // Upstream would refuse the send silently, through the
                // disabled send button; the reason is shown instead.
                if (this.send_error(true) !== undefined) {
                    event.preventDefault();
                    event.stopPropagation();
                    return true;
                }
                if (this.host.send === undefined) {
                    this.forward_keydown(event);
                } else {
                    event.preventDefault();
                    event.stopPropagation();
                    this.host.send(event);
                }
                return true;
            }
            return (
                ykphone_rich_commands.enter_after_fence(state, dispatch) ||
                ykphone_rich_commands.enter_without_sending(state, dispatch)
            );
        }
        if (
            event.key === "Tab" &&
            !modifier &&
            !event.shiftKey &&
            ykphone_rich_views.focus_code_block_label(editor)
        ) {
            // From the code, Tab reaches the block's language menu.
            return true;
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
            return event.shiftKey || !this.host.upstream_keys ? false : this.forward_keydown(event);
        }
        if ((event.ctrlKey || event.metaKey) && /^[bilc]$/iu.test(event.key)) {
            if (this.host.upstream_keys) {
                return this.forward_keydown(event);
            }
            return this.own_formatting_shortcut(event);
        }
        if (
            (event.key === "ArrowDown" || event.key === "ArrowRight") &&
            !modifier &&
            !event.shiftKey
        ) {
            return ykphone_rich_commands.leave_block_at_end(state, dispatch);
        }
        return false;
    }

    // Upstream's formatting shortcuts (compose_ui.handle_keydown), where
    // no upstream handler is bound to the textarea.
    private own_formatting_shortcut(event: KeyboardEvent): boolean {
        const key = event.key.toLowerCase();
        let type: string | undefined;
        if (key === "b") {
            type = "bold";
        } else if (key === "i" && !event.shiftKey) {
            type = "italic";
        } else if (key === "l" && event.shiftKey) {
            type = "link";
        } else if (key === "c" && event.shiftKey) {
            type = "code";
        }
        if (type === undefined) {
            return false;
        }
        this.format_text(type, undefined);
        return true;
    }

    // ---- Focus ----

    private dispatch_on_textarea(type: "focus" | "focusin" | "blur" | "focusout"): void {
        this.textarea.dispatchEvent(
            new FocusEvent(type, {bubbles: type.startsWith("focus") && type !== "focus"}),
        );
    }

    private take_focus_from_textarea(frames_left: number): void {
        const editor = this.view;
        const textarea = this.textarea;
        if (this.destroyed || document.activeElement !== textarea) {
            return;
        }
        this.sync.flush();
        this.sync.check_textarea();
        if (this.link_popover !== undefined) {
            // The toolbar's link button focuses the textarea after
            // opening the link form.
            $(this.link_popover.popper).find("input").first().trigger("focus");
            return;
        }
        editor.focus();
        if (!editor.hasFocus()) {
            // Upstream focuses the textarea before the box is shown (the
            // class that shows it comes on the next frame); until the
            // editor can be focused, the textarea keeps the focus. A
            // timer rather than an animation frame, which a hidden tab
            // never gets.
            if (frames_left > 0) {
                setTimeout(() => {
                    this.take_focus_from_textarea(frames_left - 1);
                }, 50);
            }
            return;
        }
        // Upstream may have put the textarea's cursor somewhere (the end
        // of a restored draft); the editor's cursor goes there too.
        const {start, end} = this.sync.selection_offsets();
        if (textarea.selectionStart !== start || textarea.selectionEnd !== end) {
            this.sync.select_offsets(textarea.selectionStart, textarea.selectionEnd);
        }
    }

    private install_focus_proxy(): void {
        const editor = this.view;
        editor.dom.addEventListener("focus", () => {
            ykphone_rich_typeahead.set_host(this.typeahead_host);
            this.update_link_bubble();
            this.host.focus_container.classList.add("ykphone-rich-focused");
            // Upstream's focus handlers for the textarea (placeholder,
            // topic display, the last-focused input) run as if it were
            // focused.
            this.dispatch_on_textarea("focus");
            this.dispatch_on_textarea("focusin");
        });
        editor.dom.addEventListener("blur", (event) => {
            ykphone_rich_typeahead.close();
            this.close_link_bubble();
            if (event.relatedTarget === this.textarea) {
                return;
            }
            this.host.focus_container.classList.remove("ykphone-rich-focused");
            this.dispatch_on_textarea("blur");
            this.dispatch_on_textarea("focusout");
        });
        // Upstream focuses the textarea to put the user in the box; once
        // its code has finished, the editor takes the focus.
        this.textarea.addEventListener("focus", this.on_textarea_focus);
    }

    // ---- Mirroring the textarea ----

    private mirror_textarea(): void {
        const textarea = this.textarea;
        const apply = (records?: MutationRecord[]): void => {
            for (const class_name of MIRRORED_CLASSES) {
                this.root.classList.toggle(class_name, textarea.classList.contains(class_name));
            }
            this.root.classList.toggle("read-only", !this.is_editable());
            this.root.style.maxHeight = textarea.style.maxHeight;
            // The placeholder decoration and the editable state read the
            // attributes. Upstream's autosize touches the style on every
            // keystroke, which is nothing the editor needs to redraw for.
            if (records?.every((record) => record.attributeName === "style") !== true) {
                this.view.dispatch(this.view.state.tr.setMeta("ykphone-rich-refresh", true));
            }
        };
        const textarea_observer = new MutationObserver(apply);
        textarea_observer.observe(textarea, {
            attributes: true,
            attributeFilter: ["class", "style", "disabled", "readonly", "placeholder"],
        });
        this.observers.push(textarea_observer);
        apply();
        // Upstream may focus the textarea before it shows the box; when
        // the box comes on, the editor takes the focus it could not yet.
        const box_observer = new MutationObserver(() => {
            if (document.activeElement === textarea) {
                this.take_focus_from_textarea(0);
            }
        });
        box_observer.observe(this.host.box, {
            attributes: true,
            attributeFilter: ["class", "style"],
        });
        this.observers.push(box_observer);
    }

    private after_update(): void {
        if (this.destroyed) {
            return;
        }
        rtl.set_rtl_class_for_textarea($(this.textarea));
        if (this.view.hasFocus()) {
            ykphone_rich_typeahead.update();
        }
        this.update_link_bubble();
    }

    private markdown_offset_rect(offset: number): DOMRect {
        const {anchors} = serialize_cached(this.view.state.doc, this.context);
        const pos = Math.min(offset_to_pos(anchors, offset), this.view.state.doc.content.size);
        const coords = this.view.coordsAtPos(pos);
        return new DOMRect(coords.left, coords.top, 1, coords.bottom - coords.top);
    }

    // Whether the Markdown from `start` to `end` is text as it was typed:
    // no chips, escapes or formatting syntax in between.
    private is_plain_text(start: number, end: number): boolean {
        const editor = this.view;
        const {anchors} = serialize_cached(editor.state.doc, this.context);
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
}

function upstream_keydown(event: KeyboardEvent): JQuery.Event {
    // eslint-disable-next-line new-cap -- jQuery's event factory
    return $.Event("keydown", {
        key: event.key,
        code: event.code,
        // Upstream's jQuery handlers read keyCode and which.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        keyCode: event.keyCode,
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        which: event.which,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        originalEvent: event,
    });
}

// Whether upstream's Enter-sends setting sends on this key: the
// compose box's rule, which the message edit form shares.
export function upstream_enter_sends(event: KeyboardEvent): boolean {
    return composebox_typeahead.should_enter_send(
        // The jQuery event carries every field should_enter_send reads.
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        upstream_keydown(event) as unknown as JQuery.KeyDownEvent,
    );
}
