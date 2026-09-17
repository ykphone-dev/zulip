// Slack's presets for scheduling a message and for a message reminder,
// in place of upstream's times of day. They are rendered by upstream's
// schedule_message_popover.hbs (compose_send_menu_popover).
//
// "In 20 minutes / 1 hour / 3 hours" count from the moment one is
// chosen, so a menu left open does not schedule from when it opened.
// Tomorrow and Monday are the times the menu shows, as upstream's
// presets are (the stamp rendered into the item); the menu is drawn
// again once the day changes under it (ykphone_schedule_presets_ui).

import {$t} from "./i18n.ts";
import {realm} from "./state_data.ts";
import * as timerender from "./timerender.ts";

type Preset = {text: string; stamp: number};
type PresetGroup = Record<string, Preset>;

// The template's three groups, each followed by a separator; the ids
// of the presets become the menu items' ids.
export type SchedulePopoverContext = {
    possible_send_later_today: PresetGroup | false;
    send_later_tomorrow: PresetGroup;
    possible_send_later_monday: PresetGroup | false;
    max_reminder_note_length: number;
};

const RELATIVE_DELAY_MINUTES: Record<string, number> = {
    in_twenty_minutes: 20,
    in_one_hour: 60,
    in_three_hours: 3 * 60,
};

// The calendar day the menu on screen was drawn for.
let rendered_day: string | undefined;

function day_key(date: Date): string {
    return date.toDateString();
}

function tomorrow_nine_am(now: Date): number {
    const date = new Date(now);
    date.setDate(now.getDate() + 1);
    return date.setHours(9, 0, 0, 0);
}

// The next Monday after today: a week ahead on a Monday, tomorrow on a
// Sunday.
function next_monday_nine_am(now: Date): number {
    const date = new Date(now);
    const days_ahead = (8 - now.getDay()) % 7 || 7;
    date.setDate(now.getDate() + days_ahead);
    return date.setHours(9, 0, 0, 0);
}

function relative_stamp(id: string, now: Date): number {
    return now.getTime() + RELATIVE_DELAY_MINUTES[id]! * 60 * 1000;
}

// The time, in whole seconds as the server takes it, of a relative
// preset ("in 20 minutes") counted from the moment it is chosen;
// undefined for every other menu item, which keeps its rendered stamp.
export function relative_send_at_seconds(id: string, now: Date): number | undefined {
    if (RELATIVE_DELAY_MINUTES[id] === undefined) {
        return undefined;
    }
    return Math.floor(relative_stamp(id, now) / 1000);
}

function time_label(stamp: number): string {
    return timerender.get_localized_date_or_time_for_format(stamp, "time");
}

function monday_label(now: Date, stamp: number): string {
    const values = {
        date: timerender.get_localized_date_or_time_for_format(stamp, "dayofyear"),
        time: time_label(stamp),
    };
    // On a Monday, "Monday" would read as today.
    if (now.getDay() === 1) {
        return $t({defaultMessage: "Next Monday ({date}) at {time}"}, values);
    }
    return $t({defaultMessage: "Monday ({date}) at {time}"}, values);
}

export function popover_context(now: Date, is_reminder: boolean): SchedulePopoverContext {
    rendered_day = day_key(now);
    const tomorrow = tomorrow_nine_am(now);
    const monday = next_monday_nine_am(now);
    const relative: PresetGroup = {
        in_twenty_minutes: {
            text: $t(
                {defaultMessage: "In {minutes, plural, one {# minute} other {# minutes}}"},
                {minutes: 20},
            ),
            stamp: relative_stamp("in_twenty_minutes", now),
        },
        in_one_hour: {
            text: $t(
                {defaultMessage: "In {hours, plural, one {# hour} other {# hours}}"},
                {hours: 1},
            ),
            stamp: relative_stamp("in_one_hour", now),
        },
        in_three_hours: {
            text: $t(
                {defaultMessage: "In {hours, plural, one {# hour} other {# hours}}"},
                {hours: 3},
            ),
            stamp: relative_stamp("in_three_hours", now),
        },
    };
    return {
        // Reminders start with Slack's "in 20 minutes / 1 hour / 3 hours";
        // a message is scheduled for a working morning only.
        possible_send_later_today: is_reminder ? relative : false,
        send_later_tomorrow: {
            tomorrow_nine_am: {
                text: $t({defaultMessage: "Tomorrow at {time}"}, {time: time_label(tomorrow)}),
                stamp: tomorrow,
            },
        },
        // Offered every day but Sunday, where the next Monday is
        // tomorrow.
        possible_send_later_monday:
            monday === tomorrow
                ? false
                : {monday_nine_am: {text: monday_label(now, monday), stamp: monday}},
        max_reminder_note_length: realm.max_reminder_note_length,
    };
}

// Whether the menu on screen was drawn on another day than `now`, so
// that its "tomorrow" and "Monday" are out of date.
export function day_changed_since_render(now: Date): boolean {
    return rendered_day !== day_key(now);
}
