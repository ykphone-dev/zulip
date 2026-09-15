// Whether the user is moving through the message feed with the
// keyboard, for the 옆커폰 fork.
//
// Zulip always keeps a "selected message" so that hotkeys (j/k, r, i,
// …) have something to act on, and draws a box around it. Slack shows
// nothing until the pointer is over a message, so a freshly opened
// conversation has no box and no time in the gutter. The selection
// itself is untouched — only its outline (and the gutter time it
// reveals) is hidden while the body lacks this class, which
// ykphone_threads_ui removes again on the next pointer move or click in
// the feed.

import $ from "jquery";

const BODY_CLASS = "ykphone-keyboard-nav";

// The hotkeys that move the selection or scroll the feed, including the
// ones that reach a message by jumping to another conversation
// (n/p/Shift+N); everything else (reply, react, save, …) acts on the
// selection without the user having navigated to it by hand.
const NAVIGATION_HOTKEYS = new Set([
    "up_arrow",
    "down_arrow",
    "vim_up",
    "vim_down",
    "home",
    "end",
    "G_end",
    "page_up",
    "page_down",
    "vim_page_up",
    "vim_page_down",
    "spacebar",
    "shift_spacebar",
    "n_key",
    "p_key",
    "narrow_to_next_unread_followed_topic",
]);

let active = false;

export function is_active(): boolean {
    return active;
}

export function is_navigation_hotkey(event_name: string): boolean {
    return NAVIGATION_HOTKEYS.has(event_name);
}

// Called from hotkey.ts for every hotkey that reaches the message feed.
export function note_hotkey(event_name: string): void {
    if (active || !is_navigation_hotkey(event_name)) {
        return;
    }
    active = true;
    $("body").addClass(BODY_CLASS);
}

export function clear(): void {
    if (!active) {
        return;
    }
    active = false;
    $("body").removeClass(BODY_CLASS);
}
