// A status's "Clear after" (Slack's status expiry) for the 옆커폰
// fork: the data side.
//
// The status itself is Zulip's (user_status.ts). The time it is to be
// cleared is the fork's (ykphone.StatusExpiry): the status modal saves
// it right after the status, a cron job clears the status once the
// time has passed, and changing or clearing the status by hand, from
// any client, drops it on the server. Everyone who can see the user
// learns the time (ykphone_status_expiry events), shown next to the
// status as "until 3:00 PM".

import * as z from "zod/mini";

import * as channel from "./channel.ts";
import {$t} from "./i18n.ts";
import * as ykphone_notification_pause from "./ykphone_notification_pause.ts";

const expiries_response_schema = z.object({expiries: z.record(z.string(), z.number())});
export const status_expiry_event_schema = z.object({
    type: z.literal("ykphone_status_expiry"),
    user_id: z.number(),
    clear_at: z.nullable(z.number()),
});

export type ClearAfter = "never" | "30m" | "1h" | "4h" | "today" | "week" | "custom";
const CLEAR_AFTER: ClearAfter[] = ["never", "30m", "1h", "4h", "today", "week", "custom"];

// When each user's status is to be cleared, in seconds.
const expiries = new Map<number, number>();
let loaded = false;
let pending_events: (() => void)[] | undefined;
const listeners: (() => void)[] = [];

export function on_change(listener: () => void): void {
    listeners.push(listener);
}

function notify(): void {
    for (const listener of listeners) {
        listener();
    }
}

export function is_clear_after(value: string): value is ClearAfter {
    return CLEAR_AFTER.some((option) => option === value);
}

export function get_clear_at(user_id: number): number | undefined {
    return expiries.get(user_id);
}

function end_of_day(date: Date): number {
    const end = new Date(date);
    end.setHours(23, 59, 59, 0);
    return Math.floor(end.getTime() / 1000);
}

// The time a choice stands for, in seconds, from the moment the status
// is saved: undefined for "Don't clear" and for a custom time (which
// the modal keeps itself). "Today" ends at 23:59:59; "This week" at the
// end of Sunday, the week running from Monday (never less than a minute
// away, so a choice made at 23:59:59 is still in the future).
export function clear_at_for(option: ClearAfter, now: Date): number | undefined {
    const in_minutes = (minutes: number): number => Math.floor(now.getTime() / 1000) + minutes * 60;
    switch (option) {
        case "30m":
            return in_minutes(30);
        case "1h":
            return in_minutes(60);
        case "4h":
            return in_minutes(4 * 60);
        case "today":
            return Math.max(end_of_day(now), in_minutes(1));
        case "week": {
            const sunday = new Date(now);
            sunday.setDate(now.getDate() + ((7 - now.getDay()) % 7));
            return Math.max(end_of_day(sunday), in_minutes(1));
        }
        default:
            return undefined;
    }
}

// The choice a preset status comes with, as Slack's do; the others
// (and any text of one's own) leave the choice as it is.
export function default_clear_after(status_text: string): ClearAfter | undefined {
    const defaults: [string, ClearAfter][] = [
        [$t({defaultMessage: "In a meeting"}), "1h"],
        [$t({defaultMessage: "Commuting"}), "30m"],
        [$t({defaultMessage: "Out sick"}), "today"],
        [$t({defaultMessage: "Vacationing"}), "week"],
        [$t({defaultMessage: "Working remotely"}), "today"],
    ];
    return defaults.find(([text]) => text === status_text)?.[1];
}

// "Until 3:00 PM" under a status that is to be cleared.
export function until_label(user_id: number, now: Date): string | undefined {
    const clear_at = expiries.get(user_id);
    if (clear_at === undefined || clear_at * 1000 <= now.getTime()) {
        return undefined;
    }
    return $t(
        {defaultMessage: "Until {time}"},
        {time: ykphone_notification_pause.time_phrase(clear_at * 1000, now)},
    );
}

export type CardAvailability = {
    notifications_paused: boolean;
    status_until: string | undefined;
};

// What a user card says under the status: until when it is set, and
// whether the user's notifications are paused.
export function card_availability(user_id: number, now: Date): CardAvailability {
    return {
        notifications_paused: ykphone_notification_pause.is_user_paused(user_id, now),
        status_until: until_label(user_id, now),
    };
}

function when_loaded(change: () => void): void {
    if (loaded) {
        change();
        notify();
    } else if (pending_events !== undefined) {
        pending_events.push(change);
    }
}

export function handle_event(raw_event: unknown): void {
    const event = status_expiry_event_schema.parse(raw_event);
    when_loaded(() => {
        if (event.clear_at === null) {
            expiries.delete(event.user_id);
        } else {
            expiries.set(event.user_id, event.clear_at);
        }
    });
}

export function load(): void {
    pending_events = [];
    void channel.get({
        url: "/json/ykphone/status_expiry",
        success(raw_data) {
            const data = expiries_response_schema.parse(raw_data);
            expiries.clear();
            for (const [user_id, clear_at] of Object.entries(data.expiries)) {
                expiries.set(Number(user_id), clear_at);
            }
            loaded = true;
            for (const change of pending_events ?? []) {
                change();
            }
            pending_events = undefined;
            notify();
        },
        error() {
            pending_events = undefined;
        },
    });
}

// Saves (or with null, removes) the time the current status is cleared.
export function save(clear_at: number | null, on_error: () => void): void {
    void channel.put({
        url: "/json/ykphone/status_expiry",
        data: {clear_at: JSON.stringify(clear_at)},
        error: on_error,
    });
}

export function clear_for_testing(): void {
    expiries.clear();
    loaded = false;
    pending_events = undefined;
    listeners.length = 0;
}
