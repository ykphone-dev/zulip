// The @, # and : suggestion menus of the 옆커폰 rich editors.
//
// Suggestions, their ranking and the Markdown a chosen suggestion
// becomes all come from upstream's compose typeahead
// (composebox_typeahead.get_candidates, content_item_html and
// content_typeahead_selected), so a mention chosen here is byte for byte
// the mention upstream would insert, with the same warnings (a user not
// in the channel, a private channel linked). Those functions read the
// text before the cursor from a textarea; they are given a detached
// "shadow" textarea holding the editor's Markdown with the cursor at the
// editor's, so the real one is never touched while the menu is open. The
// menu belongs to the editor with the focus (set_host).
//
// Differences from upstream, for a composer without visible syntax:
// - Choosing a channel inserts its chip; upstream leaves "#**channel>"
//   in the box to offer topics. Typing ">" right after a channel chip
//   offers them here, and choosing one turns the chip into a topic link.
// - "/poll" and "/todo" open upstream's poll and to-do forms rather than
//   writing a placeholder command to fill in.
// - Code block languages and "<time" are not offered.

import $ from "jquery";
import * as tippy from "tippy.js";

import * as composebox_typeahead from "./composebox_typeahead.ts";
import type {TypeaheadSuggestion} from "./composebox_typeahead.ts";
import {$t} from "./i18n.ts";
import * as scroll_util from "./scroll_util.ts";
import * as util from "./util.ts";
import * as ykphone_rich_hooks from "./ykphone_rich_hooks.ts";

// Just the parts of the composer the menu needs.
export type TypeaheadHost = {
    markdown: () => string;
    selection_offsets: () => {start: number; end: number};
    // The screen rectangle of the Markdown offset, for placing the menu.
    rect_at_offset: (offset: number) => DOMRect | undefined;
    // Whether the text from `start` to the cursor is plain text the user
    // typed (not a chip, not code).
    is_plain_text: (start: number, end: number) => boolean;
    set_markdown: (markdown: string, caret: number) => void;
    is_composing: () => boolean;
    // The text of the current line before the cursor, as the document
    // has it (chips as their Markdown).
    line_before_cursor: () => string;
    // The shadow textarea for `text` with the cursor at `caret`: where
    // it is (or which id it has) tells upstream the recipient and where
    // its warnings go.
    input: (text: string, caret: number) => JQuery<HTMLTextAreaElement>;
    // Whether "/poll" and "/todo" are offered.
    widgets: boolean;
    // Whether wildcard mentions (@all, @topic…) are offered; there is no
    // recipient they could notify in a saved snippet.
    wildcard_mentions: boolean;
};

const BREAK = "\n";

const TOPIC_AFTER_CHANNEL_RE = /#\*\*(?<name>[^*>]+)\*\*\s?>(?<topic>[^*\n]*)$/u;

type MenuState = {
    items: TypeaheadSuggestion[];
    active: number;
    // What get_candidates saw: the Markdown with the cursor at `caret`.
    text: string;
    caret: number;
    // Where the token being completed starts, in the real Markdown.
    token_start: number;
    // The shadow textarea get_candidates read.
    input: HTMLTextAreaElement;
};

let host: TypeaheadHost | undefined;
let menu: MenuState | undefined;
let instance: tippy.Instance | undefined;
let $container: JQuery | undefined;
// The Markdown and cursor the user dismissed the menu at; it stays
// closed until either changes.
let dismissed: string | undefined;

function shadow_input(
    text: string,
    caret: number,
): {
    $element: JQuery<HTMLTextAreaElement>;
    type: "textarea";
} {
    return {$element: host!.input(text, caret), type: "textarea"};
}

// The compose box's shadow: detached, with the compose textarea's id so
// that upstream's warnings find the compose banners.
export function compose_input(text: string, caret: number): JQuery<HTMLTextAreaElement> {
    const $shadow = $<HTMLTextAreaElement>("<textarea>").attr("id", "compose-textarea");
    util.the($shadow).value = text;
    util.the($shadow).setSelectionRange(caret, caret);
    return $shadow;
}

