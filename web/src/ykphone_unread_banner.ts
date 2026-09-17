// Slack's "N new messages since …" bar for the 옆커폰 fork.
//
// Slack puts a bar at the top of a conversation that was opened with
// unread history: the number of new messages, when they started, "읽음
// 처리" and "처음 새 메시지로 이동". Zulip has the in-feed "새로운" line
// (round 4) and, for its own reading model, a banner about marking
// messages read; neither tells you how much you have not read.
//
// The bar appears only while the first unread message is out of sight
// (below the viewport, or not even rendered), so a conversation opened
// at its unread messages does not get one. It hides as soon as the
// conversation is read, when either button is used, and when the
// conversation changes. It never marks anything read by itself, and the
// round-8 unread guard is untouched: the "읽음 처리" button asks for the
// same marking Escape does.

import $ from "jquery";

import render_ykphone_unread_banner from "../templates/ykphone_unread_banner.hbs";

import * as browser_history from "./browser_history.ts";
import * as hash_util from "./hash_util.ts";
import {$t} from "./i18n.ts";
import * as message_lists from "./message_lists.ts";
import * as message_store from "./message_store.ts";
import * as message_viewport from "./message_viewport.ts";
import * as narrow_state from "./narrow_state.ts";
import {page_params} from "./page_params.ts";
import * as unread from "./unread.ts";
import * as ykphone_flags from "./ykphone_flags.ts";
import * as ykphone_hotkeys from "./ykphone_hotkeys.ts";
import * as ykphone_places from "./ykphone_places.ts";
import type {Place} from "./ykphone_places.ts";
import * as ykphone_time from "./ykphone_time.ts";
import * as ykphone_unread_badges from "./ykphone_unread_badges.ts";

export type BannerContext = {
    count_label: string;
    since_label: string | undefined;
    mark_read_label: string;
    jump_label: string;
};

// Set while the user has dismissed the bar for the messages on screen
// (either button, or the close button); cleared when the conversation
// changes and once everything in it has been read.
let dismissed = false;
// What the bar last drew, so that an identical redraw is skipped.
let rendered_key = "";

export function clear_for_testing(): void {
    dismissed = false;
    rendered_key = "";
}

// The conversation narrows the bar can appear in; a split page's list
// (kind "page") is not one of them.
type ConversationPlace = Exclude<Place, {kind: "page"}>;

// The bar belongs to the fork's conversation layout, and never to a
// spectator (who has no unread messages of their own).
function enabled(): boolean {
    return !page_params.is_spectator && ykphone_flags.channels_open_in_general_chat();
}

function conversation_place(): ConversationPlace | undefined {
    const filter = narrow_state.filter();
    if (filter === undefined) {
        return undefined;
    }
    const place = ykphone_places.place_for_filter(filter);
    if (place === undefined || place.kind === "page") {
        return undefined;
    }
    return place;
}

export function unread_count(place: Place): number {
    switch (place.kind) {
        case "channel":
            return unread.num_unread_for_topic(place.stream_id, "");
        case "thread":
            return unread.num_unread_for_topic(place.stream_id, place.topic);
        case "dm":
            return unread.num_unread_for_user_ids_string(place.user_ids.join(","));
        default:
            return 0;
    }
}

// The oldest unread message of the conversation, when this client can
// work it out: upstream's own lookup, which answers for the conversation
// narrows the bar appears in.
function first_unread_id(): number | undefined {
    const filter = narrow_state.filter();
    if (filter === undefined) {
        return undefined;
    }
    const info = narrow_state.get_first_unread_info(filter);
    return info.flavor === "found" ? info.msg_id : undefined;
}

// Whether the oldest unread message is out of sight: not rendered at
// all, or outside the visible part of the feed. A message the reader
// can see is about to be marked read by upstream's own reading, so a
// bar about it would flash for a moment and go.
function first_unread_is_out_of_sight(message_id: number | undefined): boolean {
    if (message_id === undefined) {
        // Unread messages the client has not loaded (older history, or
        // a narrow it cannot filter locally) are certainly out of sight.
        return true;
    }
    const $row = message_lists.current?.get_row(message_id);
    if ($row === undefined || $row.length === 0) {
        return true;
    }
    const info = message_viewport.message_viewport_info();
    const offset = $row.get_offset_to_window();
    return offset.top >= info.visible_bottom || offset.bottom <= info.visible_top;
}

