// Slack's compact clock for the 옆커폰 fork.
//
// The time in the avatar gutter of a grouped message line — in the feed
// and in the thread panel — reads "10:12" in Slack: the hour and the
// minute alone, without the meridiem that upstream's "time" format adds
// for users on a 12-hour clock ("오전 10:12") and without a leading zero
// on the hour. The user's 12/24-hour preference still decides which hour
// is shown, and every other timestamp in the app keeps upstream's
// format, so this module only serves the gutter.

import * as timerender from "./timerender.ts";
import {user_settings} from "./user_settings.ts";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(): Intl.DateTimeFormat {
    const key = [
        user_settings.default_language,
        user_settings.twenty_four_hour_time,
        timerender.display_time_zone,
    ].join(":");
    let cached = formatters.get(key);
    if (cached === undefined) {
        cached = new Intl.DateTimeFormat(user_settings.default_language, {
            timeZone: timerender.display_time_zone,
            // A 24-hour clock keeps upstream's padded hour, so the
            // gutter and the sender line above it agree; only the
            // meridiem of the 12-hour clock is dropped.
            ...(user_settings.twenty_four_hour_time
                ? {hourCycle: "h23" as const, hour: "2-digit" as const}
                : {hourCycle: "h12" as const, hour: "numeric" as const}),
            minute: "2-digit",
        });
        formatters.set(key, cached);
    }
    return cached;
}

export function hour_and_minute(date: Date | number): string {
    // Locales that show a meridiem put it in a part of its own, either
    // before the hour (Korean's "오전") or after the minute (English's
    // "AM"), so taking the hour and the minute alone drops it without
    // touching the digits or assuming where it sits.
    let hour = "";
    let minute = "";
    for (const part of formatter().formatToParts(date)) {
        if (part.type === "hour") {
            hour = part.value;
        } else if (part.type === "minute") {
            minute = part.value;
        }
    }
    return `${hour}:${minute}`;
}

export function clear_for_testing(): void {
    formatters.clear();
}