// The Markdown upstream's typeahead should see: the real Markdown,
// except that a channel chip followed by ">" reads as "#**channel>" —
// upstream's syntax while a topic is being chosen.
function typeahead_text(
    markdown: string,
    caret: number,
): {text: string; caret: number; token_start: number} | undefined {
    const before = markdown.slice(0, caret);
    // Upstream offers nothing when the cursor is followed by anything but
    // a space or punctuation, which the closing delimiters of formatting
    // around the cursor are; a newline stands in for them, and is taken
    // out again when a suggestion is chosen.
    const after = BREAK + markdown.slice(caret);
    const topic = TOPIC_AFTER_CHANNEL_RE.exec(before);
    if (topic !== null) {
        const {name, topic: typed} = topic.groups!;
        const rewritten = before.slice(0, topic.index) + `#**${name}>${typed}`;
        return {text: rewritten + after, caret: rewritten.length, token_start: topic.index};
    }
    const token = composebox_typeahead.tokenize_compose_str(before);
    if (token === "") {
        return undefined;
    }
    const token_start = caret - token.length;
    if (!host!.is_plain_text(token_start, caret)) {
        return undefined;
    }
    return {text: before + after, caret, token_start};
}

function wanted(item: TypeaheadSuggestion): boolean {
    if (item.type === "slash" && ["poll", "todo"].includes(item.name)) {
        return host!.widgets;
    }
    if (item.type === "broadcast") {
        return host!.wildcard_mentions;
    }
    return !["syntax", "time_jump", "topic_jump"].includes(item.type);
}

function option_label(item: TypeaheadSuggestion): string | undefined {
    if (item.type !== "topic_list") {
        return undefined;
    }
    if (item.is_channel_link) {
        return $t({defaultMessage: "(link to channel)"});
    }
    return item.is_new_topic ? $t({defaultMessage: "New"}) : undefined;
}

function render(): void {
    if (menu === undefined || host === undefined) {
        return;
    }
    if ($container === undefined) {
        $container = $("<div>")
            .addClass("typeahead dropdown-menu ykphone-rich-typeahead")
            .append($("<ul>").addClass("typeahead-menu").attr("data-simplebar", ""))
            .append($("<p>").addClass("typeahead-footer").append($("<span>")));
        $container.on("mousedown", (e) => {
            // Keep focus (and an IME) in the editor.
            e.preventDefault();
        });
        $container.on("click", "li", function (this: HTMLElement) {
            // Not in the middle of an IME composition, whose text the
            // choice would replace under it.
            if (host?.is_composing() !== true) {
                select(Number($(this).attr("data-index")));
            }
        });
        $container.on("mousemove", "li", function (this: HTMLElement) {
            set_active(Number($(this).attr("data-index")));
        });
    }
    const render_item = composebox_typeahead.content_item_html(menu.text);
    const shown = menu;
    const $items = menu.items.map((item, index) => {
        const rendered_item = ykphone_rich_hooks.with_recipient_of(shown.input, () =>
            render_item(item),
        );
        const $link = $("<a>")
            .addClass("typeahead-item-link")
            .html(rendered_item ?? "");
        const label = option_label(item);
        if (label !== undefined) {
            $link
                .addClass("typeahead-option-label-container")
                .append($("<em>").addClass("typeahead-option-label").text(label));
        }
        if (item.type === "topic_list" && !item.is_channel_link) {
            $link.addClass("topic-typeahead-link");
        }
        return $("<li>")
            .addClass("typeahead-item")
            .toggleClass("active", index === menu!.active)
            .attr("data-index", index)
            .append($link);
    });
    const $menu = $container.find(".typeahead-menu");
    scroll_util.get_scroll_element($menu);
    scroll_util.get_content_element($menu).empty().append($items);
    const silent = menu.text.slice(menu.token_start, menu.token_start + 2) === "@_";
    $container
        .find(".typeahead-footer")
        .toggle(silent)
        .find("span")
        .text($t({defaultMessage: "This silent mention won't trigger notifications."}));

    const rect = (): DOMRect =>
        host?.rect_at_offset(menu?.token_start ?? 0) ?? new DOMRect(0, 0, 0, 0);
    if (instance === undefined) {
        // tippy needs an element of its own; the rectangle comes from the
        // editor.
        const anchor = document.createElement("span");
        anchor.className = "ykphone-rich-typeahead-anchor";
        document.body.append(anchor);
        instance = tippy.default(anchor, {
            getReferenceClientRect: rect,
            content: util.the($container),
            placement: "top-start",
            trigger: "manual",
            interactive: true,
            arrow: false,
            maxWidth: "none",
            offset: [0, 4],
            theme: "dropdown-widget",
            appendTo: () => document.body,
            hideOnClick: false,
            popperOptions: {
                strategy: "fixed",
                modifiers: [{name: "flip", options: {fallbackPlacements: ["bottom-start"]}}],
            },
            onMount() {
                $container?.show();
            },
        });
        instance.show();
    } else {
        instance.setProps({getReferenceClientRect: rect});
        void instance.popperInstance?.update();
    }
}

