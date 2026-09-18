// Slack's Later list (saved items) for the 옆커폰 fork: the data side.
//
// The server keeps one item per saved message (ykphone.SavedItem) in
// step with Zulip's star flag: a message is starred exactly while its
// item is in progress or completed. Changes made through the fork's
// endpoints arrive as ykphone_saved events; a star changed anywhere
// arrives as Zulip's own update_message_flags event, to which
// apply_star_change applies the server's rule. The page is a split
// page (#ykphone/saved/<state>[/<message id>]) drawn by
// ykphone_split_view_ui.ts.

import * as z from "zod/mini";

import * as channel from "./channel.ts";
import {$t} from "./i18n.ts";
import type {RawMessage} from "./message_store.ts";
import {raw_message_schema} from "./message_store.ts";
import * as timerender from "./timerender.ts";
import * as ykphone_activity from "./ykphone_activity.ts";
import * as ykphone_schedule_presets from "./ykphone_schedule_presets.ts";

export type SavedState = "in_progress" | "completed" | "archived";
export const SAVED_STATES: SavedState[] = ["in_progress", "completed", "archived"];

const saved_item_schema = z.object({
    message_id: z.number(),
    state: z.enum(["in_progress", "completed", "archived"]),
    due: z.nullable(z.number()),
    date_created: z.number(),
});
export type SavedItem = z.infer<typeof saved_item_schema>;

const items_response_schema = z.object({
    items: z.array(saved_item_schema),
    in_progress_count: z.number(),
});
const messages_response_schema = z.object({messages: z.array(raw_message_schema)});
export const saved_event_schema = z.discriminatedUnion("op", [
    z.object({type: z.literal("ykphone_saved"), op: z.literal("add"), item: saved_item_schema}),
    z.object({type: z.literal("ykphone_saved"), op: z.literal("update"), item: saved_item_schema}),
    z.object({
        type: z.literal("ykphone_saved"),
        op: z.literal("remove"),
        message_id: z.number(),
    }),
]);

// Undefined until the list has been fetched once. The server lists at
// most a few hundred items per state, so the number in progress is its
// own count, kept current with every change seen since.
let items: Map<number, SavedItem> | undefined;
let in_progress_total = 0;
// Changes that arrive while the first fetch is on the way, applied
// once it has answered (whatever the fetch already reflects, they
// apply again as no change).
let pending_changes: (() => void)[] | undefined;
// The saved messages themselves, for the rows.
const messages = new Map<number, RawMessage>();
const listeners: (() => void)[] = [];

export function is_saved_state(value: string | undefined): value is SavedState {
    return SAVED_STATES.some((state) => state === value);
}

export function state_label(state: SavedState): string {
    const labels: Record<SavedState, string> = {
        in_progress: $t({defaultMessage: "In progress"}),
        completed: $t({defaultMessage: "Completed"}),
        archived: $t({defaultMessage: "Archived"}),
    };
    return labels[state];
}

export function is_loaded(): boolean {
    return items !== undefined;
}

export function get_item(message_id: number): SavedItem | undefined {
    return items?.get(message_id);
}

export function get_message(message_id: number): RawMessage | undefined {
    return messages.get(message_id);
}

// Called whenever the items change (the page's rows, the sidebar count).
export function on_change(listener: () => void): void {
    listeners.push(listener);
}

function notify(): void {
    for (const listener of listeners) {
        listener();
    }
}

export function in_progress_count(): number | undefined {
    return items === undefined ? undefined : in_progress_total;
}

// The sidebar's Later row counts what is in progress; until the list
// has been fetched, upstream's count of starred messages stands in.
export function sidebar_count(starred_count: number): number {
    return in_progress_count() ?? starred_count;
}

export function items_in_state(state: SavedState): SavedItem[] {
    return [...(items?.values() ?? [])]
        .filter((item) => item.state === state)
        .toSorted((a, b) => b.date_created - a.date_created || b.message_id - a.message_id);
}

// Every change of the map goes through here, keeping the count.
function set_item(loaded: Map<number, SavedItem>, message_id: number, item?: SavedItem): void {
    if (loaded.get(message_id)?.state === "in_progress") {
        in_progress_total -= 1;
    }
    if (item === undefined) {
        loaded.delete(message_id);
    } else {
        loaded.set(message_id, item);
        if (item.state === "in_progress") {
            in_progress_total += 1;
        }
    }
}

// Runs a change now, or once the first fetch has answered; a change
// before any fetch has started is what that fetch will say.
function when_loaded(change: (loaded: Map<number, SavedItem>) => void): void {
    if (items !== undefined) {
        change(items);
    } else if (pending_changes !== undefined) {
        pending_changes.push(() => {
            change(items!);
        });
    }
}

