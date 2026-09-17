// Deployment-level switches for the 옆커폰 fork. This module has no
// imports so that leaf modules like hash_util can read the flags
// without creating import cycles; ui_init sets them before the page's
// first view is shown, which also keeps upstream node tests (which
// never call it) on upstream behavior.

let general_chat_channels = false;

// Left-sidebar rows the theme hides because the icon rail replaces
// them: the VIEWS header (views are always expanded) and the views the
// rail carries. They stay in the DOM so their hotkeys and URLs keep
// working; sidebar_ui skips them for keyboard navigation.
export const HIDDEN_LEFT_SIDEBAR_ROWS_SELECTOR =
    "#views-label-container, .top_left_inbox, .top_left_all_messages, .top_left_mentions, .top_left_my_reactions";

// Quoting a message is gone from the fork: it pastes markdown into the
// compose box, which the Slack-style forward card replaces. Upstream's
// code paths are left intact behind this flag so a rebase stays cheap.
export const QUOTE_MESSAGE_ENABLED = false;

// Moving a message is gone from the fork: it exists to put a message
// under a different topic, and the fork hides topics behind threads.
// Moving a message to another channel goes with it. As with quoting,
// upstream's code paths stay intact behind the flag.
export const MOVE_MESSAGE_ENABLED = false;

// Slack's message menu has neither "Collapse message" nor "View
// original message" (the Markdown source of a message the user cannot
// edit); the fork's menu leaves both out. A message collapsed before
// (or with the "-" key) still offers "Expand message".
export let COLLAPSE_MESSAGE_MENU_ITEM_ENABLED = false;
export let VIEW_SOURCE_MENU_ITEM_ENABLED = false;

// For upstream's tests of the rules behind the two items.
export function rewire_COLLAPSE_MESSAGE_MENU_ITEM_ENABLED(value: boolean): void {
    COLLAPSE_MESSAGE_MENU_ITEM_ENABLED = value;
}

export function rewire_VIEW_SOURCE_MENU_ITEM_ENABLED(value: boolean): void {
    VIEW_SOURCE_MENU_ITEM_ENABLED = value;
}

// Scheduling a message or a reminder offers Slack's presets
// (ykphone_schedule_presets) instead of upstream's times of day; the
// open menu is drawn again when the day changes rather than at
// upstream's hours.
export const SLACK_SCHEDULE_PRESETS_ENABLED = true;

// When set, clicking a channel opens its "general chat" topic instead
// of the topic-based views, so a channel reads as one Slack-style room
// and threads (topics) stay out of the main feed.
export function channels_open_in_general_chat(): boolean {
    return general_chat_channels;
}

export function set_channels_open_in_general_chat(value: boolean): void {
    general_chat_channels = value;
}
