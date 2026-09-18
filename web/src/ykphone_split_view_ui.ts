// DOM side of the split-pane pages (DM, Activity, Threads, search, Drafts &
// sent, Later, unread messages) for the
// 옆커폰 web UI: the list column at the left of the middle pane, the
// placeholder shown on the right while nothing is selected (through
// views_util, like the inbox), and the narrows activated for a
// selection. Every decision (what a route needs, what the right column
// shows, whether new messages change the rows) is made in
// ykphone_split_view.ts and only carried out here; this module is
// exempt from node coverage like ykphone_threads_ui.

import $ from "jquery";

import render_left_sidebar_expanded_view_item from "../templates/left_sidebar_expanded_view_item.hbs";
import render_ykphone_activity_rows from "../templates/ykphone_activity_rows.hbs";
import render_ykphone_confirm_mark_activity_read from "../templates/ykphone_confirm_mark_activity_read.hbs";
import render_ykphone_drafts_rows from "../templates/ykphone_drafts_rows.hbs";
import render_ykphone_due_menu from "../templates/ykphone_due_menu.hbs";
import render_ykphone_file_rows from "../templates/ykphone_file_rows.hbs";
import render_ykphone_saved_rows from "../templates/ykphone_saved_rows.hbs";
import render_ykphone_search_header from "../templates/ykphone_search_header.hbs";
import render_ykphone_search_message_rows from "../templates/ykphone_search_message_rows.hbs";
import render_ykphone_search_place_rows from "../templates/ykphone_search_place_rows.hbs";
import render_ykphone_split_dm_rows from "../templates/ykphone_split_dm_rows.hbs";
import render_ykphone_split_empty from "../templates/ykphone_split_empty.hbs";
import render_ykphone_split_thread_rows from "../templates/ykphone_split_thread_rows.hbs";
import render_ykphone_split_view from "../templates/ykphone_split_view.hbs";
import render_ykphone_unreads_rows from "../templates/ykphone_unreads_rows.hbs";

import * as browser_history from "./browser_history.ts";
import * as compose_actions from "./compose_actions.ts";
import * as compose_closed_ui from "./compose_closed_ui.ts";
import * as confirm_dialog from "./confirm_dialog.ts";
import * as drafts from "./drafts.ts";
import * as feedback_widget from "./feedback_widget.ts";
import * as flatpickr from "./flatpickr.ts";
import {$t, $t_html} from "./i18n.ts";
import * as keydown_util from "./keydown_util.ts";
import * as left_sidebar_navigation_area from "./left_sidebar_navigation_area.ts";
import * as message_flags from "./message_flags.ts";
import type {Message} from "./message_store.ts";
import * as message_view_header from "./message_view_header.ts";
import * as narrow_state from "./narrow_state.ts";
import * as narrow_title from "./narrow_title.ts";
import {page_params} from "./page_params.ts";
import * as popover_menus from "./popover_menus.ts";
import * as scheduled_messages from "./scheduled_messages.ts";
import * as spectators from "./spectators.ts";
import * as starred_messages_ui from "./starred_messages_ui.ts";
import type {NarrowTerm} from "./state_data.ts";
import * as ui_util from "./ui_util.ts";
import * as unread from "./unread.ts";
import * as unread_ops from "./unread_ops.ts";
import * as util from "./util.ts";
import * as views_util from "./views_util.ts";
import * as ykphone_activity from "./ykphone_activity.ts";
import * as ykphone_drafts_page from "./ykphone_drafts_page.ts";
import * as ykphone_files from "./ykphone_files.ts";
import * as ykphone_places from "./ykphone_places.ts";
import * as ykphone_quick_switcher from "./ykphone_quick_switcher.ts";
import * as ykphone_recents from "./ykphone_recents.ts";
import * as ykphone_saved from "./ykphone_saved.ts";
import * as ykphone_search from "./ykphone_search.ts";
import * as ykphone_search_suggestions from "./ykphone_search_suggestions.ts";
import * as ykphone_split_view from "./ykphone_split_view.ts";
import type {SplitRoute} from "./ykphone_split_view.ts";
import * as ykphone_threads from "./ykphone_threads.ts";
import * as ykphone_unread_badges from "./ykphone_unread_badges.ts";
import * as ykphone_unreads from "./ykphone_unreads.ts";

type ListStatus = "loading" | "error" | "ready";
type ShowNarrowOpts = {trigger: string; change_hash: boolean};

// A burst of new messages reloads a page's rows once.
const RELOAD_DELAY_MS = 500;

