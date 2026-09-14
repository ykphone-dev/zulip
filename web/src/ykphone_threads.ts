// Slack-style threads for the 옆커폰 fork.
//
// A thread is an ordinary Zulip topic that was opened from one
// "general chat" message; the server keeps the root-message-to-topic
// link (see ykphone/models.py). This module caches those links per
// channel so the message list can show a reply count under each root
// and keep it current as replies arrive.

import * as z from "zod/mini";

import * as channel from "./channel.ts";
import {$t} from "./i18n.ts";
import * as message_lists from "./message_lists.ts";
import * as message_store from "./message_store.ts";
import type {Message} from "./message_store.ts";
import * as stream_data from "./stream_data.ts";
import * as timerender from "./timerender.ts";

const thread_schema = z.object({
    root_message_id: z.number(),
    stream_id: z.number(),
    topic_name: z.string(),
    reply_count: z.number(),
    last_reply_timestamp: z.nullable(z.number()),
});
const threads_response_schema = z.object({threads: z.array(thread_schema)});

export type ThreadInfo = z.infer<typeof thread_schema>;

export type ThreadPillContext = {
    topic_name: string;
    reply_label: string;
    last_reply_label: string | undefined;
};

const threads_by_root = new Map<number, ThreadInfo>();
const root_by_topic = new Map<string, number>();
const loaded_streams = new Set<number>();
const loading_streams = new Set<number>();

function topic_key(stream_id: number, topic_name: string): string {
    return `${stream_id} ${topic_name.toLowerCase()}`;
}

function remember(thread: ThreadInfo): void {
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
        message.type === "stream" &&
        message.topic === "" &&
        !message.locally_echoed &&
        !stream_data.is_empty_topic_only_channel(message.stream_id)
    );
}

export function pill_context(thread: ThreadInfo): ThreadPillContext {
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
    };
}

// Called while building message rows, so it must stay cheap; the
// first look at a channel kicks off a fetch and the rows re-render
// when it lands.
export function get_pill_context_for_message(message: Message): ThreadPillContext | undefined {
    if (message.type !== "stream") {
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
    if (loading_streams.has(stream_id) || (loaded_streams.has(stream_id) && !force)) {
        return;
    }
    loading_streams.add(stream_id);
    void channel.get({
        url: "/json/ykphone/threads",
        data: {stream_id},
        success(raw_data) {
            loading_streams.delete(stream_id);
            loaded_streams.add(stream_id);
            const changed: number[] = [];
            for (const thread of threads_response_schema.parse(raw_data).threads) {
                const previous = threads_by_root.get(thread.root_message_id);
                if (
                    previous === undefined ||
                    previous.reply_count !== thread.reply_count ||
                    previous.topic_name !== thread.topic_name
                ) {
                    changed.push(thread.root_message_id);
                }
                remember(thread);
            }
            rerender_roots(changed);
        },
        error() {
            loading_streams.delete(stream_id);
        },
    });
}

export function create_thread(
    message_id: number,
    on_success: (thread: ThreadInfo) => void,
): void {
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
    });
}

// New messages in a thread topic bump the root's reply count; a reply
// in a topic we don't know about means someone else opened a thread,
// so the channel's thread list is refreshed.
export function on_new_messages(messages: Message[]): void {
    const changed = new Set<number>();
    const stale_streams = new Set<number>();
    for (const message of messages) {
        if (message.type !== "stream" || message.topic === "") {
            continue;
        }
        const root_id = root_by_topic.get(topic_key(message.stream_id, message.topic));
        if (root_id === undefined) {
            if (loaded_streams.has(message.stream_id)) {
                stale_streams.add(message.stream_id);
            }
            continue;
        }
        const thread = threads_by_root.get(root_id)!;
        thread.reply_count += 1;
        thread.last_reply_timestamp = message.timestamp;
        changed.add(root_id);
    }
    rerender_roots([...changed]);
    for (const stream_id of stale_streams) {
        load_stream_threads(stream_id, true);
    }
}

export function clear_for_testing(): void {
    threads_by_root.clear();
    root_by_topic.clear();
    loaded_streams.clear();
    loading_streams.clear();
}
