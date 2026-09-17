// Slack's unread indicators in the left sidebar and the icon rail for
// the 옆커폰 fork.
//
// Slack separates a channel's own conversation from its threads: a
// channel's name turns bold only for unread messages in the
// conversation itself (our general chat), while unread replies are
// gathered under Threads, and only for threads the user takes part in.
// Mentions, and every direct message, are counted in a red pill.
//
// A topic that is neither the general chat nor a thread (one another
// client created) is not part of the channel's conversation, so it
// leaves the channel's row alone. Like a thread, it counts under
// Threads (whose view, upstream's recent conversations, lists it) and
// in the Activity view only for someone who takes part in it: who sent
// a message to it or was mentioned in it. Other people's topics raise
// no count; they stay listed in 홈.
//
// Upstream computes and renders its own counts; the hooks at the end
// of stream_list.update_count_in_dom and of
// left_sidebar_navigation_area.update_dom_with_unread_counts call in
// here afterwards, so every path that refreshes those counts refreshes
// these too.

import $ from "jquery";

import {$t} from "./i18n.ts";
import * as sub_store from "./sub_store.ts";
import * as unread from "./unread.ts";
import * as user_topics from "./user_topics.ts";
import * as ykphone_threads from "./ykphone_threads.ts";

const GENERAL_CHAT_TOPIC = "";
const MAX_BADGE_COUNT = 99;

export function badge_label(count: number): string {
    return count > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : count.toString();
}

function is_muted_conversation(stream_id: number, topic: string): boolean {
    if (sub_store.get(stream_id)?.is_muted) {
        return !user_topics.is_topic_unmuted_or_followed(stream_id, topic);
    }
    return user_topics.is_topic_muted(stream_id, topic);
}

function is_visible_topic(stream_id: number, topic: string): boolean {
    return (
        topic === GENERAL_CHAT_TOPIC ||
        ykphone_threads.get_thread_for_topic(stream_id, topic) !== undefined
    );
}

export function channel_has_unread_general_chat(stream_id: number): boolean {
    // A muted channel is never bold, even if its general chat is
    // unmuted or followed.
    if (sub_store.get(stream_id)?.is_muted !== false) {
        return false;
    }
    return (
        !user_topics.is_topic_muted(stream_id, GENERAL_CHAT_TOPIC) &&
        unread.num_unread_for_topic(stream_id, GENERAL_CHAT_TOPIC) > 0
    );
}

// Unread messages mentioning the user in the general chat and in the
// channel's threads, muted or not: upstream shows its "@" for any
// unread mention and fades it when they are all muted.
export function channel_mention_count(stream_id: number): number {
    let count = 0;
    // The topics come back lower-cased; unread's topic lookups are
    // case-insensitive, as are thread topics.
    for (const topic of unread.get_topics_with_unread_mentions(stream_id)) {
        if (!is_visible_topic(stream_id, topic)) {
            continue;
        }
        count += unread
            .get_msg_ids_for_topic(stream_id, topic)
            .filter((message_id) => unread.unread_mentions_counter.has(message_id)).length;
    }
    return count;
}

// The unread topics other than the general chat, by channel, in the
// channels the user is subscribed to that are not archived (upstream's
// counts leave those out too, and their thread lists cannot be
// fetched).
export function unread_non_general_topics(): Map<number, string[]> {
    const topics_by_stream = new Map<number, string[]>();
    for (const [stream_id, topic_counts] of unread.get_unread_topics().topic_counts) {
        if (sub_store.get(stream_id)?.is_archived) {
            continue;
        }
        const topics = [...topic_counts.keys()].filter((topic) => topic !== GENERAL_CHAT_TOPIC);
        if (topics.length > 0) {
            topics_by_stream.set(stream_id, topics);
        }
    }
    return topics_by_stream;
}

// Whether a topic is a thread is known once the channel's thread list
// has been fetched; it is fetched once per channel (ykphone_threads
// deduplicates, and refreshes a loaded channel when a reply arrives in
// a topic it does not know).
function load_thread_lists(topics_by_stream: Map<number, string[]>): void {
    for (const stream_id of topics_by_stream.keys()) {
        ykphone_threads.load_stream_threads(stream_id);
    }
}

// Unread replies in the threads the user wrote the root of, started or
// replied in: the replies the Activity view lists.
export function participated_thread_unread_ids(topics_by_stream: Map<number, string[]>): number[] {
    const message_ids: number[] = [];
    for (const [stream_id, topics] of topics_by_stream) {
        for (const topic of topics) {
            const thread = ykphone_threads.get_thread_for_topic(stream_id, topic);
            if (thread?.user_participated !== true || is_muted_conversation(stream_id, topic)) {
                continue;
            }
            message_ids.push(...unread.get_msg_ids_for_topic(stream_id, topic));
        }
    }
    return message_ids;
}