let hide_other_views_callback: (() => void) | undefined;
// message_view.show, handed in by ui_init: importing message_view here
// would close an import cycle through its hook into this module.
let show_narrow_callback: ((terms: NarrowTerm[], opts: ShowNarrowOpts) => void) | undefined;
// scheduled_messages_ui.edit_scheduled_message, handed in by ui_init for
// the same reason (it imports message_view).
// compose.clear_compose_box, handed in for the same reason.
let clear_compose_box_callback: (() => void) | undefined;
let edit_scheduled_message_callback:
    | ((scheduled_message_id: number, should_narrow_to_recipient: boolean) => void)
    | undefined;
let list_status: ListStatus = "ready";
let search = "";
let reload_timer: ReturnType<typeof setTimeout> | undefined;
// The filter bar control to put the keyboard back on once the search
// page has been drawn again.
let pending_focus: string | undefined;
let stacked_query: MediaQueryList | undefined;
// What to do once a selection's conversation is on the right: put a
// draft or a scheduled message in the composer (the Drafts & sent page).
let pending_compose: {selection: string; run: () => void} | undefined;
// The saved message whose "Set due date" menu is open. The row is drawn
// with its button marked open, so that a redraw (a count, a relative
// time) keeps the button element the menu hangs from.
let due_menu_message_id: number | undefined;

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
            is_search: route.page === "search",
            query_label:
                route.query === undefined || route.query === ""
                    ? $t({defaultMessage: "No search terms"})
                    : ykphone_search_suggestions.search_label(route.query),
            ...tabs_context(route),
            is_activity: route.page === "activity",
            // Reactions have no unread state to clear.
            can_mark_all_read: route.page === "activity" && route.tab !== "reactions",
            unread_only: ykphone_split_view.is_activity_unread_only(),
        }),
    );
    if (route.page === "search") {
        render_search_header(route);
    }
}

function tabs_context(route: SplitRoute): {
    has_tabs: boolean;
    tabs_label: string;
    tabs: ykphone_split_view.PageTabLink[];
} {
    const tabs =
        route.page === "activity"
            ? ykphone_split_view.activity_tab_links(route).map((link) => ({...link, count: ""}))
            : ykphone_split_view.page_tab_links(route);
    return {
        // Zulip's strict {{#if}} takes no arrays, hence the flag.
        has_tabs: tabs.length > 0,
        tabs_label:
            route.page === "activity"
                ? $t({defaultMessage: "Activity filters"})
                : ykphone_split_view.page_title(route.page),
        tabs,
    };
}

// The tab row alone (the Later page's count changes under it).
function render_tabs(route: SplitRoute): void {
    const context = tabs_context(route);
    const $nav = $list().find(".ykphone-activity-tabs");
    for (const [index, tab] of context.tabs.entries()) {
        const $tab = $nav.children().eq(index);
        $tab.find(".ykphone-activity-tab-count").remove();
        if (tab.count !== "") {
            $tab.append(" ", $("<span>").addClass("ykphone-activity-tab-count").text(tab.count));
        }
    }
}

