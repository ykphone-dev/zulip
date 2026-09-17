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

// The theme fills a conversation from the bottom and reserves exactly
// the compose box's height below the last message, which means knowing
// that height: the box is fixed over the feed and grows with the text
// in it, so it is published as a custom property rather than assumed.
// A ResizeObserver catches every reason it changes — the window,
// opening and closing the box, the textarea autosizing as the user
// types — without a hook in any of them.
//
// The mark-as-read banner below the feed is observed as well: upstream
// keeps an invisible copy of it in the flow so the document never
// changes height when it comes and goes, and the theme drops that copy
// because it was a permanent blank band above the compose box.
export function track_feed_bottom(): void {
    const compose = document.querySelector("#compose");
    if (compose === null || typeof ResizeObserver !== "function") {
        // The theme's own value (a two-row composer) stands in.
        return;
    }
    observe_growth(compose, (height, growth) => {
        document.documentElement.style.setProperty("--yk-compose-height", `${height}px`);
        keep_feed_pinned_to_bottom(growth);
    });
    const banner = document.querySelector("#mark_read_on_scroll_state_banner");
    if (banner !== null) {
        observe_growth(banner, (_height, growth) => {
            keep_feed_pinned_to_bottom(growth);
        });
    }
}

function observe_growth(
    element: Element,
    on_resize: (height: number, growth: number) => void,
): void {
    // The first measurement is the element as the page loaded, not a
    // change: a reader who lands near the end must not be pushed down
    // by the whole height of the compose box.
    let previous_height: number | undefined;
    const observer = new ResizeObserver(() => {
        const height = element.getBoundingClientRect().height;
        const growth = previous_height === undefined ? 0 : height - previous_height;
        previous_height = height;
        on_resize(height, growth);
    });
    observer.observe(element);
}

// Something below the last message that grows (the compose box, the
// mark-as-read banner) makes the document taller by the same amount,
// so a reader who was at the end of the conversation would be left that
// far above it, with the box over the last message. Slack keeps the
// conversation pinned to the bottom; since the growth has already been
// laid out when this runs, "was at the bottom" is the bottom as it was
// before it.
function keep_feed_pinned_to_bottom(growth: number): void {
    if (growth <= 0) {
        return;
    }
    const root = document.documentElement;
    if (root.scrollTop + root.clientHeight >= root.scrollHeight - growth - 2) {
        root.scrollTop += growth;
    }
}

// Runs a change that adds or removes height *above* what the reader is
// looking at — the conversation intro appearing over messages that are
// already scrolled into place — and keeps the feed where it was relative
// to the end of the document. Browsers' scroll anchoring would do this,
// but Safari has none and Chrome does not anchor at scroll position 0,
// which is exactly where a freshly opened conversation often is. With
// the theme reserving only the compose box below the feed, an intro
// pushing everything down would leave the last message under the box.
export function keep_feed_end_in_place(change: () => void): void {
    const root = document.documentElement;
    const height = root.scrollHeight;
    const distance_from_end = height - root.scrollTop;
    change();
    // Most calls (a pane header re-rendered for a pin or a subscriber
    // count) change nothing; writing the position anyway would cancel
    // momentum scrolling and fight a running scroll animation.
    if (root.scrollHeight !== height) {
        root.scrollTop = root.scrollHeight - distance_from_end;
    }
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
