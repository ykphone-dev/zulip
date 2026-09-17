// Slack-style threads for the 옆커폰 fork.
//
// A thread is an ordinary Zulip topic that was opened from one
// "general chat" message; the server keeps the root-message-to-topic
// link (see ykphone/models.py). This module caches those links per
// channel so the message list can show a reply count under each root
// and keep it current as replies arrive.

import * as z from "zod/mini";

import * as channel from "./channel.ts";
import * as feedback_widget from "./feedback_widget.ts";
import {$t} from "./i18n.ts";
import * as message_lists from "./message_lists.ts";
import * as message_store from "./message_store.ts";
import type {Message} from "./message_store.ts";
import {page_params} from "./page_params.ts";
import * as people from "./people.ts";
import type {UpdateMessageEvent} from "./server_event_types.ts";
import * as stream_data from "./stream_data.ts";
import * as timerender from "./timerender.ts";
import * as util from "./util.ts";

const thread_schema = z.object({
    root_message_id: z.number(),
    stream_id: z.number(),
    topic_name: z.string(),
    reply_count: z.number(),
    last_reply_timestamp: z.nullable(z.number()),
    // Senders of the newest replies, newest first.
    participant_user_ids: z.array(z.number()),
    // The user wrote the root, started the thread or replied in it;
    // unread replies in these threads are counted in the sidebar and
    // the rail.
    user_participated: z.boolean(),
});
const threads_response_schema = z.object({
    threads: z.array(thread_schema),
    // Topics other than threads that the user sent a message to or was
    // mentioned in.
    participated_topics: z.array(z.string()),
});

export type ThreadInfo = z.infer<typeof thread_schema>;

export type ThreadPillContext = {
    topic_name: string;
    reply_label: string;
    last_reply_label: string | undefined;
    // Avatars of the newest repliers, like Slack's pill.
    avatar_urls: string[];
    has_avatars: boolean;
};

// Slack shows the avatars of the last few people who replied.
const MAX_PILL_AVATARS = 3;

const threads_by_root = new Map<number, ThreadInfo>();
const root_by_topic = new Map<string, number>();
const loaded_streams = new Set<number>();
const loading_streams = new Set<number>();
// Channels whose thread list could not be fetched (archived channels
// answer 400, for example, and a transient failure is retried a few
// times first). Rendering must not retry these on every pass; an
// explicit forced load may.
const failed_streams = new Set<number>();
// Channels waiting to retry a failed fetch, and how many attempts
// failed so far.
const RETRY_DELAYS_MS = [2000, 10_000, 30_000];
const retrying_streams = new Set<number>();
const failed_attempts = new Map<number, number>();
const load_listeners: ((stream_id: number) => void)[] = [];
const threads_changed_listeners: (() => void)[] = [];
// Topics other than threads the user takes part in (sent a message to,
// or was mentioned in), by topic_key. Taking part only grows, so a
// response that predates the user's own message never removes one.
const participated_topic_keys = new Set<string>();
// New messages, by channel, in topics the channel's loaded thread list
// did not know: someone opened a thread, or another client used a new
// topic. Whether those topics are threads is unknown until the refresh
// that on_new_messages requests lands.
const unclassified_message_ids = new Map<number, Set<number>>();
// Channels to fetch again once the request in flight is done, because
// messages arrived that it may predate.
const reload_after_load = new Set<number>();

// Called after each successful load of a channel's threads, so that
// views which depend on knowing whether a topic is a thread (the root
// shown above a thread's full view) can catch up.
export function on_stream_threads_loaded(listener: (stream_id: number) => void): void {
    load_listeners.push(listener);
}

// Called when what the cache says about threads changes other than by
// a load: the user's own new message makes them take part in a thread
// or topic, a root is deleted, or a thread's topic is moved.
export function on_threads_changed(listener: () => void): void {
    threads_changed_listeners.push(listener);
}

function notify_threads_changed(): void {
    for (const listener of threads_changed_listeners) {
        listener();
    }
}

function topic_key(stream_id: number, topic_name: string): string {
    return `${stream_id} ${topic_name.toLowerCase()}`;
}

// Whether get_thread_for_topic's answer for this message's topic is
// final: the channel's thread list was fetched after the message
// arrived. A topic is a thread before its first reply is sent, so a
// list fetched later knows it.
// A channel whose list could not be fetched at all counts as what is
// known of it.
export function is_message_classified(stream_id: number, message_id: number): boolean {
    return (
        (loaded_streams.has(stream_id) || failed_streams.has(stream_id)) &&
        unclassified_message_ids.get(stream_id)?.has(message_id) !== true
    );
}

