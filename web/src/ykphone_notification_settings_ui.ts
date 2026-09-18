// Slack's notification preferences at the top of Settings →
// Notifications, for the 옆커폰 fork (the mapping is in
// ykphone_notification_settings.ts). Upstream's form moves, whole,
// under "Show advanced settings"; the fork's section sits outside it,
// so the form's own save-on-change handler never sees its controls.
// With topics hidden behind threads, upstream's topic notification
// section and the marketing email checkbox are hidden (the theme).

import $ from "jquery";

import render_ykphone_notification_preferences from "../templates/ykphone_notification_preferences.hbs";

import * as alert_words from "./alert_words.ts";
import * as channel from "./channel.ts";
import * as feedback_widget from "./feedback_widget.ts";
import {$t} from "./i18n.ts";
import * as settings_config from "./settings_config.ts";
import {realm} from "./state_data.ts";
import * as ui_util from "./ui_util.ts";
import {user_settings} from "./user_settings.ts";
import * as ykphone_flags from "./ykphone_flags.ts";
import * as ykphone_notification_pause from "./ykphone_notification_pause.ts";
import * as ykphone_notification_pause_ui from "./ykphone_notification_pause_ui.ts";
import * as ykphone_notification_settings from "./ykphone_notification_settings.ts";

function $section(): JQuery {
    return $("#user-notification-settings .ykphone-notification-preferences");
}

function current_flags(): ykphone_notification_settings.NotificationFlags {
    return {
        enable_stream_desktop_notifications: user_settings.enable_stream_desktop_notifications,
        enable_stream_audible_notifications: user_settings.enable_stream_audible_notifications,
        enable_stream_push_notifications: user_settings.enable_stream_push_notifications,
        enable_desktop_notifications: user_settings.enable_desktop_notifications,
        enable_sounds: user_settings.enable_sounds,
        enable_offline_push_notifications: user_settings.enable_offline_push_notifications,
        enable_followed_topic_desktop_notifications:
            user_settings.enable_followed_topic_desktop_notifications,
        enable_followed_topic_audible_notifications:
            user_settings.enable_followed_topic_audible_notifications,
        enable_followed_topic_push_notifications:
            user_settings.enable_followed_topic_push_notifications,
        enable_followed_topic_email_notifications:
            user_settings.enable_followed_topic_email_notifications,
    };
}

function report_error(): void {
    feedback_widget.show({
        title_text: $t({defaultMessage: "Notifications"}),
        populate($container) {
            $container.text($t({defaultMessage: "Could not save your notification settings."}));
        },
    });
}

function save_settings(data: Record<string, string | number | boolean>): void {
    if (Object.keys(data).length === 0) {
        return;
    }
    void channel.patch({
        url: "/json/settings",
        data: Object.fromEntries(
            Object.entries(data).map(([key, value]) => [key, JSON.stringify(value)]),
        ),
        error() {
            report_error();
            // Show the settings as they still are.
            update();
        },
    });
}

function render_context(): Record<string, unknown> {
    const choices = ykphone_notification_settings.simple_choices(
        current_flags(),
        ykphone_notification_pause.get_mobile_preference(),
    );
    const schedule = ykphone_notification_pause.get_schedule();
    return {
        is_nothing: choices.level === "nothing",
        // Until the web app has filled an unset zone (just done on
        // opening), the browser's is the one it will be.
        zone_label: ykphone_notification_pause.zone_label(
            user_settings.timezone || new Intl.DateTimeFormat().resolvedOptions().timeZone,
            user_settings.default_language,
            new Date(),
        ),
        level_options: ykphone_notification_settings.notify_level_options().map((option) => ({
            ...option,
            checked: option.value === choices.level,
        })),
        threads: choices.threads,
        mobile: choices.mobile,
        online_push: user_settings.enable_online_push_notifications,
        push_disabled: !realm.realm_push_notifications_enabled,
        email: user_settings.enable_offline_email_notifications,
        email_delay_options: ykphone_notification_settings.email_delay_options(
            settings_config.email_notifications_batching_period_values,
            user_settings.email_notifications_batching_period_seconds,
        ),
        alert_words: alert_words.get_word_list().map(({word}) => word),
        schedule,
        days: ykphone_notification_pause.weekday_labels().map(({day, label}) => ({
            day,
            label,
            checked: schedule.days.includes(day),
        })),
        sound_options: ykphone_notification_settings.sound_options(
            user_settings.available_notification_sounds,
            user_settings.notification_sound,
        ),
    };
}

function read_choices(): ykphone_notification_settings.SimpleChoices {
    const level = $section().find("input[name='ykphone_notify_level']:checked").val();
    return {
        level:
            typeof level === "string" && ykphone_notification_settings.is_notify_level(level)
                ? level
                : "nothing",
        threads: $section().find(".ykphone_notify_threads").prop("checked") === true,
        mobile: $section().find(".ykphone_notify_mobile").prop("checked") === true,
    };
}

function read_schedule(): ykphone_notification_pause.Schedule | undefined {
    const start = String($section().find("#ykphone-schedule-start").val());
    const end = String($section().find("#ykphone-schedule-end").val());
    if (
        !ykphone_notification_pause.is_valid_time(start) ||
        !ykphone_notification_pause.is_valid_time(end)
    ) {
        return undefined;
    }
    return {
        enabled: $section().find(".ykphone_schedule_enabled").prop("checked") === true,
        days: $section()
            .find(".ykphone-schedule-day-input:checked")
            .toArray()
            .map((input) => Number($(input).val())),
        start,
        end,
    };
}

