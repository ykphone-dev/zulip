// DOM side of the Activity view for the 옆커폰 web UI: the container
// in the middle column (shown in place of the message feed, like the
// inbox and recent views, through views_util's show/hide protocol),
// the tabs and the rows. The state and data live in
// ykphone_activity.ts; this module is exempt from node coverage like
// ykphone_threads_ui.

import $ from "jquery";

import render_ykphone_activity_rows from "../templates/ykphone_activity_rows.hbs";
import render_ykphone_activity_view from "../templates/ykphone_activity_view.hbs";

import * as compose_closed_ui from "./compose_closed_ui.ts";
import * as left_sidebar_navigation_area from "./left_sidebar_navigation_area.ts";
import {page_params} from "./page_params.ts";
import * as spectators from "./spectators.ts";
import * as views_util from "./views_util.ts";
import * as ykphone_activity from "./ykphone_activity.ts";
import type {ActivityTab} from "./ykphone_activity.ts";

let hide_other_views_callback: (() => void) | undefined;

function $view(): JQuery {
    return $("#ykphone-activity-view");
}

function load(): void {
    const $body = $view().find(".ykphone-activity-body");
    $body.html(render_ykphone_activity_rows({loading: true}));
    ykphone_activity.load(ykphone_activity.get_active_tab(), {
        on_loaded(items) {
            $body.html(
                render_ykphone_activity_rows({
                    has_rows: items.length > 0,
                    rows: items.map((item) => ykphone_activity.row_context(item)),
                }),
            );
        },
        on_error() {
            $body.html(render_ykphone_activity_rows({error: true}));
        },
    });
}

function render(): void {
    $view().html(render_ykphone_activity_view({tabs: ykphone_activity.tabs_context()}));
    load();
}

function select_tab(tab: ActivityTab): void {
    ykphone_activity.set_active_tab(tab);
    $view()
        .find(".ykphone-activity-tab")
        .each(function (this: HTMLElement) {
            const active = $(this).attr("data-tab") === tab;
            $(this).toggleClass("active", active);
            $(this).attr("aria-pressed", active ? "true" : "false");
        });
    load();
}

// The hash is "#ykphone/<section>"; only the activity section exists.
export function show_for_hash(section: string | undefined): boolean {
    if (section !== "activity") {
        return false;
    }
    show();
    return true;
}

export function show(): void {
    if (page_params.is_spectator) {
        spectators.login_to_access();
        return;
    }
    if (ykphone_activity.is_visible()) {
        // Already on the view (the rail item clicked again): refresh
        // the feed, as Slack does.
        load();
        return;
    }
    hide_other_views_callback?.();
    views_util.show({
        highlight_view_in_left_sidebar() {
            // No sidebar row belongs to this view; the rail item is
            // highlighted by ykphone_rail from the hash.
            views_util.handle_message_view_deactivated(() => {
                left_sidebar_navigation_area.select_top_left_corner_item("");
            });
        },
        $view: $view(),
        update_compose() {
            compose_closed_ui.update_buttons();
        },
        is_visible: ykphone_activity.is_visible,
        set_visible: ykphone_activity.set_visible,
        complete_rerender: render,
    });
}

export function hide(): void {
    if (!ykphone_activity.is_visible()) {
        return;
    }
    views_util.hide({$view: $view(), set_visible: ykphone_activity.set_visible});
}

export function initialize({hide_other_views}: {hide_other_views: () => void}): void {
    hide_other_views_callback = hide_other_views;
    $("#message_feed_container").before(
        $("<div>").attr("id", "ykphone-activity-view").addClass("ykphone-activity-view").hide(),
    );
    $("body").on("click", ".ykphone-activity-tab", function (this: HTMLElement) {
        const clicked = $(this).attr("data-tab");
        const tab = ykphone_activity.TABS.find((candidate) => candidate === clicked);
        if (tab !== undefined) {
            select_tab(tab);
        }
    });
}
