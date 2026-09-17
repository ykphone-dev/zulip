// Unread messages the user has not seen, kept unread through the
// fork's scroll to a message they just sent.
//
// Sending into the conversation on screen takes the feed to the new
// message even when the user had scrolled up to read (see
// ykphone_send_scroll). Upstream marks every message in the feed read
// as soon as its bottom is visible, which would silently mark read the
// messages that arrived below where the user was reading and never came
// into view — and take the "New" line away with them. Those messages
// are held here until they actually appear on screen, and
// unread_ops.process_scrolled_to_bottom leaves held messages out.

import * as message_lists from "./message_lists.ts";
import type {Message} from "./message_store.ts";
import * as message_viewport from "./message_viewport.ts";

const held = new Set<number>();

// Whether a message's row is at least partly inside the visible feed
// (below the navbar and pane header, above the compose box).
export function is_on_screen(message_id: number): boolean {
    const row = message_lists.current?.get_row(message_id)[0];
    if (row === undefined) {
        return false;
    }
    const {visible_top, visible_bottom} = message_viewport.message_viewport_info();
    const rect = row.getBoundingClientRect();
    return rect.bottom > visible_top && rect.top < visible_bottom;
}

// Called just before the feed leaves the user's reading position.
export function hold_unseen(messages: Message[]): void {
    for (const message of messages) {
        if (message.unread && !is_on_screen(message.id)) {
            held.add(message.id);
        }
    }
}

// Called whenever a scroll settles: what is on screen now has been seen.
export function release_visible(): void {
    for (const message_id of held) {
        if (is_on_screen(message_id)) {
            held.delete(message_id);
        }
    }
}

export function readable(messages: Message[]): Message[] {
    if (held.size === 0) {
        return messages;
    }
    return messages.filter((message) => !held.has(message.id));
}

// A different conversation: nothing is held over.
export function clear(): void {
    held.clear();
}
