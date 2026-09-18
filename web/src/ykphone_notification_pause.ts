// Pausing notifications (Slack's "Pause notifications" and
// notification schedule) for the 옆커폰 fork: the data side.
//
// The server (ykphone.lib.notification_pause) holds the user's pause
// end and schedule, and skips mobile push and email notifications
// while the user is paused. The web app decides for itself whether to
// play sounds and show desktop notifications, with the same rule as
// the server: paused until `until`, and, when the schedule is on,
// outside its hours (in the user's Zulip time zone; days are 0-6 from
// Monday; an end at or before the start runs past midnight).
//
// Other users' paused state arrives as a list at page load and as
// ykphone_paused_users events when a user's settings flip it; the end
// time of someone else's pause is not shared.

import * as z from "zod/mini";

import * as channel from "./channel.ts";
import {$t} from "./i18n.ts";
import * as people from "./people.ts";
import * as timerender from "./timerender.ts";
import {user_settings} from "./user_settings.ts";

const schedule_schema = z.object({
    enabled: z.boolean(),
    days: z.array(z.number()),
    start: z.string(),
    end: z.string(),
});
export type Schedule = z.infer<typeof schedule_schema>;

const state_response_schema = z.object({
    until: z.nullable(z.number()),
    schedule: schedule_schema,
    mobile: z.nullable(z.boolean()),
    paused_user_ids: z.array(z.number()),
});
const patch_response_schema = z.object({
    until: z.nullable(z.number()),
    schedule: schedule_schema,
    mobile: z.nullable(z.boolean()),
});

export const notification_pause_event_schema = z.object({
    type: z.literal("ykphone_notification_pause"),
    until: z.nullable(z.number()),
    schedule: schedule_schema,
    mobile: z.nullable(z.boolean()),
});
export const paused_users_event_schema = z.object({
    type: z.literal("ykphone_paused_users"),
    user_id: z.number(),
    paused: z.boolean(),
});

export const DEFAULT_SCHEDULE: Schedule = {
    enabled: false,
    days: [0, 1, 2, 3, 4],
    start: "09:00",
    end: "18:00",
};

let until: number | null = null;
let schedule: Schedule = DEFAULT_SCHEDULE;
// The settings page's mobile choice; null until first made.
let mobile: boolean | null = null;
const paused_user_ids = new Set<number>();
let loaded = false;
// Events that arrive while the first fetch is on the way, applied once
// it has answered.
let pending_events: (() => void)[] | undefined;
const listeners: (() => void)[] = [];

// Called whenever someone's paused state may have changed (the rail
// badge, the DM rows, an open settings page).
export function on_change(listener: () => void): void {
    listeners.push(listener);
}

export function notify(): void {
    for (const listener of listeners) {
        listener();
    }
}

export function is_loaded(): boolean {
    return loaded;
}

export function get_until(): number | null {
    return until;
}

export function get_schedule(): Schedule {
    return schedule;
}

export function get_mobile_preference(): boolean | null {
    return mobile;
}

function minutes_of(time: string): number {
    const [hours, minutes] = time.split(":");
    return Number(hours) * 60 + Number(minutes);
}