function since_label(message_id: number | undefined): string | undefined {
    const message = message_id === undefined ? undefined : message_store.get(message_id);
    if (message === undefined) {
        return undefined;
    }
    // The clock alone for today, the date too for older history: unread
    // messages from Tuesday must not read "오후 7:34 이후".
    return $t(
        {defaultMessage: "since {time}"},
        {time: ykphone_time.day_or_time(message.timestamp)},
    );
}

// Everything here has been read: the bar has nothing left to say, and a
// later batch of messages gets a bar of its own even though this one
// was dismissed. Called from render(), so that get_context() stays a
// question rather than an answer with a side effect.
function forget_dismissal_when_read(): void {
    if (!enabled()) {
        return;
    }
    const place = conversation_place();
    if (place !== undefined && unread_count(place) === 0) {
        dismissed = false;
    }
}

export function get_context(): BannerContext | undefined {
    if (dismissed || !enabled()) {
        return undefined;
    }
    const place = conversation_place();
    if (place === undefined) {
        return undefined;
    }
    const count = unread_count(place);
    if (count === 0) {
        return undefined;
    }
    const message_id = first_unread_id();
    if (!first_unread_is_out_of_sight(message_id)) {
        return undefined;
    }
    return {
        count_label: $t(
            {defaultMessage: "{count, plural, one {# new message} other {# new messages}}"},
            {count},
        ),
        since_label: since_label(message_id),
        mark_read_label: $t({defaultMessage: "Mark as read"}),
        jump_label: $t({defaultMessage: "Jump to first new message"}),
    };
}

export function render(): void {
    const $banner = $("#ykphone-unread-banner");
    if ($banner.length === 0) {
        return;
    }
    forget_dismissal_when_read();
    const context = get_context();
    const key = context === undefined ? "" : JSON.stringify(context);
    if (key === rendered_key) {
        // Nothing has changed: drawing it again would take the focus
        // out of the bar and have a screen reader read it out once
        // more, on every settled scroll.
        return;
    }
    rendered_key = key;
    if (context === undefined) {
        $banner.empty();
        return;
    }
    $banner.html(render_ykphone_unread_banner(context));
}

export function hide(): void {
    dismissed = true;
    render();
}

export function handle_narrow_activated(): void {
    dismissed = false;
    render();
}

export function mark_read(): void {
    ykphone_hotkeys.mark_current_conversation_read();
    hide();
}

// The conversation again, this time around a message of its own: the
// same kind of link the pins panel's "Go to message" uses.
function near_hash(place: ConversationPlace, message_id: number): string {
    const near = {operator: "near" as const, operand: message_id.toString()};
    if (place.kind === "dm") {
        return hash_util.search_terms_to_hash([{operator: "dm", operand: place.user_ids}, near]);
    }
    return hash_util.search_terms_to_hash([
        {operator: "channel", operand: place.stream_id.toString()},
        // The channel's general chat is its empty topic.
        {operator: "topic", operand: place.kind === "thread" ? place.topic : ""},
        near,
    ]);
}

export function jump_to_first_unread(): void {
    const message_id = first_unread_id();
    const place = conversation_place();
    if (message_id === undefined || place === undefined) {
        hide();
        return;
    }
    if (message_lists.current?.get(message_id) === undefined) {
        // The message is not loaded here: the conversation is opened
        // again around it.
        browser_history.go_to_location(near_hash(place, message_id));
    } else {
        message_lists.current.select_id(message_id, {then_scroll: true, use_closest: true});
    }
    hide();
}

export function mount(): void {
    $("#ykphone-pane-header").after(
        $("<div>").attr("id", "ykphone-unread-banner").addClass("ykphone-unread-banner"),
    );
    render();
}

export function initialize(): void {
    // Every refresh of the unread counts (a message arriving, messages
    // being read here or in another client) redraws the bar, which is
    // how it disappears once the conversation is read.
    ykphone_unread_badges.on_counts_updated(render);
}