// The search page's tabs (with their counts) and its filter bar; drawn
// again whenever the results, a filter or the sort change, without
// touching the rows below.
function render_search_header(route: SplitRoute): void {
    const facets = ykphone_search.facet_messages(route.query ?? "");
    const filters: {name: string; label: string; options: ykphone_files.FilterOption[]}[] = [];
    if (route.tab === "files") {
        // The rows the tab shows before its own facets: a 종류 the
        // date range has emptied is not offered.
        const rows = ykphone_split_view.search_file_rows(route, {facets: false});
        const file_filters = ykphone_search.get_file_filters();
        filters.push(
            {
                name: "kind",
                label: $t({defaultMessage: "File type"}),
                options: ykphone_files.kind_options(rows, file_filters),
            },
            {
                name: "file-sender",
                label: $t({defaultMessage: "Shared by"}),
                options: ykphone_files.sender_options(rows, file_filters),
            },
            {
                name: "file-channel",
                label: $t({defaultMessage: "Channel"}),
                options: ykphone_files.channel_options(rows, file_filters),
            },
        );
    } else if (route.tab === "messages") {
        filters.push(
            {
                name: "sender",
                label: $t({defaultMessage: "Sent by"}),
                options: ykphone_search.message_sender_options(facets, route.query ?? ""),
            },
            {
                name: "channel",
                label: $t({defaultMessage: "Channel"}),
                options: ykphone_search.message_channel_options(facets, route.query ?? ""),
            },
        );
    }
    const has_message_filters = route.tab === "messages" || route.tab === "files";
    if (has_message_filters) {
        filters.push(
            {
                name: "date",
                label: $t({defaultMessage: "Date"}),
                options: ykphone_search.date_options(route.range ?? "any"),
            },
            {
                name: "sort",
                label: $t({defaultMessage: "Sort"}),
                options: ykphone_search.sort_options(route.sort ?? "newest"),
            },
        );
    }
    $list()
        .find(".ykphone-search-header")
        .html(
            render_ykphone_search_header({
                tabs: ykphone_split_view.search_tab_links(route),
                has_filters: filters.length > 0,
                filters,
                has_attachment_toggle: route.tab === "messages",
                has_attachment: ykphone_search.has_operand(route.query ?? "", "has", "attachment"),
            }),
        );
    // A control that redrew itself keeps the keyboard, including one
    // whose change rewrote the query and drew the whole page again.
    // The bar is drawn more than once while a search runs, so the
    // control is put back on every one of them and forgotten when the
    // results land.
    if (pending_focus !== undefined) {
        $list()
            .find(`[data-ykphone-filter="${CSS.escape(pending_focus)}"]`)
            .trigger("focus");
    }
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
        case "activity": {
            const rows = ykphone_split_view.activity_rows(route);
            return render_ykphone_activity_rows({
                loading: list_status === "loading",
                error: list_status === "error",
                has_rows: rows.length > 0,
                rows,
                empty_label: ykphone_split_view.is_activity_unread_only()
                    ? $t({defaultMessage: "No unread activity."})
                    : $t({defaultMessage: "No activity yet."}),
            });
        }
        case "threads": {
            const rows = ykphone_split_view.get_thread_rows() ?? [];
            return render_ykphone_split_thread_rows({
                loading: list_status === "loading",
                error: list_status === "error",
                has_rows: rows.length > 0,
                rows: ykphone_split_view.thread_row_contexts(route, rows),
            });
        }
        case "search":
            return search_rows_html(route);
        case "drafts": {
            const tab = ykphone_drafts_page.is_drafts_tab(route.tab) ? route.tab : "drafts";
            const rows = ykphone_drafts_page.page_rows(tab, {
                selection: route.selection,
                hash_for: (id) => ykphone_split_view.route_hash(route, id),
                now: new Date(),
            });
            return render_ykphone_drafts_rows({
                loading: list_status === "loading",
                error: list_status === "error",
                has_rows: rows.length > 0,
                rows,
                empty_label: ykphone_drafts_page.empty_label(tab),
            });
        }
        case "saved": {
            const state = ykphone_split_view.saved_state(route);
            const rows = ykphone_saved
                .row_contexts(state, {
                    selection: route.selection,
                    hash_for: (message_id) =>
                        ykphone_split_view.route_hash(route, message_id.toString()),
                    now: new Date(),
                })
                .map((row) => ({...row, is_menu_open: row.message_id === due_menu_message_id}));
            return render_ykphone_saved_rows({
                loading: list_status === "loading" && rows.length === 0,
                error: list_status === "error",
                has_rows: rows.length > 0,
                rows,
                empty_label: ykphone_saved.empty_label(state),
            });
        }
        case "unreads": {
            const groups = ykphone_unreads.group_contexts({
                selection: route.selection,
                hash_for: (selection) => ykphone_split_view.route_hash(route, selection),
            });
            const hidden_count =
                list_status === "ready" ? ykphone_unreads.hidden_unread_message_ids().length : 0;
            return render_ykphone_unreads_rows({
                loading: list_status === "loading",
                error: list_status === "error",
                has_rows: groups.length > 0,
                groups,
                has_hidden: hidden_count > 0,
                hidden_label: $t(
                    {
                        defaultMessage:
                            "{count, plural, one {# older unread message is not shown here.} other {# older unread messages are not shown here.}}",
                    },
                    {count: hidden_count},
                ),
            });
        }
    }
}

function search_rows_html(route: SplitRoute): string {
    const words = ykphone_search.search_words(route.query ?? "");
    const hash_for = (selection: string): string => ykphone_split_view.route_hash(route, selection);
    // A query the page could not run says so; it did not search and
    // find nothing.
    const empty_label = ykphone_search.is_query_invalid()
        ? $t({defaultMessage: "That search could not be understood."})
        : route.query === undefined || route.query === ""
          ? $t({defaultMessage: "Type in the search bar to search."})
          : $t({defaultMessage: "No results."});
    const words_label = $t({defaultMessage: "Channels and people are found by words."});
    switch (route.tab) {
        case "files": {
            const rows = ykphone_split_view.search_file_rows(route);
            return render_ykphone_file_rows({
                loading: ykphone_search.is_loading(),
                error: ykphone_search.has_failed(),
                has_rows: rows.length > 0,
                empty_label,
                rows: ykphone_files.row_contexts(rows, {
                    hash_for: (row) => hash_for(row.message_id.toString()),
                    words,
                    selection: route.selection,
                }),
            });
        }
        case "channels":
            return place_rows_html(
                ykphone_search.channel_rows(words, {selection: route.selection, hash_for}),
                words.length === 0 ? words_label : $t({defaultMessage: "No channels match."}),
            );
        case "people":
            return place_rows_html(
                ykphone_search.people_rows(words, {selection: route.selection, hash_for}),
                words.length === 0 ? words_label : $t({defaultMessage: "No people match."}),
            );
        default: {
            const messages = ykphone_split_view.search_messages(route);
            return render_ykphone_search_message_rows({
                loading: ykphone_search.is_loading(),
                error: ykphone_search.has_failed(),
                error_label: $t({defaultMessage: "Could not run that search."}),
                has_rows: messages.length > 0,
                empty_label,
                rows: ykphone_search.message_rows(messages, {
                    selection: route.selection,
                    hash_for,
                }),
            });
        }
    }
}