export function user_takes_part_in_topic(stream_id: number, topic_name: string): boolean {
    return participated_topic_keys.has(topic_key(stream_id, topic_name));
}

function forget(thread: ThreadInfo): void {
    threads_by_root.delete(thread.root_message_id);
    const key = topic_key(thread.stream_id, thread.topic_name);
    if (root_by_topic.get(key) === thread.root_message_id) {
        root_by_topic.delete(key);
    }
}

function remember(thread: ThreadInfo): void {
    const previous = threads_by_root.get(thread.root_message_id);
    if (previous !== undefined) {
        forget(previous);
        // Taking part only grows; a response may predate the user's own
        // reply, which on_new_messages already recorded.
        thread.user_participated ||= previous.user_participated;
    }
    threads_by_root.set(thread.root_message_id, thread);
    root_by_topic.set(topic_key(thread.stream_id, thread.topic_name), thread.root_message_id);
}

export function get_thread(root_message_id: number): ThreadInfo | undefined {
    return threads_by_root.get(root_message_id);
}

export function get_thread_for_topic(
    stream_id: number,
    topic_name: string,
): ThreadInfo | undefined {
    const root_id = root_by_topic.get(topic_key(stream_id, topic_name));
    return root_id === undefined ? undefined : threads_by_root.get(root_id);
}

export function can_thread(message: Message): boolean {
    return (
        !page_params.is_spectator &&
        message.type === "stream" &&
        message.topic === "" &&
        !message.locally_echoed &&
        !stream_data.is_empty_topic_only_channel(message.stream_id)
    );
}

export function pill_context(thread: ThreadInfo): ThreadPillContext {
    const avatar_urls = thread.participant_user_ids
        .slice(0, MAX_PILL_AVATARS)
        .map((user_id) => people.maybe_get_user_by_id(user_id, true))
        .filter((user) => user !== undefined)
        .map((user) => people.small_avatar_url_for_person(user));
    return {
        topic_name: thread.topic_name,
        reply_label: $t(
            {defaultMessage: "{count, plural, one {# reply} other {# replies}}"},
            {count: thread.reply_count},
        ),
        last_reply_label:
            thread.last_reply_timestamp === null
                ? undefined
                : timerender.relative_time_string_from_date(
                      new Date(thread.last_reply_timestamp * 1000),
                  ),
        avatar_urls,
        has_avatars: avatar_urls.length > 0,
    };
}

function same_participants(a: number[], b: number[]): boolean {
    return a.length === b.length && a.every((user_id, i) => user_id === b[i]);
}

// Called while building message rows, so it must stay cheap; the
// first look at a channel kicks off a fetch and the rows re-render
// when it lands.
export function get_pill_context_for_message(message: Message): ThreadPillContext | undefined {
    // The thread endpoints need a logged-in user; a spectator's request
    // would open the login prompt on its own.
    if (page_params.is_spectator || message.type !== "stream") {
        return undefined;
    }
    load_stream_threads(message.stream_id);
    const thread = threads_by_root.get(message.id);
    if (thread === undefined || thread.reply_count === 0) {
        return undefined;
    }
    return pill_context(thread);
}

function rerender_roots(root_message_ids: number[]): void {
    const messages = root_message_ids
        .map((id) => message_store.get(id))
        .filter((message): message is Message => message !== undefined);
    if (messages.length === 0) {
        return;
    }
    for (const list of message_lists.all_rendered_message_lists()) {
        list.view.rerender_messages(messages);
    }
}

