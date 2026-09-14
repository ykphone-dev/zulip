// In-app history for the navbar's back and forward buttons
// (ykphone_navbar_history).
//
// Slack's arrows only move within the app; a plain history.back() at
// the first in-app entry would leave for the login page or wherever
// the user came from. With the Navigation API the neighbouring
// entries say whether they are the same document. Without it, a count
// of same-document (hash) navigations stands in; it cannot tell the
// browser's own back button from a new navigation and so may
// over-count, but never under-counts.
//
// The DOM event wiring lives in ykphone_threads_ui.ts.

import $ from "jquery";

let back_depth = 0;
let forward_depth = 0;
// Set while one of our buttons is navigating, so that the resulting
// hashchange moves the counters instead of counting as new.
let pending_traversal: "back" | "forward" | undefined;

function navigation_api(): Navigation | undefined {
    return "navigation" in window ? window.navigation : undefined;
}

function neighbour_is_same_document(navigation: Navigation, offset: number): boolean {
    const index = navigation.currentEntry?.index;
    if (index === undefined) {
        return false;
    }
    return navigation.entries()[index + offset]?.sameDocument === true;
}

export function can_go_back(): boolean {
    const navigation = navigation_api();
    return navigation ? neighbour_is_same_document(navigation, -1) : back_depth > 0;
}

export function can_go_forward(): boolean {
    const navigation = navigation_api();
    return navigation ? neighbour_is_same_document(navigation, 1) : forward_depth > 0;
}

export function update_buttons(): void {
    for (const [selector, enabled] of [
        [".ykphone-navbar-back", can_go_back()],
        [".ykphone-navbar-forward", can_go_forward()],
    ] as const) {
        $(selector)
            .prop("disabled", !enabled)
            .attr("aria-disabled", enabled ? "false" : "true");
    }
}

export function go_back(): void {
    if (!can_go_back()) {
        return;
    }
    pending_traversal = "back";
    window.history.back();
}

export function go_forward(): void {
    if (!can_go_forward()) {
        return;
    }
    pending_traversal = "forward";
    window.history.forward();
}

function handle_hashchange(): void {
    if (pending_traversal === "back") {
        back_depth -= 1;
        forward_depth += 1;
    } else if (pending_traversal === "forward") {
        back_depth += 1;
        forward_depth -= 1;
    } else {
        back_depth += 1;
        forward_depth = 0;
    }
    pending_traversal = undefined;
    update_buttons();
}

export function initialize(): void {
    const navigation = navigation_api();
    if (navigation) {
        navigation.addEventListener("currententrychange", update_buttons);
    } else {
        $(window).on("hashchange", handle_hashchange);
    }
    update_buttons();
}

export function clear_for_testing(): void {
    back_depth = 0;
    forward_depth = 0;
    pending_traversal = undefined;
}