function place_rows_html(rows: ykphone_search.PlaceRowContext[], empty_label: string): string {
    return render_ykphone_search_place_rows({
        has_rows: rows.length > 0,
        rows,
        empty_label,
    });
}

// The row's identity across renders: the link's data attribute.
function row_key(row: Element): string | undefined {
    // A file row carries its own key: its first link is the file, not
    // the row, and the same file can be in two messages.
    const own = row.getAttribute("data-row-key");
    if (own !== null) {
        return own;
    }
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

// The Activity page's own tab; SplitTab also covers the search page's.
function activity_tab(route: SplitRoute): ykphone_activity.ActivityTab {
    return ykphone_activity.TABS.find((tab) => tab === route.tab) ?? "all";
}

function is_current(route: SplitRoute): boolean {
    const current = ykphone_split_view.get_route();
    if (current?.page !== route.page) {
        return false;
    }
    // The search page's tabs share one fetch, so a tab switch does not
    // make a response that is on the way stale; a new query does.
    if (route.page === "search") {
        return current.query === route.query;
    }
    return current.tab === route.tab;
}

// Fetches the page's rows; a silent reload (new messages) keeps the
// rows on screen instead of showing the loading line.
function load_rows(opts: {silent: boolean}): void {
    const route = ykphone_split_view.get_route();
    if (route === undefined) {
        return;
    }
    if (!opts.silent) {
        const known_up_front =
            route.page === "dms" || (route.page === "drafts" && route.tab !== "sent");
        list_status = known_up_front ? "ready" : "loading";
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
            ykphone_activity.load(activity_tab(route), {
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
        case "search":
            // The search module keeps its own loading and error state
            // (two requests: the messages and the files of one query).
            ykphone_search.load(
                route.query ?? "",
                {sort: route.sort ?? "newest", range: route.range ?? "any"},
                () => {
                    const current = ykphone_split_view.get_route();
                    if (current === undefined || !is_current(route)) {
                        return;
                    }
                    render_search_header(current);
                    render_rows();
                    apply_route();
                    pending_focus = undefined;
                },
            );
            render_search_header(route);
            render_rows();
            break;
        case "drafts":
            // Drafts and scheduled messages are known; sent ones are
            // fetched.
            if (route.tab === "sent") {
                ykphone_drafts_page.load_sent({on_loaded, on_error});
            } else {
                on_loaded();
            }
            break;
        case "saved":
            if (ykphone_saved.is_loaded() && !opts.silent) {
                load_saved_messages(route, on_loaded, on_error);
            } else {
                ykphone_saved.load({
                    on_loaded() {
                        load_saved_messages(route, on_loaded, on_error);
                    },
                    on_error,
                });
            }
            break;
        case "unreads":
            ykphone_unreads.load({on_loaded, on_error});
            break;
    }
}

// The rows of a saved item need its message, fetched once.
function load_saved_messages(route: SplitRoute, on_loaded: () => void, on_error: () => void): void {
    ykphone_saved.load_messages(
        ykphone_saved.missing_message_ids(ykphone_split_view.saved_state(route)),
        {on_loaded, on_error},
    );
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
        const page = ykphone_split_view.get_route()?.page;
        if (page === "threads") {
            left_sidebar_navigation_area.highlight_recent_view();
            return;
        }
        // The sidebar rows that open the other pages.
        const rows: Partial<Record<ykphone_split_view.SplitPage, string>> = {
            drafts: ".top_left_drafts",
            saved: ".top_left_starred_messages",
            unreads: ".top_left_ykphone_unreads",
        };
        left_sidebar_navigation_area.select_top_left_corner_item(
            page === undefined ? "" : (rows[page] ?? ""),
        );
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
            after_activate(route);
            break;
        case "keep":
            run_pending_compose(route);
            break;
    }
}

// ---- The Drafts & sent page's composer ----

function restore_draft(draft_id: string): void {
    const draft = drafts.draft_model.getDraft(draft_id);
    if (!draft) {
        return;
    }
    // As the drafts overlay does, less the narrow (the page has made
    // it): the draft replaces whatever the box holds, which is saved
    // as a draft of its own first.
    const compose_args = {...drafts.restore_message(draft), draft_id};
    compose_actions.start({...compose_args, message_type: compose_args.type});
}

function run_pending_compose(route: SplitRoute): void {
    if (pending_compose === undefined || pending_compose.selection !== route.selection) {
        return;
    }
    const {run} = pending_compose;
    pending_compose = undefined;
    run();
}

// A draft opens in the composer of its conversation, once that
// conversation is on the right.
function after_activate(route: SplitRoute): void {
    if (route.page === "drafts" && route.tab === "drafts" && route.selection !== undefined) {
        restore_draft(route.selection);
    }
    run_pending_compose(route);
}

// Opens the row's conversation (if it is not on the right already) and
// then runs `run` there.
function select_then(route: SplitRoute, selection: string, run: () => void): void {
    pending_compose = {selection, run};
    if (route.selection === selection && ykphone_split_view.is_narrow_shown_for(route)) {
        run_pending_compose(route);
        return;
    }
    browser_history.go_to_location(ykphone_split_view.route_hash(route, selection));
}

function handle_drafts_action(route: SplitRoute, action: string, id: string): void {
    switch (action) {
        case "delete":
            // The draft open in the composer goes with its text, as
            // when a message is sent; otherwise what is typed next
            // would be saved to a draft that no longer exists.
            if (drafts.compose_draft_id === id) {
                clear_compose_box_callback?.();
            }
            drafts.draft_model.deleteDrafts([id]);
            break;
        case "edit": {
            const scheduled_message_id = Number(id);
            select_then(route, id, () => {
                // The scheduled message is unscheduled and put in the
                // composer, which upstream's banner can schedule again.
                edit_scheduled_message_callback?.(scheduled_message_id, false);
            });
            break;
        }
        case "cancel":
            scheduled_messages.delete_scheduled_message(Number(id));
            break;
    }
}

// ---- The Later page ----

const saved_callbacks = {
    on_error(): void {
        feedback_widget.show({
            title_text: $t({defaultMessage: "Later"}),
            populate($container) {
                $container.text($t({defaultMessage: "Could not update the saved message."}));
            },
        });
    },
};

function handle_saved_action(action: string, message_id: number, button: HTMLElement): void {
    switch (action) {
        case "complete":
            ykphone_saved.set_state(message_id, "completed", saved_callbacks);
            break;
        case "archive":
            ykphone_saved.set_state(message_id, "archived", saved_callbacks);
            break;
        case "restore":
            ykphone_saved.set_state(message_id, "in_progress", saved_callbacks);
            break;
        case "due":
            open_due_menu(button, message_id);
            break;
    }
}

function open_due_menu(button: HTMLElement, message_id: number): void {
    const now = new Date();
    const presets = ykphone_saved.due_presets(now);
    const $button = $(button);
    popover_menus.toggle_popover_menu(
        button,
        {
            theme: "popover-menu",
            placement: "bottom-end",
            onCreate(instance) {
                instance.setContent(
                    ui_util.parse_html(
                        render_ykphone_due_menu({
                            presets,
                            has_due: (ykphone_saved.get_item(message_id)?.due ?? null) !== null,
                        }),
                    ),
                );
            },
            onMount(instance) {
                popover_menus.focus_popover(instance);
                due_menu_message_id = message_id;
                $button.addClass("ykphone-row-action-open");
                const $popper = $(instance.popper);
                $popper.on("click", ".ykphone-due-preset", function (this: HTMLElement, e) {
                    e.preventDefault();
                    e.stopPropagation();
                    const preset = presets.find(
                        (candidate) => candidate.id === this.dataset["ykphonePreset"],
                    );
                    popover_menus.hide_current_popover_if_visible(instance);
                    if (preset !== undefined) {
                        ykphone_saved.set_due(
                            message_id,
                            ykphone_saved.due_seconds_for(preset, new Date()),
                            saved_callbacks,
                        );
                    }
                });
                $popper.on("click", ".ykphone-due-remove", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    popover_menus.hide_current_popover_if_visible(instance);
                    ykphone_saved.set_due(message_id, null, saved_callbacks);
                });
                $popper.on("click", ".ykphone-due-custom", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const current = ykphone_saved.get_item(message_id)?.due;
                    flatpickr.show_flatpickr(
                        util.the($popper.find(".ykphone-due-custom")),
                        (time) => {
                            popover_menus.hide_current_popover_if_visible(instance);
                            ykphone_saved.set_due(
                                message_id,
                                Math.floor(new Date(time).getTime() / 1000),
                                saved_callbacks,
                            );
                        },
                        current === undefined || current === null
                            ? new Date(Date.now() + 60 * 60 * 1000)
                            : new Date(current * 1000),
                    );
                });
            },
            onShow(instance) {
                popover_menus.on_show_prep(instance);
            },
            onHidden(instance) {
                due_menu_message_id = undefined;
                $button.removeClass("ykphone-row-action-open");
                instance.destroy();
            },
        },
        {get_focus_return_element: () => button},
    );
}

