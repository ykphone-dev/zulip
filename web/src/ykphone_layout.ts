// Layout glue for the 옆커폰 fork that keeps no state of its own: the
// left-sidebar section order, the member list's first-load default and
// the pane header's height for upstream's viewport math. The module
// imports only leaf modules so that message_viewport and friends can
// depend on it without import cycles.

import $ from "jquery";

import {localstorage} from "./localstorage.ts";
import {page_params} from "./page_params.ts";

// The header above the message feed (ykphone_pane_header) sticks under
// the fixed navbar; upstream code that derives the top of the visible
// feed from the navbar's height adds this. The computed height is the
// border box (the theme sets box-sizing on the header), and reads as
// zero while the header is not mounted.
export function pane_header_height(): number {
    return Number.parseFloat($("#ykphone-pane-header").css("height")) || 0;
}

// Slack lists channels above direct messages. The sections are moved
// in the DOM rather than reordered with CSS so that keyboard navigation
// in the sidebar, which walks rows in DOM order, matches the screen.
export function reorder_left_sidebar_sections(): void {
    $("#direct-messages-section-header").before($("#streams_list"));
}

// The member list starts hidden for a user who has never toggled it.
// upstream saves the toggle under this key (sidebar_ui) and restores
// it before this runs, so an absent key means "never toggled".
export function hide_member_list_by_default(): void {
    if (page_params.is_spectator) {
        return;
    }
    if (localstorage().get("right-sidebar") === undefined) {
        $("body").addClass("hide-right-sidebar");
    }
}
