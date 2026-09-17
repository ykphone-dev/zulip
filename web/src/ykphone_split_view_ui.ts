// DOM side of the split-pane pages (DM, Activity, Threads) for the
// 옆커폰 web UI: the list column at the left of the middle pane, the
// placeholder shown on the right while nothing is selected (through
// views_util, like the inbox), and the narrows activated for a
// selection. Every decision (what a route needs, what the right column
// shows, whether new messages change the rows) is made in
// ykphone_split_view.ts and only carried out here; this module is
// exempt from node coverage like ykphone_threads_ui.

import $ from "jquery";

import render_ykphone_activity_rows from "../templates/ykphone_activity_rows.hbs";
import render_ykphone_split_dm_rows from "../templates/ykphone_split_dm_rows.hbs";
import render_ykphone_split_empty from "../templates/ykphone_split_empty.hbs";
import render_ykphone_split_thread_rows from "../templates/ykphone_split_thread_rows.hbs";
import render_ykphone_split_view from "../templates/ykphone_split_view.hbs";

import * as browser_history from "./browser_history.ts";
import * as compose_closed_ui from "./compose_closed_ui.ts";
import {$t} from "./i18n.ts";
import * as keydown_util from "./keydown_util.ts";
import * as left_sidebar_navigation_area from "./left_sidebar_navigation_area.ts";
import type {Message} from "./message_store.ts";
import * as message_view_header from "./message_view_header.ts";
import * as narrow_state from "./narrow_state.ts";
import * as narrow_title from "./narrow_title.ts";
import {page_params} from "./page_params.ts";
import * as spectators from "./spectators.ts";
import type {NarrowTerm} from "./state_data.ts";
import * as views_util from "./views_util.ts";
import * as ykphone_activity from "./ykphone_activity.ts";
import * as ykphone_places from "./ykphone_places.ts";
import * as ykphone_quick_switcher from "./ykphone_quick_switcher.ts";
import * as ykphone_recents from "./ykphone_recents.ts";
import * as ykphone_split_view from "./ykphone_split_view.ts";
import type {SplitRoute} from "./ykphone_split_view.ts";
import * as ykphone_threads from "./ykphone_threads.ts";
import * as ykphone_unread_badges from "./ykphone_unread_badges.ts";

type ListStatus = "loading" | "error" | "ready";
type ShowNarrowOpts = {trigger: string; change_hash: boolean};

// A burst of new messages reloads a page's rows once.
const RELOAD_DELAY_MS = 500;

let hide_other_views_callback: (() => void) | undefined;
// message_view.show, handed in by ui_init: importing message_view here
// would close an import cycle through its hook into this module.
let show_narrow_callback: ((terms: NarrowTerm[], opts: ShowNarrowOpts) => void) | undefined;
let list_status: ListStatus = "ready";
let search = "";
let reload_timer: ReturnType<typeof setTimeout> | undefined;
let stacked_query: MediaQueryList | undefined;

function $list(): JQuery {
    return $("#ykphone-split-list");
}

function $empty(): JQuery {
    return $("#ykphone-split-empty");
}

function is_stacked(): boolean {
    return stacked_query?.matches ?? false;
}

// ---- Rendering ----

function render_shell(route: SplitRoute): void {
    $list().html(
        render_ykphone_split_view({
            title: ykphone_split_view.page_title(route.page),
            is_dms: route.page === "dms",
            // Zulip's strict {{#if}} takes no arrays, hence the flag.
            has_tabs: route.page === "activity",
            tabs: route.page === "activity" ? ykphone_split_view.activity_tab_links(route) : [],
        }),
    );
}

// eslint-disable-next-line @typescript-eslint/consistent-return -- the switch covers every page
function rows_html(route: SplitRoute): string {
    switch (route.page) {
        case "dms": {
            const rows = ykphone_split_view.dm_rows(search, route.selection);
            const people = ykphone_split_view.people_rows(
                search,
                new Set(rows.map((row) => row.user_ids_string)),
            );
            return render_ykphone_split_dm_rows({
                rows,
                has_rows: rows.length > 0,
                people,
                has_people: people.length > 0,
                empty_label:
                    search.trim() === ""
                        ? $t({defaultMessage: "No conversations yet."})
                        : $t({defaultMessage: "No results."}),
            });
        }
        case "activity":
            return render_ykphone_activity_rows({
                loading: list_status === "loading",
                error: list_status === "error",
                has_rows: ykphone_split_view.listed_activity_items().length > 0,
                rows: ykphone_split_view.activity_rows(route),
            });
        case "threads": {
            const rows = ykphone_split_view.get_thread_rows() ?? [];
            return render_ykphone_split_thread_rows({
                loading: list_status === "loading",
                error: list_status === "error",
                has_rows: rows.length > 0,
                rows: ykphone_split_view.thread_row_contexts(route, rows),
            });
        }
    }
}