// Whether the schedule's hours include a wall-clock time (weekday 0-6
// from Monday, minutes since midnight). A window that ends at or
// before its start runs into the next day and belongs to the day it
// starts on.
export function schedule_allows(schedule: Schedule, weekday: number, minute: number): boolean {
    const start = minutes_of(schedule.start);
    const end = minutes_of(schedule.end);
    if (start < end) {
        return schedule.days.includes(weekday) && start <= minute && minute < end;
    }
    const previous_day = (weekday + 6) % 7;
    return (
        (schedule.days.includes(weekday) && minute >= start) ||
        (schedule.days.includes(previous_day) && minute < end)
    );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// The weekday (0-6 from Monday) and minute of the day of a moment on
// the wall clock of a time zone; undefined when the zone is unset or
// unknown, in which case the schedule is not applied (as on the server).
export function wall_clock(
    date: Date,
    time_zone: string,
): {weekday: number; minute: number} | undefined {
    if (time_zone === "") {
        return undefined;
    }
    let format: Intl.DateTimeFormat;
    try {
        format = new Intl.DateTimeFormat("en-US", {
            timeZone: time_zone,
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
        });
    } catch {
        return undefined;
    }
    const parts = new Map(format.formatToParts(date).map((part) => [part.type, part.value]));
    return {
        weekday: WEEKDAYS.indexOf(parts.get("weekday")!),
        minute: Number(parts.get("hour")) * 60 + Number(parts.get("minute")),
    };
}

export function is_paused_at(
    pause: {until: number | null; schedule: Schedule},
    now: Date,
    time_zone: string,
): boolean {
    if (pause.until !== null && now.getTime() < pause.until * 1000) {
        return true;
    }
    if (!pause.schedule.enabled) {
        return false;
    }
    const clock = wall_clock(now, time_zone);
    return clock !== undefined && !schedule_allows(pause.schedule, clock.weekday, clock.minute);
}

// Whether the current user's notifications are paused now.
export function is_paused(now: Date): boolean {
    return is_paused_at({until, schedule}, now, user_settings.timezone);
}

// Whether the web app keeps quiet about a new message (no sound, no
// desktop notification): never for the settings page's test
// notification, which exists to try them out.
//
// Until the page's first fetch has answered, the state is unknown; a
// user who is paused would hear the messages of that first moment, so
// they are held back too (a failed fetch ends the wait).
export function holds_back_notifications(message: {type: string}, now: Date): boolean {
    return message.type !== "test-notification" && (is_loading() || is_paused(now));
}

export function is_loading(): boolean {
    return !loaded && pending_events !== undefined;
}

// For the rows and cards that mark paused users. The current user's
// own state is worked out here (it changes with the clock); everyone
// else's is what the server last said.
export function is_user_paused(user_id: number, now: Date): boolean {
    if (people.is_my_user_id(user_id)) {
        return is_paused(now);
    }
    return paused_user_ids.has(user_id);
}

// A DM row's badge: a 1:1 conversation with someone paused (not the
// conversation with oneself, whose badge is the rail's).
export function dm_row_paused(user_ids_string: string, now: Date): boolean {
    if (user_ids_string.includes(",")) {
        return false;
    }
    const user_id = Number(user_ids_string);
    return !people.is_my_user_id(user_id) && is_user_paused(user_id, now);
}

// The time zone the schedule runs in, by name ("한국 표준시"), for the
// settings page; the zone's own name when the browser has none for it.
export function zone_label(time_zone: string, language: string, now: Date): string {
    try {
        // A "long" time zone name is always one of the parts.
        return new Intl.DateTimeFormat(language, {timeZone: time_zone, timeZoneName: "long"})
            .formatToParts(now)
            .find((candidate) => candidate.type === "timeZoneName")!.value;
    } catch {
        return time_zone;
    }
}

// The personal menu's "Pause notifications" and the rail's tooltip.
export function own_status_label(now: Date): string | undefined {
    if (until !== null && now.getTime() < until * 1000) {
        return $t({defaultMessage: "Paused until {time}"}, {time: time_phrase(until * 1000, now)});
    }
    if (is_paused(now)) {
        return $t({defaultMessage: "Paused by your notification schedule"});
    }
    return undefined;
}

// "3:00 PM" today, "Tomorrow at 9:00 AM", otherwise the date too.
export function time_phrase(stamp: number, now: Date): string {
    const date = new Date(stamp);
    const time = timerender.get_localized_date_or_time_for_format(date, "time");
    if (date.toDateString() === now.toDateString()) {
        return time;
    }
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    if (date.toDateString() === tomorrow.toDateString()) {
        return $t({defaultMessage: "Tomorrow at {time}"}, {time});
    }
    return timerender.get_localized_date_or_time_for_format(
        date,
        date.getFullYear() === now.getFullYear() ? "dayofyear_time" : "dayofyear_year_time",
    );
}

export type PausePreset = {id: string; text: string; until: number};

// The pause menu's presets: 30 minutes, 1 and 2 hours from the moment
// one is chosen, and until 9:00 tomorrow.
export function pause_presets(now: Date): PausePreset[] {
    const in_minutes = (minutes: number): number => Math.floor(now.getTime() / 1000) + minutes * 60;
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    return [
        {id: "30m", text: $t({defaultMessage: "30 minutes"}), until: in_minutes(30)},
        {id: "1h", text: $t({defaultMessage: "1 hour"}), until: in_minutes(60)},
        {id: "2h", text: $t({defaultMessage: "2 hours"}), until: in_minutes(120)},
        {
            id: "tomorrow",
            text: $t({defaultMessage: "Until tomorrow"}),
            until: Math.floor(tomorrow.getTime() / 1000),
        },
    ];
}

// "Mon" … "Sun" of the settings' day picker, Monday first as in Korea
// (and as the server numbers them).
export function weekday_labels(): {day: number; label: string}[] {
    const labels = [
        $t({defaultMessage: "Mon"}),
        $t({defaultMessage: "Tue"}),
        $t({defaultMessage: "Wed"}),
        $t({defaultMessage: "Thu"}),
        $t({defaultMessage: "Fri"}),
        $t({defaultMessage: "Sat"}),
        $t({defaultMessage: "Sun"}),
    ];
    return labels.map((label, day) => ({day, label}));
}

export function is_valid_time(time: string): boolean {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

function apply_state(data: {
    until: number | null;
    schedule: Schedule;
    mobile: boolean | null;
}): void {
    until = data.until;
    schedule = data.schedule;
    mobile = data.mobile;
}

function when_loaded(change: () => void): void {
    if (loaded) {
        change();
        notify();
    } else if (pending_events !== undefined) {
        pending_events.push(change);
    }
}

export function handle_pause_event(raw_event: unknown): void {
    const event = notification_pause_event_schema.parse(raw_event);
    when_loaded(() => {
        apply_state(event);
    });
}

export function handle_paused_users_event(raw_event: unknown): void {
    const event = paused_users_event_schema.parse(raw_event);
    when_loaded(() => {
        if (event.paused) {
            paused_user_ids.add(event.user_id);
        } else {
            paused_user_ids.delete(event.user_id);
        }
    });
}

export function load(): void {
    pending_events = [];
    void channel.get({
        url: "/json/ykphone/notification_pause",
        success(raw_data) {
            const data = state_response_schema.parse(raw_data);
            apply_state(data);
            paused_user_ids.clear();
            for (const user_id of data.paused_user_ids) {
                paused_user_ids.add(user_id);
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

function patch(data: Record<string, string>, on_error: () => void): void {
    void channel.patch({
        url: "/json/ykphone/notification_pause",
        data,
        success(raw_data) {
            // The event says the same; answering here too keeps the
            // menu right when the event is slow.
            apply_state(patch_response_schema.parse(raw_data));
            notify();
        },
        error: on_error,
    });
}

export function pause_until(seconds: number, on_error: () => void): void {
    patch({until: JSON.stringify(seconds)}, on_error);
}

export function resume(on_error: () => void): void {
    patch({clear_until: JSON.stringify(true)}, on_error);
}

export function set_schedule(new_schedule: Schedule, on_error: () => void): void {
    patch({schedule: JSON.stringify(new_schedule)}, on_error);
}

export function set_mobile_preference(value: boolean, on_error: () => void): void {
    patch({mobile: JSON.stringify(value)}, on_error);
}

// An enabled schedule needs a day; with none it would pause for good.
export function schedule_error(new_schedule: Schedule): string | undefined {
    if (new_schedule.enabled && new_schedule.days.length === 0) {
        return $t({defaultMessage: "Choose at least one day."});
    }
    return undefined;
}

export function clear_for_testing(): void {
    until = null;
    schedule = DEFAULT_SCHEDULE;
    mobile = null;
    paused_user_ids.clear();
    loaded = false;
    pending_events = undefined;
    listeners.length = 0;
}