// ---- The unread messages page ----

function mark_group_read(key: string): void {
    const group = ykphone_unreads.groups().find((candidate) => candidate.key === key);
    if (group === undefined) {
        return;
    }
    message_flags.mark_as_read(ykphone_unreads.conversation_unread_ids(group));
}

// J and K move between the groups while the list has the keyboard or
// nothing is open on the right (upstream's j/k scroll the feed of an
// open conversation, and keep doing so).
function handle_unreads_key(e: KeyboardEvent): void {
    const route = ykphone_split_view.get_route();
    // The physical key, as upstream's hotkeys read it for non-Latin
    // layouts: with the 한글 input source on, J types "ㅓ".
    const direction = e.code === "KeyJ" ? 1 : e.code === "KeyK" ? -1 : undefined;
    if (
        route?.page !== "unreads" ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        e.shiftKey ||
        direction === undefined
    ) {
        return;
    }
    const active = document.activeElement;
    const in_list = active instanceof HTMLElement && $list()[0]?.contains(active) === true;
    const typing =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);
    if (typing || (!in_list && !ykphone_split_view.is_placeholder_visible())) {
        return;
    }
    const $links = $list().find(".ykphone-unreads-group-link");
    const keys = $links.toArray().map((link) => link.dataset["ykphoneGroup"] ?? "");
    const current =
        in_list && active instanceof HTMLElement
            ? active.closest<HTMLElement>(".ykphone-unreads-group")?.dataset["rowKey"]
            : undefined;
    const next = ykphone_unreads.adjacent_group_key(keys, current, direction);
    if (next === undefined) {
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    const link = [...$links].find((candidate) => candidate.dataset["ykphoneGroup"] === next);
    link?.focus();
    link?.scrollIntoView({block: "nearest"});
}