// The row's identity across renders: the link's data attribute.
function row_key(row: Element): string | undefined {
    const link = row.querySelector("a");
    return link?.getAttribute("href") ?? undefined;
}

// Draws the rows again in place: a row whose markup is unchanged keeps
// its element (and so the keyboard focus and hover it may have), other
// rows are replaced or moved into order, and the list's scroll
// position is kept. Section shapes that differ (a loading line
// replaced by rows, a search adding the People section) are replaced
// as a whole, with the focus put back on the row of the same key.
function morph_rows(body: HTMLElement, html: string): void {
    const scroll_top = body.scrollTop;
    const focused_key =
        document.activeElement instanceof HTMLElement && body.contains(document.activeElement)
            ? row_key(
                  document.activeElement.closest(".ykphone-split-item") ?? document.activeElement,
              )
            : undefined;
    const template = document.createElement("template");
    template.innerHTML = html;
    const next = template.content;
    const shape = (root: ParentNode): string =>
        [...root.children].map((child) => `${child.tagName}.${child.className}`).join("|");
    if (shape(body) !== shape(next)) {
        body.replaceChildren(next);
    } else {
        const old_lists = [...body.children];
        for (const [index, new_list] of [...next.children].entries()) {
            const old_list = old_lists[index]!;
            if (!new_list.classList.contains("ykphone-split-rows")) {
                if (old_list.outerHTML !== new_list.outerHTML) {
                    old_list.replaceWith(new_list);
                }
                continue;
            }
            const existing = new Map<string, Element>();
            for (const item of old_list.children) {
                const key = row_key(item);
                if (key !== undefined) {
                    existing.set(key, item);
                }
            }
            // Rows still in `existing` after the walk are gone or
            // changed, and are removed; a changed row's new markup is
            // inserted like a new row.
            let cursor: Element | null = old_list.firstElementChild;
            // A copy: rows are moved out of new_list while it is walked.
            // eslint-disable-next-line unicorn/no-useless-spread
            for (const new_item of [...new_list.children]) {
                const key = row_key(new_item);
                const kept = key === undefined ? undefined : existing.get(key);
                let node: Element = new_item;
                if (key !== undefined && kept?.outerHTML === new_item.outerHTML) {
                    existing.delete(key);
                    node = kept;
                }
                if (node === cursor) {
                    cursor = cursor.nextElementSibling;
                } else {
                    // cursor is null past the last row, which appends.
                    // eslint-disable-next-line unicorn/prefer-modern-dom-apis
                    old_list.insertBefore(node, cursor);
                }
            }
            for (const leftover of existing.values()) {
                leftover.remove();
            }
        }
    }
    body.scrollTop = scroll_top;
    if (focused_key !== undefined && !body.contains(document.activeElement)) {
        const $row = $list().find(`.ykphone-split-row[href="${CSS.escape(focused_key)}"]`);
        $row.trigger("focus");
    }
}

function render_rows(): void {
    const route = ykphone_split_view.get_route();
    if (route === undefined) {
        return;
    }
    const body = $list().find(".ykphone-split-list-body")[0];
    if (body !== undefined) {
        morph_rows(body, rows_html(route));
    }
}

function is_current(route: SplitRoute): boolean {
    const current = ykphone_split_view.get_route();
    return current?.page === route.page && current.tab === route.tab;
}

// Fetches the page's rows; a silent reload (new messages) keeps the
// rows on screen instead of showing the loading line.
function load_rows(opts: {silent: boolean}): void {
    const route = ykphone_split_view.get_route();
    if (route === undefined) {
        return;
    }
    if (!opts.silent) {
        list_status = route.page === "dms" ? "ready" : "loading";
        render_rows();
    }
    const on_loaded = (): void => {
        if (!is_current(route)) {
            return;
        }
        list_status = "ready";
        render_rows();
        apply_route();
    };
    const on_error = (): void => {
        if (is_current(route)) {
            list_status = "error";
            render_rows();
        }
    };
    switch (route.page) {
        case "dms":
            ykphone_split_view.load_dm_snippets(() => {
                if (is_current(route)) {
                    render_rows();
                }
            });
            break;
        case "activity":
            ykphone_activity.load(route.tab, {
                on_loaded(items) {
                    if (is_current(route)) {
                        ykphone_split_view.set_activity_items(items);
                    }
                    on_loaded();
                },
                on_error,
            });
            break;
        case "threads":
            ykphone_split_view.load_my_threads({on_loaded, on_error});
            break;
    }
}