// Zulip's star flag changed (update_message_flags): the server has
// applied the same rule to its items.
export function apply_star_change(message_ids: number[], starred: boolean, now: Date): void {
    when_loaded((loaded) => {
        let changed = false;
        for (const message_id of message_ids) {
            const item = loaded.get(message_id);
            if (starred) {
                if (item === undefined) {
                    set_item(loaded, message_id, {
                        message_id,
                        state: "in_progress",
                        due: null,
                        date_created: Math.floor(now.getTime() / 1000),
                    });
                    changed = true;
                } else if (item.state === "archived") {
                    set_item(loaded, message_id, {...item, state: "in_progress"});
                    changed = true;
                }
            } else if (item !== undefined && item.state !== "archived") {
                set_item(loaded, message_id);
                changed = true;
            }
        }
        if (changed) {
            notify();
        }
    });
}

export function handle_event(raw_event: unknown): void {
    const event = saved_event_schema.parse(raw_event);
    when_loaded((loaded) => {
        if (event.op === "remove") {
            set_item(loaded, event.message_id);
        } else {
            set_item(loaded, event.item.message_id, event.item);
        }
        notify();
    });
}

// The messages of the listed items the page has not fetched yet, in
// one request.
export function missing_message_ids(state: SavedState): number[] {
    return items_in_state(state)
        .map((item) => item.message_id)
        .filter((message_id) => !messages.has(message_id));
}

export function load_messages(
    message_ids: number[],
    callbacks: {on_loaded: () => void; on_error: () => void},
): void {
    if (message_ids.length === 0) {
        callbacks.on_loaded();
        return;
    }
    void channel.get({
        url: "/json/messages",
        data: {
            message_ids: JSON.stringify(message_ids),
            apply_markdown: true,
            client_gravatar: true,
            allow_empty_topic_name: true,
        },
        success(raw_data) {
            for (const message of messages_response_schema.parse(raw_data).messages) {
                messages.set(message.id, message);
            }
            callbacks.on_loaded();
        },
        error: callbacks.on_error,
    });
}

export function load(callbacks: {on_loaded: () => void; on_error: () => void}): void {
    pending_changes ??= [];
    void channel.get({
        url: "/json/ykphone/saved",
        success(raw_data) {
            const data = items_response_schema.parse(raw_data);
            items = new Map(data.items.map((item) => [item.message_id, item]));
            in_progress_total = data.in_progress_count;
            const changes = pending_changes ?? [];
            pending_changes = undefined;
            for (const change of changes) {
                change();
            }
            notify();
            callbacks.on_loaded();
        },
        error() {
            pending_changes = undefined;
            callbacks.on_error();
        },
    });
}

// ---- Changes (the server answers with the item, and sends it as an
// event to the user's other clients) ----

type RequestCallbacks = {on_error: () => void};

function answer_with_item(callbacks: RequestCallbacks): {
    success: (raw_data: unknown) => void;
    error: () => void;
} {
    return {
        success(raw_data) {
            const item = saved_item_schema.parse(raw_data);
            when_loaded((loaded) => {
                set_item(loaded, item.message_id, item);
                notify();
            });
        },
        error: callbacks.on_error,
    };
}

export function save(message_id: number, callbacks: RequestCallbacks): void {
    void channel.post({
        url: "/json/ykphone/saved",
        data: {message_id: JSON.stringify(message_id)},
        ...answer_with_item(callbacks),
    });
}

export function set_state(
    message_id: number,
    state: SavedState,
    callbacks: RequestCallbacks,
): void {
    void channel.patch({
        url: `/json/ykphone/saved/${message_id}`,
        data: {state},
        ...answer_with_item(callbacks),
    });
}

// A due date in whole seconds, or null to clear it.
export function set_due(message_id: number, due: number | null, callbacks: RequestCallbacks): void {
    void channel.patch({
        url: `/json/ykphone/saved/${message_id}`,
        data: due === null ? {clear_due: JSON.stringify(true)} : {due: JSON.stringify(due)},
        ...answer_with_item(callbacks),
    });
}

// ---- Rows ----

function same_day(a: Date, b: Date): boolean {
    return a.toDateString() === b.toDateString();
}

// "Today at 3:00 PM", "Tomorrow at 9:00 AM", "Sep 21 at 9:00 AM" or,
// in another year, "Sep 21, 2027 at 9:00 AM".
export function due_label(due: number, now: Date): string {
    const date = new Date(due * 1000);
    const time = timerender.get_localized_date_or_time_for_format(date, "time");
    if (same_day(date, now)) {
        return $t({defaultMessage: "Today at {time}"}, {time});
    }
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    if (same_day(date, tomorrow)) {
        return $t({defaultMessage: "Tomorrow at {time}"}, {time});
    }
    // Another year's date says which year.
    const format = date.getFullYear() === now.getFullYear() ? "dayofyear" : "dayofyear_year";
    return $t(
        {defaultMessage: "{date} at {time}"},
        {date: timerender.get_localized_date_or_time_for_format(date, format), time},
    );
}