// ---- The Activity page's "Mark all as read" ----

function carry_out_mark_read(plan: ykphone_split_view.ActivityMarkReadPlan): void {
    for (const narrow of plan.narrows) {
        unread_ops.bulk_update_read_flags_for_narrow(narrow, "add");
    }
    if (plan.message_ids.length > 0) {
        message_flags.mark_as_read(plan.message_ids);
    }
}

// Direct messages are not what one expects "activity" to mean, so the
// All tab asks before marking them.
function mark_activity_read(plan: ykphone_split_view.ActivityMarkReadPlan): void {
    if (plan.direct_message_count === 0) {
        carry_out_mark_read(plan);
        return;
    }
    confirm_dialog.launch({
        modal_title_html: $t_html({defaultMessage: "Mark all activity as read?"}),
        modal_content_html: render_ykphone_confirm_mark_activity_read({
            direct_messages_label: $t(
                {
                    defaultMessage:
                        "{count, plural, one {# unread direct message} other {# unread direct messages}} will be marked as read.",
                },
                {count: plan.direct_message_count},
            ),
        }),
        modal_submit_button_text: $t({defaultMessage: "Mark as read"}),
        on_click() {
            carry_out_mark_read(plan);
        },
    });
}

// ---- The sidebar row of the unread messages page ----

function update_unreads_row(): void {
    const count = unread.get_counts().home_unread_messages;
    ui_util.update_unread_count_in_dom($(".top_left_ykphone_unreads"), count);
}

// ---- The search page's filter bar ----

