// Slack-style Activity feed for the 옆커폰 fork: the data side.
//
// Slack's Activity page lists mentions, thread replies, reactions and
// direct messages in one feed with filter tabs. This module fetches
// each feed (GET /messages with the matching narrow, and our own
// endpoint for thread replies), merges them, and builds the row
// contexts. The page itself (the list beside the selected conversation,
// the tabs) is the split-pane shell in ykphone_split_view.ts and
// ykphone_split_view_ui.ts.

import * as z from "zod/mini";

import * as channel from "./channel.ts";
import * as hash_util from "./hash_util.ts";
import {$t} from "./i18n.ts";
import type {RawMessage} from "./message_store.ts";
import {raw_message_schema} from "./message_store.ts";
import * as people from "./people.ts";
import type {NarrowCanonicalTerm, NarrowTerm} from "./state_data.ts";
import {current_user} from "./state_data.ts";
import * as stream_data from "./stream_data.ts";
import * as timerender from "./timerender.ts";

export type ActivitySource = "mentions" | "threads" | "reactions" | "dm";
export type ActivityTab = "all" | ActivitySource;

export const TABS: ActivityTab[] = ["all", "mentions", "threads", "reactions", "dm"];
const SOURCES: ActivitySource[] = ["mentions", "threads", "reactions", "dm"];

// As many as the server lists for thread replies
// (ykphone.lib.threads.MAX_ACTIVITY_MESSAGES).
const MAX_MESSAGES_PER_SOURCE = 50;

export type ActivityItem = {
    message: RawMessage;
    source: ActivitySource;
};

export type ActivityRowContext = {
    message_id: number;
    avatar_url: string;
    sender_name: string;
    // Where the message is: "#Verona", "#Verona thread" or "DM".
    context_label: string;
    snippet: string;
    time_label: string;
    url: string;
};

const messages_response_schema = z.object({messages: z.array(raw_message_schema)});

// Responses of an earlier load (another tab, or a re-shown page) are
// dropped when they arrive after a newer one started.
let load_generation = 0;

export function tab_label(tab: ActivityTab): string {
    const labels: Record<ActivityTab, string> = {
        all: $t({defaultMessage: "All"}),
        mentions: $t({defaultMessage: "Mentions"}),
        threads: $t({defaultMessage: "Threads"}),
        reactions: $t({defaultMessage: "Reactions"}),
        dm: $t({defaultMessage: "Direct messages"}),
    };
    return labels[tab];
}

const named_entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
};

// The rendered HTML of a message as one line of text, the way Slack
// previews a message in its Activity rows.
export function plain_text_snippet(html: string): string {
    const text = html
        // Block boundaries and line breaks become spaces so words
        // from neighbouring paragraphs do not run together.
        .replaceAll(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|blockquote|pre|tr|td|th)>/gi, " ")
        .replaceAll(/<[^>]*>/g, "")
        .replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity: string, code: string): string => {
            if (code.startsWith("#x") || code.startsWith("#X")) {
                return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
            }
            if (code.startsWith("#")) {
                return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
            }
            return named_entities[code.toLowerCase()] ?? entity;
        })
        .replaceAll(/\s+/g, " ")
        .trim();
    if (text === "" && /<(?:img|a)\b/i.test(html)) {
        return $t({defaultMessage: "(attached file)"});
    }
    return text;
}

function channel_name(message: RawMessage & {type: "stream"}): string {
    const sub = stream_data.get_sub_by_id(message.stream_id);
    if (sub !== undefined) {
        return sub.name;
    }
    return typeof message.display_recipient === "string" ? message.display_recipient : "";
}

export function context_label(message: RawMessage): string {
    if (message.type === "private") {
        return $t({defaultMessage: "DM"});
    }
    const name = channel_name(message);
    // In this fork a topic is a thread; the general chat has none.
    if ((message.subject ?? "") === "") {
        return `#${name}`;
    }
    return $t({defaultMessage: "#{channel_name} thread"}, {channel_name: name});
}

// The conversation the message is in, scrolled to the message.
export function message_terms(message: RawMessage): NarrowCanonicalTerm[] {
    const near: NarrowCanonicalTerm = {operator: "near", operand: message.id.toString()};
    if (message.type === "stream") {
        return [
            {operator: "channel", operand: message.stream_id.toString()},
            {operator: "topic", operand: message.subject ?? ""},
            near,
        ];
    }
    const user_ids =
        typeof message.display_recipient === "string"
            ? []
            : message.display_recipient.map((recipient) => recipient.id);
    const other_user_ids = people.sorted_other_user_ids(user_ids);
    return [
        // A conversation with oneself has no other participant.
        {operator: "dm", operand: other_user_ids.length === 0 ? user_ids : other_user_ids},
        near,
    ];
}

