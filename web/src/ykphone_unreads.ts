// Slack's "All unreads" page for the 옆커폰 fork: the data side of the
// split page #ykphone/unreads[/<message id>].
//
// The unread messages are fetched (GET /messages, is:unread) and put in
// groups by conversation, the group with the newest message first; a
// group shows its newest few messages, oldest of them first, and says
// how many are unread in all (unread.ts knows the exact count). What
// Zulip's home view hides (muted channels and topics) is left out, as
// Slack leaves muted channels out. A group is selected by its first
// listed message, which opens the conversation at that message.

import * as z from "zod/mini";

import * as channel from "./channel.ts";
import {$t} from "./i18n.ts";
import type {Message, RawMessage} from "./message_store.ts";
import {raw_message_schema} from "./message_store.ts";
import * as people from "./people.ts";
import type {NarrowTerm} from "./state_data.ts";
import {current_user} from "./state_data.ts";
import * as timerender from "./timerender.ts";
import * as unread from "./unread.ts";
import * as user_topics from "./user_topics.ts";
import * as ykphone_activity from "./ykphone_activity.ts";

// Slack shows a few messages of each conversation and a link to the
// rest; the conversation itself is one click away.
export const MESSAGES_PER_GROUP = 5;
// The unread messages are read newest first, a page at a time, until
// every unread conversation unread.ts knows of has a group (or the
// history ends); what is still missing after the last page is summed
// up under the groups rather than left out silently.
const PAGE_SIZE = 1000;
const MAX_PAGES = 5;
// Muted channels and topics are left out by the server, so they take
// no part of the pages.
const UNREAD_NARROW = [
    {operator: "is", operand: "unread"},
    {operator: "is", operand: "muted", negated: true},
];

const messages_response_schema = z.object({
    messages: z.array(raw_message_schema),
    found_oldest: z.boolean(),
});

export type UnreadGroup = {
    // "c<stream id>:<topic in lower case>" or "d<user ids string>".
    key: string;
    // Every fetched unread message of the conversation, oldest first.
    messages: RawMessage[];
};

// Undefined until the first fetch has answered.
let fetched: RawMessage[] | undefined;
let generation = 0;

export function is_loaded(): boolean {
    return fetched !== undefined;
}

function dm_user_ids_string(message: RawMessage): string {
    const user_ids =
        typeof message.display_recipient === "string"
            ? []
            : message.display_recipient.map((recipient) => recipient.id);
    const others = people.sorted_other_user_ids(user_ids);
    return (others.length === 0 ? [current_user.user_id] : others).join(",");
}

function topic_of(message: RawMessage & {type: "stream"}): string {
    return message.subject ?? "";
}

export function group_key(message: RawMessage): string {
    if (message.type === "stream") {
        return `c${message.stream_id}:${topic_of(message).toLowerCase()}`;
    }
    return `d${dm_user_ids_string(message)}`;
}

function is_visible(message: RawMessage): boolean {
    if (message.type !== "stream") {
        return true;
    }
    return user_topics.is_topic_visible_in_home(message.stream_id, topic_of(message));
}

// The groups of what is still unread, newest group first.
export function groups(): UnreadGroup[] {
    const still_unread = new Set(unread.get_unread_message_ids((fetched ?? []).map((m) => m.id)));
    const by_key = new Map<string, RawMessage[]>();
    for (const message of fetched ?? []) {
        if (!still_unread.has(message.id) || !is_visible(message)) {
            continue;
        }
        const key = group_key(message);
        const list = by_key.get(key) ?? [];
        list.push(message);
        by_key.set(key, list);
    }
    return [...by_key.entries()]
        .map(([key, messages]) => ({key, messages: messages.toSorted((a, b) => a.id - b.id)}))
        .toSorted((a, b) => b.messages.at(-1)!.id - a.messages.at(-1)!.id);
}