export type SavedAction = {
    id: "complete" | "archive" | "due" | "restore";
    label: string;
    icon: string;
};

export function row_actions(state: SavedState): SavedAction[] {
    const complete: SavedAction = {
        id: "complete",
        label: $t({defaultMessage: "Complete"}),
        icon: "check",
    };
    const archive: SavedAction = {
        id: "archive",
        label: $t({defaultMessage: "Archive"}),
        icon: "archive",
    };
    const due: SavedAction = {
        id: "due",
        label: $t({defaultMessage: "Set due date"}),
        icon: "alarm-clock",
    };
    const restore: SavedAction = {
        id: "restore",
        label: $t({defaultMessage: "Mark in progress"}),
        icon: "unarchive",
    };
    const actions: Record<SavedState, SavedAction[]> = {
        in_progress: [complete, archive, due],
        completed: [restore, archive],
        archived: [restore],
    };
    return actions[state];
}

export type SavedRowContext = {
    message_id: number;
    url: string;
    avatar_url: string;
    sender_name: string;
    context_label: string;
    snippet: string;
    time_label: string;
    due_label: string;
    has_due: boolean;
    is_overdue: boolean;
    is_active: boolean;
    actions: SavedAction[];
};

export function row_contexts(
    state: SavedState,
    opts: {selection: string | undefined; hash_for: (message_id: number) => string; now: Date},
): SavedRowContext[] {
    const rows: SavedRowContext[] = [];
    for (const item of items_in_state(state)) {
        const message = messages.get(item.message_id);
        if (message === undefined) {
            // Drawn once its message has been fetched.
            continue;
        }
        const base = ykphone_activity.row_context({message, source: "mentions"});
        rows.push({
            message_id: item.message_id,
            url: opts.hash_for(item.message_id),
            avatar_url: base.avatar_url,
            sender_name: base.sender_name,
            context_label: base.context_label,
            snippet: base.snippet,
            time_label: base.time_label,
            due_label: item.due === null ? "" : due_label(item.due, opts.now),
            has_due: item.due !== null,
            // A completed item's date is history, not a warning.
            is_overdue:
                item.state === "in_progress" &&
                item.due !== null &&
                item.due * 1000 <= opts.now.getTime(),
            is_active: opts.selection === item.message_id.toString(),
            actions: row_actions(state),
        });
    }
    return rows;
}

export function empty_label(state: SavedState): string {
    const labels: Record<SavedState, string> = {
        in_progress: $t({defaultMessage: "Nothing saved for later."}),
        completed: $t({defaultMessage: "No completed items."}),
        archived: $t({defaultMessage: "No archived items."}),
    };
    return labels[state];
}

export type DuePreset = {id: string; text: string; stamp: number};

// Round 13's reminder presets: in 20 minutes, 1 hour, 3 hours,
// tomorrow and Monday. The menu adds a custom time (the date picker)
// and, when a date is set, "Remove due date".
export function due_presets(now: Date): DuePreset[] {
    const context = ykphone_schedule_presets.popover_context(now, true);
    const groups = [
        context.possible_send_later_today,
        context.send_later_tomorrow,
        context.possible_send_later_monday,
    ];
    const presets: DuePreset[] = [];
    for (const group of groups) {
        if (group === false) {
            continue;
        }
        for (const [id, preset] of Object.entries(group)) {
            presets.push({id, text: preset.text, stamp: preset.stamp});
        }
    }
    return presets;
}

// The time a preset stands for, in whole seconds, worked out when it
// is chosen (a relative one counts from then).
export function due_seconds_for(preset: DuePreset, now: Date): number {
    return (
        ykphone_schedule_presets.relative_send_at_seconds(preset.id, now) ??
        Math.floor(preset.stamp / 1000)
    );
}

// Deleted messages take their items with them (the server's foreign
// key cascades; no event of the fork's says so).
export function on_messages_removed(message_ids: number[]): void {
    forget_messages(message_ids);
    when_loaded((loaded) => {
        const removed = message_ids.filter((message_id) => loaded.has(message_id));
        for (const message_id of removed) {
            set_item(loaded, message_id);
        }
        if (removed.length > 0) {
            notify();
        }
    });
}

// Edited or moved messages are fetched again for their rows; returns
// whether any of them was on hand.
export function forget_messages(message_ids: number[]): boolean {
    let forgot = false;
    for (const message_id of message_ids) {
        forgot = messages.delete(message_id) || forgot;
    }
    return forgot;
}

export function clear_for_testing(): void {
    items = undefined;
    in_progress_total = 0;
    pending_changes = undefined;
    messages.clear();
    listeners.length = 0;
}