export function load_stream_threads(stream_id: number, force = false): void {
    if (retrying_streams.has(stream_id)) {
        // The retry will cover whatever arrives meanwhile.
        return;
    }
    if (loading_streams.has(stream_id)) {
        if (force) {
            reload_after_load.add(stream_id);
        }
        return;
    }
    if ((loaded_streams.has(stream_id) || failed_streams.has(stream_id)) && !force) {
        return;
    }
    loading_streams.add(stream_id);
    // The messages that arrived before this request, whose topics its
    // answer covers.
    const covered_message_ids = [...(unclassified_message_ids.get(stream_id) ?? [])];
    void channel.get({
        url: "/json/ykphone/threads",
        data: {stream_id},
        success(raw_data) {
            loading_streams.delete(stream_id);
            for (const message_id of covered_message_ids) {
                unclassified_message_ids.get(stream_id)!.delete(message_id);
            }
            loaded_streams.add(stream_id);
            failed_streams.delete(stream_id);
            failed_attempts.delete(stream_id);
            const data = threads_response_schema.parse(raw_data);
            // Threads no longer listed were deleted or moved to another
            // channel (whose own list brings them back).
            const listed = new Set(data.threads.map((thread) => thread.root_message_id));
            for (const thread of threads_by_root.values()) {
                if (thread.stream_id === stream_id && !listed.has(thread.root_message_id)) {
                    forget(thread);
                }
            }
            for (const topic_name of data.participated_topics) {
                participated_topic_keys.add(topic_key(stream_id, topic_name));
            }
            const changed: number[] = [];
            for (const thread of data.threads) {
                const previous = threads_by_root.get(thread.root_message_id);
                if (
                    previous?.reply_count !== thread.reply_count ||
                    previous.topic_name !== thread.topic_name ||
                    !same_participants(previous.participant_user_ids, thread.participant_user_ids)
                ) {
                    changed.push(thread.root_message_id);
                }
                remember(thread);
            }
            rerender_roots(changed);
            for (const listener of load_listeners) {
                listener(stream_id);
            }
            if (reload_after_load.delete(stream_id)) {
                load_stream_threads(stream_id, true);
            }
        },
        error(xhr) {
            loading_streams.delete(stream_id);
            const attempts = (failed_attempts.get(stream_id) ?? 0) + 1;
            failed_attempts.set(stream_id, attempts);
            // A client error (an archived channel, lost access) will not
            // go away; anything else (a deploy, a flaky network, the
            // rate limit) is worth a few more tries.
            const permanent = xhr.status >= 400 && xhr.status < 500 && xhr.status !== 429;
            const delay = RETRY_DELAYS_MS[attempts - 1];
            if (!permanent && delay !== undefined) {
                // The retry covers anything a queued reload was for.
                reload_after_load.delete(stream_id);
                retrying_streams.add(stream_id);
                setTimeout(() => {
                    retrying_streams.delete(stream_id);
                    load_stream_threads(stream_id, true);
                }, delay);
                return;
            }
            failed_attempts.delete(stream_id);
            failed_streams.add(stream_id);
            // Nothing better is coming until another forced load, so
            // the topics count as what is known of them now.
            unclassified_message_ids.delete(stream_id);
            reload_after_load.delete(stream_id);
        },
    });
}

export function create_thread(message_id: number, on_success: (thread: ThreadInfo) => void): void {
    const known = threads_by_root.get(message_id);
    if (known !== undefined) {
        on_success(known);
        return;
    }
    void channel.post({
        url: "/json/ykphone/threads",
        data: {message_id},
        success(raw_data) {
            const thread = thread_schema.parse(raw_data);
            remember(thread);
            on_success(thread);
        },
        error(xhr) {
            // The root may have just been deleted, or the channel's
            // topic policy changed; say so instead of doing nothing.
            const message = channel.xhr_error_message(
                $t({defaultMessage: "Could not open this thread."}),
                xhr,
            );
            feedback_widget.show({
                title_text: $t({defaultMessage: "Thread"}),
                populate($container) {
                    $container.text(message);
                },
            });
        },
    });
}

function mark_unclassified(stream_id: number, message_ids: number[]): void {
    if (!unclassified_message_ids.has(stream_id)) {
        unclassified_message_ids.set(stream_id, new Set());
    }
    for (const message_id of message_ids) {
        unclassified_message_ids.get(stream_id)!.add(message_id);
    }
}

