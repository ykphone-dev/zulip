// Slack always shows a message the user has just sent into the
// conversation on screen: the feed moves so the new message sits just
// above the compose box, whatever the user had scrolled up to read.
// Upstream instead leaves the feed where it was and shows "Sent! Scroll
// down to view your message."; compose_notifications keeps that banner
// for every case this module declines.

import * as message_lists from "./message_lists.ts";
import * as message_scroll_state from "./message_scroll_state.ts";
import * as message_viewport from "./message_viewport.ts";
import * as narrow_state from "./narrow_state.ts";
import * as ykphone_conversation from "./ykphone_conversation.ts";
import * as ykphone_unread_guard from "./ykphone_unread_guard.ts";

// Returns whether the message was scrolled to; false leaves upstream's
// banner in charge. Only a conversation (a channel's general chat, a
// thread, a DM) is Slack's single room: the Combined feed, all of a
// channel's topics, every DM, searches and saved messages are lists a
// user reads in their own order, and keep upstream's behaviour.
export function scroll_to_sent_message(message_id: number): boolean {
    const list = message_lists.current;
    if (list === undefined || !ykphone_conversation.is_conversation(narrow_state.filter())) {
        return false;
    }
    const row = list.get_row(message_id)[0];
    if (row === undefined) {
        return false;
    }
    // Unread messages the user has not seen stay unread (and keep the
    // "New" line) until they come into view.
    ykphone_unread_guard.hold_unseen(list.all_messages());
    // Selecting the sent message moves the pointer past everything in
    // between; that is not reading it.
    list.select_id(message_id, {mark_read: false});

    const {visible_bottom} = message_viewport.message_viewport_info();
    const scroll_top = message_viewport.scrollTop();
    message_viewport.scrollTop(scroll_top + row.getBoundingClientRect().bottom - visible_bottom);
    if (message_viewport.scrollTop() !== scroll_top) {
        // Like upstream's own positioning, this scroll does not move the
        // selection or mark anything read when it settles. It is set
        // only when the scroll really happened, since the flag is
        // consumed by the next scroll event, whichever that is.
        message_scroll_state.set_update_selection_on_next_scroll(false);
    }
    return true;
}
