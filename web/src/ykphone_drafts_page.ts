// Slack's "Drafts & sent" page for the 옆커폰 fork: the data side of the
// split page #ykphone/drafts/<tab>[/<selection>], with the tabs Drafts
// (drafts.ts, kept in this browser), Scheduled (scheduled_messages.ts)
// and Sent (the user's own messages, fetched). Zulip's two overlays,
// #drafts and #scheduled, stay reachable by their URLs.
//
// This module does not import drafts.ts (which calls
// notify_drafts_changed here whenever its store changes); the page's
// DOM side hands in how to read them (set_drafts_source).

import * as z from "zod/mini";

import * as channel from "./channel.ts";
import {$t} from "./i18n.ts";
import type {RawMessage} from "./message_store.ts";
import {raw_message_schema} from "./message_store.ts";
import * as people from "./people.ts";
import * as scheduled_messages from "./scheduled_messages.ts";
import type {ScheduledMessage} from "./scheduled_messages.ts";
import type {NarrowTerm} from "./state_data.ts";
import {current_user} from "./state_data.ts";
import * as stream_data from "./stream_data.ts";
import * as timerender from "./timerender.ts";
import * as ykphone_activity from "./ykphone_activity.ts";
import * as ykphone_saved from "./ykphone_saved.ts";

export type DraftsTab = "drafts" | "scheduled" | "sent";
export const DRAFTS_TABS: DraftsTab[] = ["drafts", "scheduled", "sent"];

// Slack's Sent tab is a recent history; older messages are found
// through search (sender:me).
const MAX_SENT_MESSAGES = 50;

// The shape of a stored draft that the rows need (drafts.ts's
// LocalStorageDraft).
export type PageDraft = {content: string; updatedAt: number} & (
    | {type: "stream"; topic: string; stream_id?: number | undefined}
    | {type: "private"; private_message_recipient_ids: number[]}
);

export function is_drafts_tab(value: string | undefined): value is DraftsTab {
    return DRAFTS_TABS.some((tab) => tab === value);
}

export function tab_label(tab: DraftsTab): string {
    const labels: Record<DraftsTab, string> = {
        drafts: $t({defaultMessage: "Drafts"}),
        scheduled: $t({defaultMessage: "Scheduled"}),
        sent: $t({defaultMessage: "Sent"}),
    };
    return labels[tab];
}

// ---- Drafts (live: drafts.ts tells this module when they change) ----

const drafts_listeners: (() => void)[] = [];
let drafts_source: () => Record<string, PageDraft> = () => ({});

export function set_drafts_source(source: () => Record<string, PageDraft>): void {
    drafts_source = source;
}

export function get_drafts(): Record<string, PageDraft> {
    return drafts_source();
}

export function find_draft(id: string): PageDraft | undefined {
    return get_drafts()[id];
}

export function on_drafts_changed(listener: () => void): void {
    drafts_listeners.push(listener);
}

export function notify_drafts_changed(): void {
    for (const listener of drafts_listeners) {
        listener();
    }
}

function channel_label(stream_id: number | undefined, topic: string): string {
    const name = stream_id === undefined ? undefined : stream_data.get_sub_by_id(stream_id)?.name;
    if (name === undefined) {
        return $t({defaultMessage: "No channel selected"});
    }
    // In this fork a topic is a thread; the general chat has none.
    if (topic === "") {
        return `#${name}`;
    }
    return $t({defaultMessage: "#{channel_name} thread"}, {channel_name: name});
}

function people_label(user_ids: number[]): string {
    if (user_ids.length === 0) {
        return $t({defaultMessage: "No recipients"});
    }
    return people
        .get_users_from_ids(user_ids.filter((user_id) => people.is_known_user_id(user_id)))
        .map((user) => user.full_name)
        .join(", ");
}

// A draft is Markdown the user typed; its row shows it as one line.
export function draft_snippet(content: string): string {
    return content.replaceAll(/\s+/g, " ").trim();
}

export function draft_narrow_terms(draft: PageDraft): NarrowTerm[] | undefined {
    if (draft.type === "stream") {
        if (
            draft.stream_id === undefined ||
            stream_data.get_sub_by_id(draft.stream_id) === undefined
        ) {
            return undefined;
        }
        return [
            {operator: "channel", operand: draft.stream_id.toString()},
            {operator: "topic", operand: draft.topic},
        ];
    }
    const user_ids = draft.private_message_recipient_ids.filter((user_id) =>
        people.is_known_user_id(user_id),
    );
    if (user_ids.length === 0) {
        return undefined;
    }
    return [{operator: "dm", operand: user_ids}];
}