// How many are unread in the whole conversation (more than were
// fetched when the history is long).
export function unread_count(group: UnreadGroup): number {
    const first = group.messages[0]!;
    const counted =
        first.type === "stream"
            ? unread.num_unread_for_topic(first.stream_id, topic_of(first))
            : unread.num_unread_for_user_ids_string(dm_user_ids_string(first));
    return Math.max(counted, group.messages.length);
}

export function group_label(group: UnreadGroup): string {
    const first = group.messages[0]!;
    if (first.type === "stream") {
        return ykphone_activity.context_label(first);
    }
    return people.format_recipients(dm_user_ids_string(first), "narrow");
}

export type UnreadMessageContext = {
    message_id: number;
    // The same sender as the message above: drawn without the avatar
    // and name, as Slack groups a sender's messages.
    is_continuation: boolean;
    avatar_url: string;
    sender_name: string;
    time_label: string;
    snippet: string;
};

export type UnreadGroupContext = {
    key: string;
    url: string;
    label: string;
    // "읽음 처리" for a screen reader, naming the conversation.
    mark_read_label: string;
    // A thread's name (its topic), which tells two threads of one
    // channel apart; empty for a general chat and a direct message.
    topic: string;
    count: number;
    more_label: string;
    has_more: boolean;
    messages: UnreadMessageContext[];
    is_active: boolean;
};

export function group_contexts(opts: {
    selection: string | undefined;
    hash_for: (selection: string) => string;
}): UnreadGroupContext[] {
    return groups().map((group) => {
        const first = group.messages[0]!;
        const listed = group.messages.slice(-MESSAGES_PER_GROUP);
        const count = unread_count(group);
        const selection = selection_for(group);
        return {
            key: group.key,
            url: opts.hash_for(selection),
            label: group_label(group),
            mark_read_label: $t(
                {defaultMessage: "Mark {conversation} as read"},
                {conversation: group_label(group)},
            ),
            topic: first.type === "stream" ? topic_of(first) : "",
            count,
            more_label:
                count > listed.length
                    ? $t(
                          {
                              defaultMessage:
                                  "{count, plural, one {# more unread message} other {# more unread messages}}",
                          },
                          {count: count - listed.length},
                      )
                    : "",
            has_more: count > listed.length,
            messages: listed.map((message, index) => {
                const base = ykphone_activity.row_context({message, source: "mentions"});
                return {
                    message_id: message.id,
                    is_continuation: listed[index - 1]?.sender_id === message.sender_id,
                    avatar_url: base.avatar_url,
                    sender_name: base.sender_name,
                    time_label: timerender.get_localized_date_or_time_for_format(
                        new Date(message.timestamp * 1000),
                        "time",
                    ),
                    snippet: base.snippet,
                };
            }),
            is_active: opts.selection === selection,
        };
    });
}

// A group is selected by the first of its listed messages.
export function selection_for(group: UnreadGroup): string {
    return group.messages.slice(-MESSAGES_PER_GROUP)[0]!.id.toString();
}

export function find_group(selection: string): UnreadGroup | undefined {
    return groups().find((group) =>
        group.messages.some((message) => message.id.toString() === selection),
    );
}

// The conversation of a selection, at the selected message; a group
// that has been read since is still found among the fetched messages.
export function narrow_terms(selection: string): NarrowTerm[] | undefined {
    const message = fetched?.find((candidate) => candidate.id.toString() === selection);
    return message === undefined ? undefined : ykphone_activity.message_terms(message);
}

// The ids "Mark as read" marks: every unread message of the group's
// conversation that is known (unread.ts's ids, which include messages
// that were not fetched).
export function conversation_unread_ids(group: UnreadGroup): number[] {
    const first = group.messages[0]!;
    const known =
        first.type === "stream"
            ? unread.get_msg_ids_for_topic(first.stream_id, topic_of(first))
            : unread.get_msg_ids_for_user_ids_string(dm_user_ids_string(first));
    return [...new Set([...known, ...group.messages.map((message) => message.id)])].toSorted(
        (a, b) => a - b,
    );
}