function set_active(index: number): void {
    if (menu === undefined || index === menu.active) {
        return;
    }
    menu.active = index;
    const $items = $container!.find("li.typeahead-item");
    $items.removeClass("active");
    const $active = $items.eq(index).addClass("active");
    scroll_util.scroll_element_into_container($active, $container!.find(".typeahead-menu"));
}

export function close(): void {
    menu = undefined;
    instance?.reference.remove();
    instance?.destroy();
    instance = undefined;
    $container?.remove();
    $container = undefined;
}

export function is_open(): boolean {
    return menu !== undefined;
}

// Looks at the text before the cursor and opens, updates or closes the
// menu.
// Characters a suggestion can start from: mentions, channel links and
// emoji, slash commands, times, and the ">" that offers a channel's
// topics. A line holding none of them before the cursor needs no
// Markdown written to know there is nothing to suggest.
const TRIGGER_RE = /[@#:/<>]/u;

export function update(): void {
    if (host === undefined) {
        return;
    }
    if (!TRIGGER_RE.test(host.line_before_cursor())) {
        close();
        return;
    }
    const markdown = host.markdown();
    const {start, end} = host.selection_offsets();
    const key = `${start}:${markdown}`;
    if (start !== end || key === dismissed) {
        close();
        return;
    }
    dismissed = undefined;
    const seen = typeahead_text(markdown, start);
    if (seen === undefined) {
        close();
        return;
    }
    const input = shadow_input(seen.text, seen.caret);
    // Upstream asks compose_state who the message is for; an editor with
    // a recipient of its own answers instead.
    const items = ykphone_rich_hooks
        .with_recipient_of(util.the(input.$element), () =>
            composebox_typeahead.get_candidates(seen.text, input),
        )
        .filter((item) => wanted(item))
        .slice(0, composebox_typeahead.max_num_items);
    if (items.length === 0) {
        close();
        return;
    }
    menu = {
        items,
        active: 0,
        text: seen.text,
        caret: seen.caret,
        token_start: seen.token_start,
        input: util.the(input.$element),
    };
    render();
}

function select(index: number, event?: JQuery.KeyDownEvent): void {
    if (menu === undefined || host === undefined) {
        return;
    }
    const item = menu.items[index];
    if (item === undefined) {
        return;
    }
    const {text, caret} = menu;
    const rest = text.slice(caret);
    const real_rest = rest.slice(BREAK.length);
    close();
    if (item.type === "slash" && (item.name === "poll" || item.name === "todo")) {
        // The form writes the poll into the (now empty) box itself.
        host.set_markdown(text.slice(0, menu_token_start(text, caret)) + real_rest, 0);
        const button = item.name === "poll" ? ".add-poll" : ".add-todo-list";
        $(`#compose ${button}`).first().trigger("click");
        return;
    }
    const input = shadow_input(text, caret);
    const updated = ykphone_rich_hooks.with_recipient_of(util.the(input.$element), () =>
        composebox_typeahead.content_typeahead_selected(item, text, input, event),
    );
    let before = updated.slice(0, updated.length - rest.length);
    if (item.type === "stream" && before.endsWith(">")) {
        // Upstream leaves "#**channel>" to pick a topic next; insert the
        // channel link and let ">" offer topics instead.
        before = before.slice(0, -1);
        if (before.endsWith(`#**${item.name}`)) {
            before += "**";
        }
        before += " ";
    }
    host.set_markdown(before + real_rest, before.length);
}

function menu_token_start(text: string, caret: number): number {
    return caret - composebox_typeahead.tokenize_compose_str(text.slice(0, caret)).length;
}

// Keys for the open menu. Returns whether the key was used.
export function handle_key(event: KeyboardEvent): boolean {
    if (menu === undefined || event.isComposing || host?.is_composing() === true) {
        return false;
    }
    switch (event.key) {
        case "ArrowDown":
            set_active((menu.active + 1) % menu.items.length);
            return true;
        case "ArrowUp":
            set_active((menu.active - 1 + menu.items.length) % menu.items.length);
            return true;
        case "Enter":
        case "Tab":
            if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
                return false;
            }
            select(menu.active);
            return true;
        case "Escape":
            dismissed = `${host!.selection_offsets().start}:${host!.markdown()}`;
            close();
            return true;
        default:
            return false;
    }
}

export function set_host(new_host: TypeaheadHost): void {
    if (host === new_host) {
        return;
    }
    host = new_host;
    dismissed = undefined;
    close();
}

// Called when an editor goes away.
export function remove_host(old_host: TypeaheadHost): void {
    if (host === old_host) {
        host = undefined;
        close();
    }
}