export type DraftRowContext = {
    id: string;
    url: string;
    recipient: string;
    snippet: string;
    time_label: string;
    is_active: boolean;
};

// Newest first, one row per draft (Zulip may keep more than one draft
// for a conversation; none is hidden).
export function draft_rows(
    drafts: Record<string, PageDraft>,
    opts: {selection: string | undefined; hash_for: (id: string) => string},
): DraftRowContext[] {
    return Object.entries(drafts)
        .toSorted(([id_a, a], [id_b, b]) => b.updatedAt - a.updatedAt || id_b.localeCompare(id_a))
        .map(([id, draft]) => ({
            id,
            url: opts.hash_for(id),
            recipient:
                draft.type === "stream"
                    ? channel_label(draft.stream_id, draft.topic)
                    : people_label(draft.private_message_recipient_ids),
            snippet: draft_snippet(draft.content),
            time_label: timerender.relative_time_string_from_date(new Date(draft.updatedAt)),
            is_active: opts.selection === id,
        }));
}

// ---- Scheduled ----

export function find_scheduled(id: string): ScheduledMessage | undefined {
    return scheduled_messages.scheduled_messages_by_id.get(Number(id));
}

export function get_scheduled_messages(): ScheduledMessage[] {
    return scheduled_messages.get_all_scheduled_messages();
}

export function scheduled_narrow_terms(message: ScheduledMessage): NarrowTerm[] | undefined {
    if (message.type === "stream") {
        if (stream_data.get_sub_by_id(message.to) === undefined) {
            return undefined;
        }
        return [
            {operator: "channel", operand: message.to.toString()},
            {operator: "topic", operand: message.topic},
        ];
    }
    const user_ids = message.to.filter((user_id) => user_id !== current_user.user_id);
    return [{operator: "dm", operand: user_ids.length === 0 ? message.to : user_ids}];
}

export type ScheduledRowContext = {
    id: number;
    url: string;
    recipient: string;
    snippet: string;
    time_label: string;
    failed: boolean;
    is_active: boolean;
};

// Soonest first, as Slack lists what is about to be sent.
export function scheduled_rows(
    messages: ScheduledMessage[],
    opts: {selection: string | undefined; hash_for: (id: string) => string; now: Date},
): ScheduledRowContext[] {
    return messages
        .toSorted(
            (a, b) =>
                a.scheduled_delivery_timestamp - b.scheduled_delivery_timestamp ||
                a.scheduled_message_id - b.scheduled_message_id,
        )
        .map((message) => {
            const id = message.scheduled_message_id.toString();
            return {
                id: message.scheduled_message_id,
                url: opts.hash_for(id),
                recipient:
                    message.type === "stream"
                        ? channel_label(message.to, message.topic)
                        : people_label(
                              message.to.length > 1
                                  ? message.to.filter((user_id) => user_id !== current_user.user_id)
                                  : message.to,
                          ),
                snippet: ykphone_activity.plain_text_snippet(message.rendered_content),
                time_label: ykphone_saved.due_label(message.scheduled_delivery_timestamp, opts.now),
                failed: message.failed,
                is_active: opts.selection === id,
            };
        });
}

// ---- Sent ----

const messages_response_schema = z.object({messages: z.array(raw_message_schema)});

// Undefined until the first fetch has answered.
let sent_messages: RawMessage[] | undefined;
let sent_generation = 0;

export function get_sent_messages(): RawMessage[] | undefined {
    return sent_messages;
}

export function find_sent_message(message_id: number): RawMessage | undefined {
    return sent_messages?.find((message) => message.id === message_id);
}