// The key of the group after (or before) the given one, for J/K.
export function adjacent_group_key(
    keys: string[],
    current: string | undefined,
    direction: 1 | -1,
): string | undefined {
    if (keys.length === 0) {
        return undefined;
    }
    const index = current === undefined ? -1 : keys.indexOf(current);
    if (index === -1) {
        return direction === 1 ? keys[0] : keys.at(-1);
    }
    return keys[Math.min(Math.max(index + direction, 0), keys.length - 1)];
}

// Whether new messages add to the page: an unread message from
// somebody else that the page would show.
export function affects_unreads(messages: Message[]): boolean {
    return messages.some(
        (message) =>
            message.unread &&
            message.sender_id !== current_user.user_id &&
            (message.type !== "stream" ||
                user_topics.is_topic_visible_in_home(message.stream_id, message.topic)),
    );
}

// Every unread conversation the home view shows, by group key, with
// its unread message ids (unread.ts knows all of them, fetched or not).
export function known_unread_conversations(): Map<string, number[]> {
    const conversations = new Map<string, number[]>();
    for (const [stream_id, topics] of unread.get_unread_topics().topic_counts) {
        for (const topic of topics.keys()) {
            if (user_topics.is_topic_visible_in_home(stream_id, topic)) {
                conversations.set(
                    `c${stream_id}:${topic.toLowerCase()}`,
                    unread.get_msg_ids_for_topic(stream_id, topic),
                );
            }
        }
    }
    for (const user_ids_string of unread.get_unread_pm().pm_dict.keys()) {
        conversations.set(
            `d${user_ids_string}`,
            unread.get_msg_ids_for_user_ids_string(user_ids_string),
        );
    }
    return conversations;
}

function covered_keys(messages: RawMessage[]): Set<string> {
    return new Set(messages.map((message) => group_key(message)));
}

// The unread messages of the conversations that have no group: older
// than the pages the page read.
export function hidden_unread_message_ids(): number[] {
    if (fetched === undefined) {
        return [];
    }
    const covered = covered_keys(fetched);
    return [...known_unread_conversations()]
        .filter(([key]) => !covered.has(key))
        .flatMap(([, message_ids]) => message_ids);
}

export function load(callbacks: {on_loaded: () => void; on_error: () => void}): void {
    generation += 1;
    const current = generation;
    const collected: RawMessage[] = [];
    const fetch_page = (anchor: number | undefined, page: number): void => {
        void channel.get({
            url: "/json/messages",
            data: {
                anchor: anchor === undefined ? "newest" : anchor.toString(),
                include_anchor: anchor === undefined,
                num_before: PAGE_SIZE,
                num_after: 0,
                narrow: JSON.stringify(UNREAD_NARROW),
                apply_markdown: true,
                client_gravatar: true,
                allow_empty_topic_name: true,
            },
            success(raw_data) {
                if (current !== generation) {
                    return;
                }
                const response = messages_response_schema.parse(raw_data);
                collected.push(...response.messages);
                const covered = covered_keys(collected);
                const all_covered = [...known_unread_conversations().keys()].every((key) =>
                    covered.has(key),
                );
                if (
                    response.found_oldest ||
                    response.messages.length === 0 ||
                    all_covered ||
                    page + 1 >= MAX_PAGES
                ) {
                    fetched = collected;
                    callbacks.on_loaded();
                    return;
                }
                fetch_page(Math.min(...response.messages.map((message) => message.id)), page + 1);
            },
            error() {
                if (current === generation) {
                    callbacks.on_error();
                }
            },
        });
    };
    fetch_page(undefined, 0);
}

// Whether an edited, moved or deleted message is one the page shows.
export function has_message(message_id: number): boolean {
    return fetched?.some((message) => message.id === message_id) ?? false;
}

export function clear(): void {
    fetched = undefined;
}

export function clear_for_testing(): void {
    fetched = undefined;
    generation = 0;
}