function play_sound(sound: string): void {
    if (sound === "none") {
        return;
    }
    const audio = new Audio();
    const extension = audio.canPlayType("audio/ogg") === "" ? "mp3" : "ogg";
    audio.src = `/static/audio/notification_sounds/${encodeURIComponent(sound)}.${extension}`;
    void ui_util.play_audio(audio);
}

function bind_handlers(): void {
    const $root = $section();
    $root.on(
        "change",
        "input[name='ykphone_notify_level'], .ykphone_notify_threads, .ykphone_notify_mobile",
        () => {
            const choices = read_choices();
            $root
                .find(".ykphone-notify-nothing-hint")
                .toggleClass("hidden", choices.level !== "nothing");
            save_settings(ykphone_notification_settings.changed_flags(current_flags(), choices));
            // The mobile choice is kept apart, so that Nothing (which
            // turns every push column off) does not lose it.
            if (choices.mobile !== ykphone_notification_pause.get_mobile_preference()) {
                ykphone_notification_pause.set_mobile_preference(choices.mobile, () => {
                    report_error();
                    update();
                });
            }
        },
    );
    $root.on("change", ".ykphone_enable_online_push_notifications", function (this: HTMLElement) {
        save_settings({enable_online_push_notifications: $(this).prop("checked") === true});
    });
    $root.on("change", ".ykphone_enable_offline_email_notifications", function (this: HTMLElement) {
        save_settings({enable_offline_email_notifications: $(this).prop("checked") === true});
    });
    $root.on("change", "#ykphone-email-delay", function (this: HTMLElement) {
        save_settings({email_notifications_batching_period_seconds: Number($(this).val())});
    });
    $root.on("change", "#ykphone-notification-sound", function (this: HTMLElement) {
        const sound = String($(this).val());
        save_settings({notification_sound: sound});
        play_sound(sound);
    });
    $root.on("click", ".ykphone-play-sound", (e) => {
        e.preventDefault();
        play_sound(String($root.find("#ykphone-notification-sound").val()));
    });
    $root.on(
        "change",
        ".ykphone_schedule_enabled, .ykphone-schedule-day-input, .ykphone-schedule-time",
        () => {
            const schedule = read_schedule();
            if (schedule === undefined) {
                return;
            }
            const error = ykphone_notification_pause.schedule_error(schedule);
            $root
                .find(".ykphone-schedule-error")
                .text(error ?? "")
                .toggleClass("hidden", !error);
            if (error !== undefined) {
                return;
            }
            ykphone_notification_pause.set_schedule(schedule, () => {
                report_error();
                update();
            });
            set_schedule_fields_enabled(schedule.enabled);
        },
    );
}

function set_schedule_fields_enabled(enabled: boolean): void {
    const $fields = $section().find(".ykphone-schedule-fields");
    $fields.toggleClass("ykphone-schedule-off", !enabled);
    $fields.find("input").prop("disabled", !enabled);
}

// Brings the section up to date with the settings (an event from this
// or another client, or a request that failed), in place, so that the
// control being used keeps the focus.
export function update(): void {
    const $root = $section();
    if (!ykphone_flags.channels_open_in_general_chat() || $root.length === 0) {
        return;
    }
    const $fresh = $(render_ykphone_notification_preferences(render_context()));
    // Checkboxes, radio buttons and time fields take their new values.
    $root.find("input").each(function (this: HTMLInputElement) {
        const fresh = $fresh
            .find<HTMLInputElement>(
                this.id === ""
                    ? `input[name='${this.name}'][value='${this.value}']`
                    : `#${this.id}`,
            )
            .get(0);
        if (fresh === undefined) {
            return;
        }
        this.checked = fresh.checked;
        this.disabled = fresh.disabled;
        if (this.type === "time" && this !== document.activeElement) {
            this.value = fresh.value;
        }
    });
    // The lists are drawn again.
    $root
        .find(".ykphone-notify-nothing-hint")
        .toggleClass("hidden", $fresh.find(".ykphone-notify-nothing-hint").hasClass("hidden"));
    for (const selector of [
        ".ykphone-schedule-zone",
        ".ykphone-alert-word-list",
        "#ykphone-notification-sound",
        "#ykphone-email-delay",
    ]) {
        // `$(selector, context)` rather than `.find(selector)`, which
        // eslint mistakes for Array.prototype.find with a callback.
        $(selector, $root).html($(selector, $fresh).html());
    }
    $root
        .find("#ykphone-email-delay")
        .prop("disabled", !user_settings.enable_offline_email_notifications);
    set_schedule_fields_enabled(ykphone_notification_pause.get_schedule().enabled);
}

// Settings → Notifications was drawn (settings_sections); runs once per
// drawing of the settings page.
export function set_up(): void {
    if (!ykphone_flags.channels_open_in_general_chat()) {
        return;
    }
    const $container = $("#user-notification-settings");
    if ($container.length === 0 || $section().length > 0) {
        return;
    }
    ykphone_notification_pause_ui.ensure_timezone_setting();
    $container.addClass("ykphone-simple-notifications");
    const $new = $(render_ykphone_notification_preferences(render_context()));
    $new.find(".ykphone-advanced-notifications").append(
        $container.children(".notification-settings-form"),
    );
    $container.prepend($new);
    bind_handlers();
}

export function initialize(): void {
    ykphone_notification_pause.on_change(update);
}