export function load_sent(callbacks: {on_loaded: () => void; on_error: () => void}): void {
    sent_generation += 1;
    const generation = sent_generation;
    void channel.get({
        url: "/json/messages",
        data: {
            anchor: "newest",
            num_before: MAX_SENT_MESSAGES,
            num_after: 0,
            narrow: JSON.stringify([{operator: "sender", operand: current_user.user_id}]),
            apply_markdown: true,
            client_gravatar: true,
            allow_empty_topic_name: true,
        },
        success(raw_data) {
            if (generation !== sent_generation) {
                return;
            }
            sent_messages = messages_response_schema
                .parse(raw_data)
                .messages.toSorted((a, b) => b.id - a.id);
            callbacks.on_loaded();
        },
        error() {
            if (generation === sent_generation) {
                callbacks.on_error();
            }
        },
    });
}

// The other participants of a direct message, or the user themself for
// a conversation with oneself.
function dm_user_ids(message: RawMessage): number[] {
    const user_ids =
        typeof message.display_recipient === "string"
            ? []
            : message.display_recipient.map((recipient) => recipient.id);
    const others = people.sorted_other_user_ids(user_ids);
    return others.length === 0 ? [current_user.user_id] : others;
}

export type SentRowContext = {
    message_id: number;
    url: string;
    recipient: string;
    snippet: string;
    time_label: string;
    is_active: boolean;
};

export function sent_rows(opts: {
    selection: string | undefined;
    hash_for: (id: string) => string;
}): SentRowContext[] {
    return (sent_messages ?? []).map((message) => {
        const id = message.id.toString();
        return {
            message_id: message.id,
            url: opts.hash_for(id),
            recipient:
                message.type === "stream"
                    ? ykphone_activity.context_label(message)
                    : people_label(dm_user_ids(message)),
            snippet: ykphone_activity.plain_text_snippet(message.content),
            time_label: timerender.relative_time_string_from_date(
                new Date(message.timestamp * 1000),
            ),
            is_active: opts.selection === id,
        };
    });
}

export type RowAction = {id: "delete" | "edit" | "cancel"; label: string; icon: string};

// One row of any tab, as the page's template draws it.
export type PageRowContext = {
    key: string;
    id: string;
    url: string;
    recipient: string;
    snippet: string;
    time_label: string;
    failed: boolean;
    is_active: boolean;
    has_actions: boolean;
    actions: RowAction[];
};

export function page_rows(
    tab: DraftsTab,
    opts: {selection: string | undefined; hash_for: (id: string) => string; now: Date},
): PageRowContext[] {
    if (tab === "drafts") {
        const actions: RowAction[] = [
            {id: "delete", label: $t({defaultMessage: "Delete draft"}), icon: "trash"},
        ];
        return draft_rows(get_drafts(), opts).map((row) => ({
            key: `draft-${row.id}`,
            id: row.id,
            url: row.url,
            recipient: row.recipient,
            snippet: row.snippet,
            time_label: row.time_label,
            failed: false,
            is_active: row.is_active,
            has_actions: true,
            actions,
        }));
    }
    if (tab === "scheduled") {
        const actions: RowAction[] = [
            {id: "edit", label: $t({defaultMessage: "Edit"}), icon: "edit"},
            {id: "cancel", label: $t({defaultMessage: "Cancel scheduled message"}), icon: "x"},
        ];
        return scheduled_rows(get_scheduled_messages(), opts).map((row) => ({
            key: `scheduled-${row.id}`,
            id: row.id.toString(),
            url: row.url,
            recipient: row.recipient,
            snippet: row.snippet,
            time_label: row.time_label,
            failed: row.failed,
            is_active: row.is_active,
            has_actions: true,
            actions,
        }));
    }
    return sent_rows(opts).map((row) => ({
        key: `sent-${row.message_id}`,
        id: row.message_id.toString(),
        url: row.url,
        recipient: row.recipient,
        snippet: row.snippet,
        time_label: row.time_label,
        failed: false,
        is_active: row.is_active,
        has_actions: false,
        actions: [],
    }));
}

export function empty_label(tab: DraftsTab): string {
    const labels: Record<DraftsTab, string> = {
        drafts: $t({defaultMessage: "No drafts."}),
        scheduled: $t({defaultMessage: "No scheduled messages."}),
        sent: $t({defaultMessage: "You have not sent any messages yet."}),
    };
    return labels[tab];
}

export function clear_sent_messages(): void {
    sent_messages = undefined;
}

export function clear_for_testing(): void {
    drafts_listeners.length = 0;
    drafts_source = () => ({});
    sent_messages = undefined;
    sent_generation = 0;
}