export function message_url(message: RawMessage): string {
    return hash_util.search_terms_to_hash(message_terms(message));
}

export function row_context(item: ActivityItem): ActivityRowContext {
    const {message} = item;
    const sender = people.maybe_get_user_by_id(message.sender_id, true);
    return {
        message_id: message.id,
        // The server serves avatars by user id, so a sender who is not
        // in the user store still gets one.
        avatar_url:
            sender === undefined
                ? `/avatar/${message.sender_id}`
                : people.small_avatar_url_for_person(sender),
        sender_name: message.sender_full_name,
        context_label: context_label(message),
        snippet: plain_text_snippet(message.content),
        time_label: timerender.relative_time_string_from_date(new Date(message.timestamp * 1000)),
        url: message_url(message),
    };
}

// One feed out of the per-source lists: newest first, each message
// once (a mention in a thread is also a thread reply, say).
export function merge(messages_by_source: Map<ActivitySource, RawMessage[]>): ActivityItem[] {
    const seen = new Set<number>();
    const items: ActivityItem[] = [];
    for (const source of SOURCES) {
        for (const message of messages_by_source.get(source) ?? []) {
            if (!seen.has(message.id)) {
                seen.add(message.id);
                items.push({message, source});
            }
        }
    }
    return items.toSorted(
        (a, b) => b.message.timestamp - a.message.timestamp || b.message.id - a.message.id,
    );
}

function narrow_for_source(source: Exclude<ActivitySource, "threads">): NarrowTerm[] {
    const narrows: Record<Exclude<ActivitySource, "threads">, NarrowTerm[]> = {
        mentions: [{operator: "is", operand: "mentioned"}],
        // Upstream's "Reactions" view: messages the user reacted to.
        reactions: [
            {operator: "has", operand: "reaction"},
            {operator: "sender", operand: current_user.user_id},
        ],
        dm: [{operator: "is", operand: "dm"}],
    };
    return narrows[source];
}

function fetch_source(
    source: ActivitySource,
    on_loaded: (messages: RawMessage[]) => void,
    on_error: () => void,
): void {
    if (source === "threads") {
        void channel.get({
            url: "/json/ykphone/threads/activity",
            data: {client_gravatar: true},
            success(raw_data) {
                on_loaded(messages_response_schema.parse(raw_data).messages);
            },
            error: on_error,
        });
        return;
    }
    void channel.get({
        url: "/json/messages",
        data: {
            anchor: "newest",
            num_before: MAX_MESSAGES_PER_SOURCE,
            num_after: 0,
            narrow: JSON.stringify(narrow_for_source(source)),
            apply_markdown: true,
            client_gravatar: true,
            allow_empty_topic_name: true,
        },
        success(raw_data) {
            let messages = messages_response_schema.parse(raw_data).messages;
            if (source === "dm") {
                // Direct messages the user received, not the ones they
                // sent (Slack's Activity lists incoming DMs only).
                messages = messages.filter((message) => message.sender_id !== current_user.user_id);
            } else if (source === "reactions") {
                // The user's own reactions on their own messages are
                // not activity.
                messages = messages.filter((message) =>
                    message.reactions.some((reaction) => reaction.user_id !== current_user.user_id),
                );
            }
            on_loaded(messages);
        },
        error: on_error,
    });
}

export function load(
    tab: ActivityTab,
    callbacks: {on_loaded: (items: ActivityItem[]) => void; on_error: () => void},
): void {
    load_generation += 1;
    const generation = load_generation;
    const sources = tab === "all" ? SOURCES : [tab];
    const loaded = new Map<ActivitySource, RawMessage[]>();
    let failed = false;
    const is_current = (): boolean => generation === load_generation && !failed;
    const on_source_loaded = (source: ActivitySource, messages: RawMessage[]): void => {
        if (!is_current()) {
            return;
        }
        loaded.set(source, messages);
        if (loaded.size === sources.length) {
            callbacks.on_loaded(merge(loaded));
        }
    };
    const on_source_error = (): void => {
        if (!is_current()) {
            return;
        }
        failed = true;
        callbacks.on_error();
    };
    for (const source of sources) {
        fetch_source(
            source,
            (messages) => {
                on_source_loaded(source, messages);
            },
            on_source_error,
        );
    }
}

export function clear_for_testing(): void {
    load_generation = 0;
}