// Unread messages in topics that are neither the general chat nor a
// thread, and that the user takes part in. A topic whose messages all
// arrived after the channel's thread list was fetched may yet turn out
// to be a new thread, so it waits for the refresh rather than being
// counted and then withdrawn.
export function unthreaded_topic_unread_ids(topics_by_stream: Map<number, string[]>): number[] {
    const message_ids: number[] = [];
    for (const [stream_id, topics] of topics_by_stream) {
        for (const topic of topics) {
            if (
                ykphone_threads.get_thread_for_topic(stream_id, topic) !== undefined ||
                !ykphone_threads.user_takes_part_in_topic(stream_id, topic) ||
                is_muted_conversation(stream_id, topic)
            ) {
                continue;
            }
            const topic_message_ids = unread.get_msg_ids_for_topic(stream_id, topic);
            if (
                topic_message_ids.some((message_id) =>
                    ykphone_threads.is_message_classified(stream_id, message_id),
                )
            ) {
                message_ids.push(...topic_message_ids);
            }
        }
    }
    return message_ids;
}

// The Activity view's unread items: mentions (in any topic) and the
// replies in the user's threads and topics, each message once.
export function activity_unread_count(thread_reply_ids: number[]): number {
    return new Set([...unread.get_msg_ids_for_mentions(), ...thread_reply_ids]).size;
}

function set_pill($pill: JQuery, count: number): void {
    $pill.toggleClass("no-display", count === 0);
    $pill.text(count === 0 ? "" : badge_label(count));
}

export function update_channel_row($stream_li: JQuery): void {
    const stream_id = Number($stream_li.attr("data-stream-id"));
    const $subscription_block = $stream_li.find(".subscription_block");
    $subscription_block.toggleClass("ykphone-unread", channel_has_unread_general_chat(stream_id));
    set_pill($subscription_block.find(".unread_mention_info"), channel_mention_count(stream_id));
}

function set_rail_badge(item_id: string, count: number): void {
    const item_selector = `#ykphone-rail .ykphone-rail-item[data-rail-item="${item_id}"]`;
    // An empty badge is hidden by the theme. The number alone would be
    // read out as part of the item's name ("DM 3"), so the badge is
    // hidden from screen readers and the item is named in words.
    $(`${item_selector} .ykphone-rail-badge`).text(count === 0 ? "" : badge_label(count));
    const $item = $(item_selector);
    if (count === 0) {
        $item.removeAttr("aria-label");
    } else {
        $item.attr(
            "aria-label",
            $t(
                {defaultMessage: "{label}, {count} unread"},
                {label: $(`${item_selector} .ykphone-rail-label`).text(), count},
            ),
        );
    }
}

export function update_navigation(): void {
    const topics_by_stream = unread_non_general_topics();
    load_thread_lists(topics_by_stream);
    const thread_reply_ids = [
        ...participated_thread_unread_ids(topics_by_stream),
        ...unthreaded_topic_unread_ids(topics_by_stream),
    ];
    const threads_row_count = thread_reply_ids.length;

    // Upstream's recent conversations row, which the fork calls
    // Threads.
    const $threads_row = $("#left-sidebar-navigation-list .top_left_row.top_left_recent_view");
    $threads_row.toggleClass("ykphone-unread", threads_row_count > 0);
    const $threads_count = $threads_row.find(".unread_count");
    $threads_count.toggleClass("hide", threads_row_count === 0);
    $threads_count.text(threads_row_count === 0 ? "" : badge_label(threads_row_count));

    set_rail_badge("dm", unread.get_unread_pm().total_count);
    set_rail_badge("activity", activity_unread_count(thread_reply_ids));
}

export function refresh_all(): void {
    for (const stream_id of unread.get_unread_topics().topic_counts.keys()) {
        update_channel_row($(`#stream_filters .narrow-filter[data-stream-id="${stream_id}"]`));
    }
    update_navigation();
}

export function initialize(): void {
    // Once a channel's threads are known, its unread topics can be
    // told apart: the channel's mention count and the Threads count
    // may change.
    ykphone_threads.on_stream_threads_loaded(refresh_all);
    // Taking part in a thread or topic (from here or another client), a
    // deleted root and a moved thread change what counts where, while
    // the unread counts may not change at all.
    ykphone_threads.on_threads_changed(refresh_all);
    // The rail is mounted after upstream's first count, and a thread
    // list requested then may already have arrived.
    refresh_all();
}