// New messages in a thread topic bump the root's reply count; a reply
// in a topic we don't know about means someone else opened a thread,
// so the channel's thread list is refreshed.
export function on_new_messages(messages: Message[]): void {
    const changed = new Set<number>();
    const stale_streams = new Set<number>();
    let participation_changed = false;
    for (const message of messages) {
        if (message.type !== "stream" || message.topic === "") {
            continue;
        }
        const key = topic_key(message.stream_id, message.topic);
        const root_id = root_by_topic.get(key);
        if (root_id === undefined) {
            if (
                (message.sender_id === people.my_current_user_id() || message.mentioned) &&
                !participated_topic_keys.has(key)
            ) {
                participated_topic_keys.add(key);
                participation_changed = true;
            }
            // A list being fetched right now may predate the message too.
            if (loaded_streams.has(message.stream_id) || loading_streams.has(message.stream_id)) {
                stale_streams.add(message.stream_id);
                mark_unclassified(message.stream_id, [message.id]);
            }
            continue;
        }
        const thread = threads_by_root.get(root_id)!;
        thread.reply_count += 1;
        thread.last_reply_timestamp = message.timestamp;
        thread.participant_user_ids = [
            message.sender_id,
            ...thread.participant_user_ids.filter((user_id) => user_id !== message.sender_id),
        ].slice(0, MAX_PILL_AVATARS);
        if (!thread.user_participated && message.sender_id === people.my_current_user_id()) {
            thread.user_participated = true;
            participation_changed = true;
        }
        changed.add(root_id);
    }
    rerender_roots([...changed]);
    for (const stream_id of stale_streams) {
        load_stream_threads(stream_id, true);
    }
    if (participation_changed) {
        notify_threads_changed();
    }
}

// Topic moves (renames, resolving, moves to another channel). The
// server moves a thread along with its whole topic
// (ykphone.lib.threads.follow_moved_thread_topic); the cache does the
// same at once and both channels' lists are fetched again to confirm,
// and to learn the outcome of partial moves. Until then the moved
// messages' topics are not taken for plain topics.
export function on_messages_moved(events: UpdateMessageEvent[]): void {
    let moved = false;
    for (const event of events) {
        // The server names the original topic of every move, whether
        // the topic, the channel or both changed.
        const old_topic = util.get_edit_event_orig_topic(event);
        if (event.stream_id === undefined || old_topic === undefined) {
            continue;
        }
        moved = true;
        const old_stream_id = event.stream_id;
        const new_stream_id = event.new_stream_id ?? old_stream_id;
        const new_topic = util.get_edit_event_topic(event) ?? old_topic;
        const old_key = topic_key(old_stream_id, old_topic);
        const new_key = topic_key(new_stream_id, new_topic);
        if (participated_topic_keys.has(old_key)) {
            participated_topic_keys.add(new_key);
        }
        const root_id = root_by_topic.get(old_key);
        if (root_id !== undefined && event.propagate_mode === "change_all") {
            const thread = threads_by_root.get(root_id)!;
            forget(thread);
            if (!root_by_topic.has(new_key)) {
                remember({...thread, stream_id: new_stream_id, topic_name: new_topic});
            }
            rerender_roots([root_id]);
        }
        for (const stream_id of new Set([old_stream_id, new_stream_id])) {
            if (loaded_streams.has(stream_id) || loading_streams.has(stream_id)) {
                mark_unclassified(stream_id, event.message_ids);
                load_stream_threads(stream_id, true);
            }
        }
    }
    if (moved) {
        notify_threads_changed();
    }
}

// Called before deleted messages leave the message store, so a reply's
// topic is still known and its root's count can come down. Deleting a
// root deletes the thread link on the server too (the replies stay as
// an ordinary topic), so the root is simply forgotten.
export function on_messages_removed(message_ids: number[]): void {
    const changed = new Set<number>();
    let roots_removed = false;
    for (const message_id of message_ids) {
        const removed_thread = threads_by_root.get(message_id);
        if (removed_thread !== undefined) {
            forget(removed_thread);
            changed.delete(message_id);
            roots_removed = true;
            continue;
        }
        const message = message_store.get(message_id);
        if (message?.type !== "stream" || message.topic === "") {
            continue;
        }
        const root_id = root_by_topic.get(topic_key(message.stream_id, message.topic));
        if (root_id === undefined) {
            continue;
        }
        const thread = threads_by_root.get(root_id)!;
        thread.reply_count = Math.max(0, thread.reply_count - 1);
        if (thread.reply_count === 0) {
            thread.last_reply_timestamp = null;
        }
        changed.add(root_id);
    }
    rerender_roots([...changed]);
    if (roots_removed) {
        notify_threads_changed();
    }
}

export function clear_for_testing(): void {
    threads_by_root.clear();
    root_by_topic.clear();
    loaded_streams.clear();
    loading_streams.clear();
    failed_streams.clear();
    load_listeners.length = 0;
    threads_changed_listeners.length = 0;
    participated_topic_keys.clear();
    retrying_streams.clear();
    failed_attempts.clear();
    unclassified_message_ids.clear();
    reload_after_load.clear();
}