function schedule_reload(): void {
    if (reload_timer !== undefined) {
        return;
    }
    reload_timer = setTimeout(() => {
        reload_timer = undefined;
        load_rows({silent: true});
    }, RELOAD_DELAY_MS);
}

function cancel_reload(): void {
    if (reload_timer !== undefined) {
        clearTimeout(reload_timer);
        reload_timer = undefined;
    }
}

// ---- The right column ----

// One highlight at a time: the Threads page lights the sidebar's
// Threads row, the other pages their rail item only. Upstream's
// highlighting of the conversation's channel or DM row is cleared here
// (and kept off by the theme when a sidebar rebuild draws it again).
function highlight_sidebar(): void {
    views_util.handle_message_view_deactivated(() => {
        if (ykphone_split_view.get_route()?.page === "threads") {
            left_sidebar_navigation_area.highlight_recent_view();
        } else {
            left_sidebar_navigation_area.select_top_left_corner_item("");
        }
    });
}

function show_placeholder(stale: boolean): void {
    const route = ykphone_split_view.get_route();
    if (route === undefined) {
        return;
    }
    $empty().html(
        render_ykphone_split_empty({
            icon: ykphone_split_view.page_icon(route.page),
            hint: stale
                ? $t({defaultMessage: "That conversation is no longer listed."})
                : $t({defaultMessage: "Select a conversation to read it here."}),
        }),
    );
    if (ykphone_split_view.is_placeholder_visible()) {
        // views_util.show does nothing for a view already on screen,
        // so a switch between two pages that both show the placeholder
        // (Activity → Threads) refreshes what names the page here.
        highlight_sidebar();
        narrow_title.update_narrow_title(narrow_state.filter());
        message_view_header.render_title_area();
        return;
    }
    hide_other_views_callback?.();
    views_util.show({
        highlight_view_in_left_sidebar: highlight_sidebar,
        $view: $empty(),
        update_compose() {
            compose_closed_ui.update_buttons();
        },
        is_visible: ykphone_split_view.is_placeholder_visible,
        set_visible: ykphone_split_view.set_placeholder_visible,
        complete_rerender() {
            // The placeholder has nothing to rebuild.
        },
    });
}

function hide_placeholder(): void {
    if (!ykphone_split_view.is_placeholder_visible()) {
        return;
    }
    views_util.hide({$view: $empty(), set_visible: ykphone_split_view.set_placeholder_visible});
}

function update_body_classes(): void {
    const route = ykphone_split_view.get_route();
    $("body")
        .toggleClass("ykphone-split-open", route !== undefined)
        .toggleClass("ykphone-split-selected", route?.selection !== undefined)
        .attr("data-ykphone-split", route?.page ?? null);
}

function activate(terms: NarrowTerm[]): void {
    const channel_term = terms.find((term) => term.operator === "channel");
    if (channel_term !== undefined) {
        // A thread's root is shown above its replies from the
        // channel's thread list, which the page may not have fetched.
        ykphone_threads.load_stream_threads(Number(channel_term.operand));
    }
    // Recorded before the narrow lands (a target message may have to be
    // fetched first), so a reload of the rows meanwhile does not narrow
    // again; message_view's hook hides the placeholder (this trigger
    // tells it the page stays open) and the narrow-activated hook marks
    // the row.
    ykphone_split_view.note_shown_selection(ykphone_split_view.get_route());
    show_narrow_callback?.(terms, {trigger: ykphone_split_view.TRIGGER, change_hash: false});
}

// Carries out what the right column should show for the current route
// (ykphone_split_view.resolve_route): now, and again when the rows
// arrive.
function apply_route(): void {
    const route = ykphone_split_view.get_route();
    if (route === undefined) {
        return;
    }
    const action = ykphone_split_view.resolve_route(route, {stacked: is_stacked()});
    switch (action.type) {
        case "replace_hash":
            // Like #recent_topics → #recent: the page's own hash is
            // replaced, so Back leaves the page.
            window.location.replace(action.hash);
            break;
        case "placeholder":
            show_placeholder(action.stale);
            break;
        case "activate":
            activate(action.terms);
            break;
        case "keep":
            break;
    }
}

// ---- Entry points ----

// The components of the hash after "#ykphone"; false when they name
// no page.
export function show_for_hash(parts: string[]): boolean {
    const route = ykphone_split_view.parse_hash(parts);
    if (route === undefined) {
        return false;
    }
    if (page_params.is_spectator) {
        spectators.login_to_access();
        return true;
    }
    const previous = ykphone_split_view.get_route();
    ykphone_split_view.set_route(route);
    update_body_classes();
    switch (ykphone_split_view.plan_show(previous, route)) {
        case "page":
            ykphone_recents.note_visit(ykphone_places.page_place(route.page));
            ykphone_quick_switcher.invalidate();
            search = "";
            ykphone_split_view.note_shown_selection(undefined);
            ykphone_split_view.clear_activity_items();
            cancel_reload();
            render_shell(route);
            load_rows({silent: false});
            break;
        case "tab":
            render_shell(route);
            load_rows({silent: false});
            break;
        case "rows":
            render_rows();
            break;
    }
    apply_route();
    return true;
}

