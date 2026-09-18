// Slack's simple notification preferences for the 옆커폰 fork, mapped
// onto Zulip's own notification settings (the matrix of triggers ×
// desktop/audible/mobile/email that stays reachable under "Show
// advanced settings").
//
// * "Notify me about" sets the desktop (visual and audible) columns of
//   two rows of the matrix: channel messages, and direct messages,
//   mentions and alert words. All new messages turns both on, direct
//   messages, mentions and keywords only the second, Nothing neither.
// * "Replies in threads I follow" sets the followed topics row, since
//   a thread is a topic (the fork follows threads only; see
//   ykphone.lib.thread_follow), and its email column unless the choice
//   is Nothing.
// * "Send notifications to my mobile devices" gives those same rows
//   their mobile column; off, no mobile notification is sent. The
//   choice itself is kept by the fork, so Nothing does not lose it.
// * Channels with notification settings of their own keep them.
// * Email, sound and alert words are Zulip's settings as they are.
//
// Reading the settings back, the desktop columns decide the choice, and
// any mobile column being on means mobile is on, so settings changed
// in the matrix show up as the closest simple choice.

import {$t} from "./i18n.ts";

export type NotifyLevel = "all" | "mentions" | "nothing";

// The settings of the matrix that the simple choices stand for.
export const NOTIFICATION_FLAG_NAMES = [
    "enable_stream_desktop_notifications",
    "enable_stream_audible_notifications",
    "enable_stream_push_notifications",
    "enable_desktop_notifications",
    "enable_sounds",
    "enable_offline_push_notifications",
    "enable_followed_topic_desktop_notifications",
    "enable_followed_topic_audible_notifications",
    "enable_followed_topic_push_notifications",
    "enable_followed_topic_email_notifications",
] as const;
export type NotificationFlags = Record<(typeof NOTIFICATION_FLAG_NAMES)[number], boolean>;

export type SimpleChoices = {level: NotifyLevel; threads: boolean; mobile: boolean};

export function is_notify_level(value: string): value is NotifyLevel {
    return value === "all" || value === "mentions" || value === "nothing";
}

export function notify_level_options(): {value: NotifyLevel; text: string}[] {
    return [
        {value: "all", text: $t({defaultMessage: "All new messages"})},
        {
            value: "mentions",
            text: $t({defaultMessage: "Direct messages, mentions and keywords"}),
        },
        {value: "nothing", text: $t({defaultMessage: "Nothing"})},
    ];
}

// `stored_mobile` is the mobile choice as last made on the settings page
// (kept by the fork, since the push columns cannot hold it under
// "Nothing"); before one was made, the push columns tell.
export function simple_choices(
    flags: NotificationFlags,
    stored_mobile: boolean | null,
): SimpleChoices {
    let level: NotifyLevel = "nothing";
    if (flags.enable_stream_desktop_notifications) {
        level = "all";
    } else if (flags.enable_desktop_notifications) {
        level = "mentions";
    }
    return {
        level,
        threads: flags.enable_followed_topic_desktop_notifications,
        mobile:
            stored_mobile ??
            (flags.enable_stream_push_notifications ||
                flags.enable_offline_push_notifications ||
                flags.enable_followed_topic_push_notifications),
    };
}

// The settings that the choices stand for.
export function flags_for(choices: SimpleChoices): NotificationFlags {
    const channels = choices.level === "all";
    const mentions = choices.level !== "nothing";
    return {
        enable_stream_desktop_notifications: channels,
        enable_stream_audible_notifications: channels,
        enable_stream_push_notifications: choices.mobile && channels,
        enable_desktop_notifications: mentions,
        enable_sounds: mentions,
        enable_offline_push_notifications: choices.mobile && mentions,
        enable_followed_topic_desktop_notifications: choices.threads,
        enable_followed_topic_audible_notifications: choices.threads,
        enable_followed_topic_push_notifications: choices.mobile && choices.threads,
        // Thread replies by email too, except under "Nothing".
        enable_followed_topic_email_notifications: choices.threads && mentions,
    };
}

// Only the settings whose value would change, for the request.
export function changed_flags(
    current: NotificationFlags,
    choices: SimpleChoices,
): Partial<NotificationFlags> {
    const wanted = flags_for(choices);
    const changes: Partial<NotificationFlags> = {};
    for (const key of NOTIFICATION_FLAG_NAMES) {
        if (wanted[key] !== current[key]) {
            changes[key] = wanted[key];
        }
    }
    return changes;
}

// Korean-friendly names for Zulip's notification sounds; a sound this
// list does not know keeps its file name.
export function sound_label(sound: string): string {
    const labels: Record<string, string> = {
        none: $t({defaultMessage: "None"}),
        zulip: $t({defaultMessage: "Default sound"}),
        ascend: $t({defaultMessage: "Ascend"}),
        beep_boop: $t({defaultMessage: "Beep boop"}),
        bink: $t({defaultMessage: "Bink"}),
        bright: $t({defaultMessage: "Bright"}),
        brlip: $t({defaultMessage: "Brlip"}),
        chime: $t({defaultMessage: "Chime"}),
        "deep tom": $t({defaultMessage: "Deep tom"}),
        ding: $t({defaultMessage: "Ding"}),
        "double tap": $t({defaultMessage: "Double tap"}),
        down: $t({defaultMessage: "Down"}),
        "dry bongos": $t({defaultMessage: "Dry bongos"}),
        dutdut: $t({defaultMessage: "Dut dut"}),
        "fast ascend": $t({defaultMessage: "Fast ascend"}),
        flute: $t({defaultMessage: "Flute"}),
        friendly: $t({defaultMessage: "Friendly"}),
        "kick roll": $t({defaultMessage: "Kick roll"}),
        "loud tintong": $t({defaultMessage: "Loud ding-dong"}),
        "metallic snare": $t({defaultMessage: "Metallic snare"}),
        pan: $t({defaultMessage: "Pan"}),
        shaker: $t({defaultMessage: "Shaker"}),
        simple: $t({defaultMessage: "Simple"}),
        stairs: $t({defaultMessage: "Stairs"}),
        subtle: $t({defaultMessage: "Subtle"}),
        swish: $t({defaultMessage: "Swish"}),
        tintong: $t({defaultMessage: "Ding-dong"}),
        up: $t({defaultMessage: "Up"}),
        "wood block": $t({defaultMessage: "Wood block"}),
        zaping: $t({defaultMessage: "Zap"}),
        zing: $t({defaultMessage: "Zing"}),
    };
    return Object.hasOwn(labels, sound) ? labels[sound]! : sound;
}

export function sound_options(
    available: string[],
    selected: string,
): {value: string; text: string; selected: boolean}[] {
    return ["none", ...available].map((value) => ({
        value,
        text: sound_label(value),
        selected: value === selected,
    }));
}

// The email delay choices: Zulip's list without its "Custom" (whose
// minutes field is in the advanced settings), plus the current value
// when it is such a custom one.
export function email_delay_options(
    values: {value: number | string; description: string}[],
    current: number,
): {value: number; text: string; selected: boolean}[] {
    const options = values.flatMap(({value, description}) =>
        typeof value === "number" ? [{value, text: description, selected: value === current}] : [],
    );
    if (!options.some(({selected}) => selected)) {
        options.push({
            value: current,
            text: $t(
                {defaultMessage: "{minutes, plural, one {# minute} other {# minutes}}"},
                {minutes: Math.round(current / 60)},
            ),
            selected: true,
        });
    }
    return options;
}