// A filter that Zulip has an operator for rewrites the query, so the
// page's URL always says what is being searched; the date range and
// the file facets, which have no operator, are applied to the results
// the search brought back.
function handle_search_filter(route: SplitRoute, name: string, value: string): void {
    const query = route.query ?? "";
    const operand = value === "" ? undefined : value;
    // The control keeps the keyboard across the redraw the change
    // causes, whether that redraw is this page's or a new one's.
    pending_focus = name;
    const go_to = (opts: {
        query?: string;
        sort?: ykphone_search.SortOrder;
        range?: ykphone_search.DateRange;
    }): void => {
        browser_history.go_to_location(
            ykphone_split_view.page_hash("search", {
                tab: route.tab,
                query: opts.query ?? query,
                sort: opts.sort ?? route.sort,
                range: opts.range ?? route.range,
            }),
        );
    };
    switch (name) {
        case "sender":
            go_to({query: ykphone_search.query_with_operator(query, "sender", operand)});
            return;
        case "channel":
            go_to({query: ykphone_search.query_with_operator(query, "channel", operand)});
            return;
        case "attachment":
            go_to({
                query: ykphone_search.query_with_has_attachment(
                    query,
                    !ykphone_search.has_operand(query, "has", "attachment"),
                ),
            });
            return;
        case "sort":
            // The order and the date range belong in the URL, so a
            // reload and Back show what the page showed.
            go_to({sort: value === "oldest" ? "oldest" : "newest"});
            return;
        case "date":
            if (ykphone_search.is_date_range(value)) {
                go_to({range: value});
            }
            return;
        case "kind": {
            const filters = ykphone_search.get_file_filters();
            ykphone_search.set_file_filters({
                ...filters,
                kind: ykphone_files.is_file_kind(value) ? value : "any",
            });
            break;
        }
        case "file-sender": {
            const filters = ykphone_search.get_file_filters();
            ykphone_search.set_file_filters({
                ...filters,
                sender_id: operand === undefined ? undefined : Number(operand),
            });
            break;
        }
        case "file-channel": {
            const filters = ykphone_search.get_file_filters();
            ykphone_search.set_file_filters({
                ...filters,
                stream_id: operand === undefined ? undefined : Number(operand),
            });
            break;
        }
        default:
            pending_focus = undefined;
            return;
    }
    render_search_header(route);
    render_rows();
    pending_focus = undefined;
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
            if (route.page === "search") {
                // The file facets name one result set; the sort and
                // the date range are in the route.
                ykphone_search.reset_facets();
                if (previous?.page !== "search") {
                    pending_focus = undefined;
                }
            } else {
                ykphone_recents.note_visit(ykphone_places.page_place(route.page));
            }
            ykphone_quick_switcher.invalidate();
            search = "";
            ykphone_split_view.note_shown_selection(undefined);
            ykphone_split_view.clear_activity_items();
            cancel_reload();
            render_shell(route);
            load_rows({silent: false});
            break;
        case "tab":
            if (route.page === "search") {
                // Every tab of a search is answered by the one fetch
                // the page already made.
                render_search_header(route);
                render_rows();
                break;
            }
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

// Messages were edited, moved or deleted (message_events): the pages
// that keep their own copies of messages read them again.
export function on_messages_changed(message_ids: number[]): void {
    const route = ykphone_split_view.get_route();
    const saved_forgot = ykphone_saved.forget_messages(message_ids);
    if (route?.page === "saved" && saved_forgot) {
        load_rows({silent: true});
    } else if (
        route?.page === "unreads" &&
        message_ids.some((message_id) => ykphone_unreads.has_message(message_id))
    ) {
        schedule_reload();
    } else if (
        route?.page === "drafts" &&
        route.tab === "sent" &&
        message_ids.some(
            (message_id) => ykphone_drafts_page.find_sent_message(message_id) !== undefined,
        )
    ) {
        schedule_reload();
    }
}

// Scheduled messages were added, changed or sent (server_events_dispatch).
export function on_scheduled_messages_changed(): void {
    const route = ykphone_split_view.get_route();
    if (route?.page === "drafts" && route.tab === "scheduled") {
        render_rows();
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
    edit_scheduled_message,
    clear_compose_box,
}: {
    hide_other_views: () => void;
    show_narrow: (terms: NarrowTerm[], opts: ShowNarrowOpts) => void;
    edit_scheduled_message: (
        scheduled_message_id: number,
        should_narrow_to_recipient: boolean,
    ) => void;
    clear_compose_box: () => void;
}): void {
    hide_other_views_callback = hide_other_views;
    show_narrow_callback = show_narrow;
    edit_scheduled_message_callback = edit_scheduled_message;
    clear_compose_box_callback = clear_compose_box;
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
        update_unreads_row();
        if (ykphone_split_view.is_open()) {
            render_rows();
        }
    });

    // The sidebar rows of the fork's pages: Zulip's "Drafts" and
    // "Later" rows lead to them (the #drafts, #scheduled and
    // #narrow/is/starred views stay reachable by URL), and the unread
    // messages page gets a row under the views, as Slack's optional
    // "All unreads" item.
    $(".top_left_drafts .left-sidebar-navigation-label-container").attr(
        "href",
        ykphone_split_view.page_hash("drafts"),
    );
    $(".top_left_starred_messages .left-sidebar-navigation-label-container").attr(
        "href",
        ykphone_split_view.page_hash("saved"),
    );
    $("#left-sidebar-navigation-list").append(
        $(
            render_left_sidebar_expanded_view_item({
                css_class_suffix: "ykphone_unreads",
                hidden_for_spectators: true,
                is_home_view: false,
                fragment: "ykphone/unreads",
                tooltip_template_id: "",
                icon: "zulip-icon-unread",
                name: ykphone_split_view.page_title("unreads"),
                unread_count_type: "normal-count",
                unread_count: 0,
                supports_masked_unread: false,
                menu_icon_class: undefined,
                menu_aria_label: "",
            }),
        ),
    );
    update_unreads_row();

    ykphone_drafts_page.set_drafts_source(() => drafts.draft_model.get());
    ykphone_drafts_page.on_drafts_changed(() => {
        const route = ykphone_split_view.get_route();
        if (route?.page === "drafts" && route.tab === "drafts") {
            render_rows();
        }
    });
    ykphone_saved.on_change(() => {
        // The sidebar's Later row counts what is in progress.
        starred_messages_ui.rerender_ui();
        const route = ykphone_split_view.get_route();
        if (route?.page !== "saved") {
            return;
        }
        render_tabs(route);
        render_rows();
        // A message saved elsewhere is fetched for its row.
        const missing = ykphone_saved.missing_message_ids(ykphone_split_view.saved_state(route));
        if (missing.length > 0) {
            ykphone_saved.load_messages(missing, {
                on_loaded() {
                    if (ykphone_split_view.get_route()?.page === "saved") {
                        render_rows();
                    }
                },
                on_error() {
                    // The row appears on the next visit.
                },
            });
        }
    });
    // The Later count in the sidebar is known once the list is.
    if (!page_params.is_spectator) {
        ykphone_saved.load({
            on_loaded() {
                // on_change has drawn the count.
            },
            on_error() {
                // Upstream's starred count stays.
            },
        });
    }

    // Row actions stop at the button: the row's link is its sibling,
    // and upstream's document handler would refocus the composer.
    $("body").on(
        "click",
        ".ykphone-drafts-rows .ykphone-row-action",
        function (this: HTMLElement, e) {
            e.preventDefault();
            e.stopPropagation();
            const route = ykphone_split_view.get_route();
            const action = this.dataset["ykphoneAction"];
            const id = this.dataset["ykphoneRowId"];
            if (route?.page === "drafts" && action !== undefined && id !== undefined) {
                handle_drafts_action(route, action, id);
            }
        },
    );
    // A draft with no conversation (no channel or no recipient chosen)
    // has nothing to open on the right; it goes straight to the
    // composer, as in Zulip's drafts overlay.
    $("body").on("click", ".ykphone-drafts-row", function (this: HTMLElement, e) {
        const route = ykphone_split_view.get_route();
        const id = this.dataset["ykphoneRowId"];
        if (route?.page !== "drafts" || route.tab !== "drafts" || id === undefined) {
            return;
        }
        const draft = ykphone_drafts_page.find_draft(id);
        if (draft !== undefined && ykphone_drafts_page.draft_narrow_terms(draft) === undefined) {
            e.preventDefault();
            restore_draft(id);
        }
    });
    $("body").on(
        "click",
        ".ykphone-saved-rows .ykphone-row-action",
        function (this: HTMLElement, e) {
            e.preventDefault();
            e.stopPropagation();
            const action = this.dataset["ykphoneAction"];
            const message_id = Number(this.dataset["messageId"]);
            if (action !== undefined && !Number.isNaN(message_id)) {
                handle_saved_action(action, message_id, this);
            }
        },
    );
    $("body").on("click", ".ykphone-unreads-hidden-mark-read", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const message_ids = ykphone_unreads.hidden_unread_message_ids();
        if (message_ids.length > 0) {
            message_flags.mark_as_read(message_ids);
        }
    });
    $("body").on("click", ".ykphone-unreads-mark-read", function (this: HTMLElement, e) {
        e.preventDefault();
        e.stopPropagation();
        const key = this.dataset["ykphoneGroup"];
        if (key !== undefined) {
            mark_group_read(key);
        }
    });
    document.addEventListener("keydown", handle_unreads_key, true);
    $("body").on("change", ".ykphone-activity-unread-only", function (this: HTMLElement) {
        ykphone_split_view.set_activity_unread_only($(this).prop("checked") === true);
        render_rows();
    });
    $("body").on("click", ".ykphone-activity-mark-all", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const route = ykphone_split_view.get_route();
        if (route?.page === "activity") {
            mark_activity_read(ykphone_split_view.activity_mark_read_plan(route.tab));
        }
    });

    // A filter chip keeps the conversation on the right; upstream's
    // document click handler would otherwise refocus the compose box
    // (any click inside a link while composing), and the composer's
    // focus handoff scrolls the feed away from the selected message.
    $("body").on("click", ".ykphone-activity-tab", (e) => {
        e.stopPropagation();
    });
    $("body").on(
        "change",
        ".ykphone-search-header .ykphone-filter-select",
        function (this: HTMLElement) {
            const route = ykphone_split_view.get_route();
            const name = $(this).attr("data-ykphone-filter");
            if (route?.page !== "search" || name === undefined) {
                return;
            }
            handle_search_filter(route, name, String($(this).val() ?? ""));
        },
    );
    $("body").on("click", ".ykphone-search-header .ykphone-filter-toggle", (e) => {
        const route = ykphone_split_view.get_route();
        if (route?.page !== "search") {
            return;
        }
        e.stopPropagation();
        handle_search_filter(route, "attachment", "");
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
