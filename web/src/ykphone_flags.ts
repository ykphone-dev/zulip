// Deployment-level switches for the 옆커폰 fork. This module has no
// imports so that leaf modules like hash_util can read the flags
// without creating import cycles; ykphone_threads_ui sets them once
// the app has started, which also keeps upstream node tests (which
// never call it) on upstream behavior.

let general_chat_channels = false;

// When set, clicking a channel opens its "general chat" topic instead
// of the topic-based views, so a channel reads as one Slack-style room
// and threads (topics) stay out of the main feed.
export function channels_open_in_general_chat(): boolean {
    return general_chat_channels;
}

export function set_channels_open_in_general_chat(value: boolean): void {
    general_chat_channels = value;
}