// Called from message_view.show for every narrow: a narrow the page
// activated keeps it open (and replaces the placeholder), any other
// narrow leaves the page.
export function handle_narrow(opts: {trigger?: string | undefined}): void {
    if (!ykphone_split_view.is_open()) {
        return;
    }
    if (opts.trigger === ykphone_split_view.TRIGGER) {
        hide_placeholder();
        return;
    }
    close();
}

// Called (through ykphone_ui_hooks) once a narrow is active.
export function handle_narrow_activated(): void {
    const route = ykphone_split_view.get_route();
    if (route === undefined) {
        return;
    }
    ykphone_split_view.note_shown_selection(route);
    render_rows();
    highlight_sidebar();
    // The message an activity row points at is highlighted until the
    // pointer moves over the feed (ykphone_threads_ui clears the
    // class with the keyboard-navigation one).
    $("body").toggleClass(
        "ykphone-split-highlight",
        route.page === "activity" && route.selection !== undefined,
    );
}

export function close(): void {
    if (!ykphone_split_view.is_open()) {
        return;
    }
    cancel_reload();
    hide_placeholder();
    ykphone_split_view.set_route(undefined);
    ykphone_split_view.note_shown_selection(undefined);
    ykphone_split_view.clear_activity_items();
    update_body_classes();
    $("body").removeClass("ykphone-split-highlight");
    $list().html("");
}

export function clear_highlight(): void {
    $("body").removeClass("ykphone-split-highlight");
}

// ---- Live updates ----

export function on_new_messages(messages: Message[]): void {
    switch (ykphone_split_view.refresh_for_messages(messages)) {
        case "rows":
            render_rows();
            break;
        case "reload":
            schedule_reload();
            break;
        case undefined:
            break;
    }
}

// A reaction added to or removed from one of the user's messages
// changes the Activity rows.
export function on_reaction_change(event: {message_id: number; user_id: number}): void {
    if (ykphone_split_view.reaction_affects_activity(event)) {
        schedule_reload();
    }
}

export function initialize({
    hide_other_views,
    show_narrow,
}: {
    hide_other_views: () => void;
    show_narrow: (terms: NarrowTerm[], opts: ShowNarrowOpts) => void;
}): void {
    hide_other_views_callback = hide_other_views;
    show_narrow_callback = show_narrow;
    // The list is the middle column's first grid column; the
    // placeholder sits with the other views in the column's inner box.
    $(".app-main .column-middle").prepend(
        $("<div>").attr("id", "ykphone-split-list").addClass("ykphone-split-list"),
    );
    $("#message_feed_container").before(
        $("<div>").attr("id", "ykphone-split-empty").addClass("ykphone-split-empty").hide(),
    );
    if (typeof window.matchMedia === "function") {
        stacked_query = window.matchMedia(ykphone_split_view.STACKED_MEDIA_QUERY);
        // A window widened past the breakpoint with only the list on
        // screen gets the page's default selection.
        stacked_query.addEventListener("change", () => {
            const route = ykphone_split_view.get_route();
            if (route !== undefined && route.selection === undefined) {
                apply_route();
            }
        });
    }
    // Unread counts drawn by upstream (and the sidebar badges) change
    // the rows' bold names, counts and dots.
    ykphone_unread_badges.on_counts_updated(() => {
        if (ykphone_split_view.is_open()) {
            render_rows();
        }
    });

    // A filter chip keeps the conversation on the right; upstream's
    // document click handler would otherwise refocus the compose box
    // (any click inside a link while composing), and the composer's
    // focus handoff scrolls the feed away from the selected message.
    $("body").on("click", ".ykphone-activity-tab", (e) => {
        e.stopPropagation();
    });
    $("body").on("input", ".ykphone-split-search-input", function (this: HTMLElement) {
        search = String($(this).val() ?? "");
        render_rows();
    });
    // Enter opens the first match, as in Slack's search field.
    $("body").on("keydown", ".ykphone-split-search-input", (e) => {
        if (!keydown_util.is_enter_event(e)) {
            return;
        }
        const href = $list().find(".ykphone-split-row").first().attr("href");
        if (href !== undefined) {
            e.preventDefault();
            browser_history.go_to_location(href);
        }
    });
}
