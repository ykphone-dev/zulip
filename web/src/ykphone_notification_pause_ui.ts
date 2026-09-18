// Pausing notifications for the 옆커폰 fork: the menus and the marks
// (see ykphone_notification_pause.ts for the data and the rule).
//
// * The personal menu's "Pause notifications" opens the pause menu
//   (Slack's presets, a custom time, resuming, and a link to the
//   notification schedule in the settings) next to the rail avatar.
// * The rail avatar carries a "z" while the user is paused.
// * Direct message rows and user cards of paused users say so
//   (pm_list_data, ykphone_split_view and user_card_popover read
//   is_user_paused); they are drawn again when the state changes.
// * The web app's own sounds and desktop notifications are held back
//   while paused (message_notifications asks ykphone_notification_pause).

import $ from "jquery";
import type * as tippy from "tippy.js";

import render_ykphone_pause_menu from "../templates/ykphone_pause_menu.hbs";

import * as channel from "./channel.ts";
import * as feedback_widget from "./feedback_widget.ts";
import * as flatpickr from "./flatpickr.ts";
import {$t} from "./i18n.ts";
import {page_params} from "./page_params.ts";
import * as people from "./people.ts";
import * as pm_list from "./pm_list.ts";
import * as popover_menus from "./popover_menus.ts";
import * as popovers from "./popovers.ts";
import * as ui_util from "./ui_util.ts";
import {user_settings} from "./user_settings.ts";
import * as util from "./util.ts";
import * as ykphone_flags from "./ykphone_flags.ts";
import * as ykphone_notification_pause from "./ykphone_notification_pause.ts";
import * as ykphone_status_expiry from "./ykphone_status_expiry.ts";

// The user's own paused state as last drawn; the minute timer redraws
// when the clock moves it (a pause running out, the schedule's hours).
let drawn_own_paused = false;

function report_error(): void {
    feedback_widget.show({
        title_text: $t({defaultMessage: "Pause notifications"}),
        populate($container) {
            $container.text($t({defaultMessage: "Could not change your notification pause."}));
        },
    });
}

function update_rail_badge(): void {
    const paused = ykphone_notification_pause.is_paused(new Date());
    drawn_own_paused = paused;
    const $avatar = $("#ykphone-rail-avatar");
    $avatar.toggleClass("ykphone-notifications-paused", paused);
    $avatar.find(".ykphone-rail-pause-badge").prop("hidden", !paused);
    $avatar.attr(
        "aria-label",
        paused
            ? $t({defaultMessage: "Personal menu, notifications paused"})
            : $t({defaultMessage: "Personal menu"}),
    );
}

function redraw(): void {
    update_rail_badge();
    pm_list.update_private_messages();
}

// The personal menu is drawn once per opening; the pause item's second
// line and the status's "until" are filled in here (onMount).
export function on_personal_menu_mount(instance: tippy.Instance): void {
    const $popper = $(instance.popper);
    const now = new Date();
    $popper
        .find(".ykphone-pause-menu-state")
        .text(ykphone_notification_pause.own_status_label(now) ?? "");
    const until = ykphone_status_expiry.until_label(people.my_current_user_id(), now);
    if (until !== undefined) {
        $popper
            .find(".personal-menu-status-wrapper")
            .append($("<span>").addClass("ykphone-status-until").text(until));
    }
    $popper.one("click", ".ykphone-open-pause-menu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        popovers.hide_all();
        open_pause_menu();
    });
}

function pause_menu_anchor(): HTMLElement | undefined {
    return $("#ykphone-rail-avatar .ykphone-rail-avatar-image").get(0);
}

// The schedule runs in the user's Zulip time zone, which users not
// created by the signup form (API, import, LDAP…) have unset; the
// server then leaves the schedule off. Like the signup form, the web
// app fills it from the browser the first time the pause menu or the
// notification settings are used.
export function ensure_timezone_setting(): void {
    if (user_settings.timezone !== "") {
        return;
    }
    const browser_zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    void channel.patch({url: "/json/settings", data: {timezone: browser_zone}});
}

export function open_pause_menu(): void {
    const anchor = pause_menu_anchor();
    if (anchor === undefined) {
        return;
    }
    ensure_timezone_setting();
    const now = new Date();
    const presets = ykphone_notification_pause.pause_presets(now);
    const paused_until = ykphone_notification_pause.get_until();
    popover_menus.toggle_popover_menu(
        anchor,
        {
            theme: "popover-menu",
            placement: "right-end",
            onCreate(instance) {
                instance.setContent(
                    ui_util.parse_html(
                        render_ykphone_pause_menu({
                            state_label: ykphone_notification_pause.own_status_label(now),
                            presets: presets.map((preset) => ({
                                ...preset,
                                hint:
                                    preset.id === "tomorrow"
                                        ? ykphone_notification_pause.time_phrase(
                                              preset.until * 1000,
                                              now,
                                          )
                                        : undefined,
                            })),
                            can_resume:
                                paused_until !== null && paused_until * 1000 > now.getTime(),
                            // The schedule lives in the fork's settings section.
                            has_schedule_settings: ykphone_flags.channels_open_in_general_chat(),
                        }),
                    ),
                );
            },
            onMount(instance) {
                popover_menus.focus_popover(instance);
                const $popper = $(instance.popper);
                $popper.on("click", ".ykphone-pause-preset", function (this: HTMLElement, e) {
                    e.preventDefault();
                    e.stopPropagation();
                    popover_menus.hide_current_popover_if_visible(instance);
                    // A relative preset counts from the moment it is chosen.
                    const preset = ykphone_notification_pause
                        .pause_presets(new Date())
                        .find((candidate) => candidate.id === this.dataset["ykphonePreset"]);
                    if (preset !== undefined) {
                        ykphone_notification_pause.pause_until(preset.until, report_error);
                    }
                });
                $popper.on("click", ".ykphone-pause-resume", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    popover_menus.hide_current_popover_if_visible(instance);
                    ykphone_notification_pause.resume(report_error);
                });
                $popper.on("click", ".ykphone-pause-schedule", () => {
                    popover_menus.hide_current_popover_if_visible(instance);
                });
                $popper.on("click", ".ykphone-pause-custom", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    flatpickr.show_flatpickr(
                        util.the($popper.find(".ykphone-pause-custom")),
                        (time) => {
                            popover_menus.hide_current_popover_if_visible(instance);
                            ykphone_notification_pause.pause_until(
                                Math.floor(new Date(time).getTime() / 1000),
                                report_error,
                            );
                        },
                        paused_until === null
                            ? new Date(Date.now() + 60 * 60 * 1000)
                            : new Date(paused_until * 1000),
                        {minDate: "today"},
                    );
                });
            },
            onShow(instance) {
                popover_menus.on_show_prep(instance);
            },
            onHidden(instance) {
                instance.destroy();
            },
        },
        {get_focus_return_element: () => util.the($("#ykphone-rail-avatar"))},
    );
}

export function initialize(): void {
    if (page_params.is_spectator) {
        return;
    }
    ykphone_notification_pause.on_change(redraw);
    ykphone_status_expiry.on_change(redraw);
    ykphone_notification_pause.load();
    ykphone_status_expiry.load();
    update_rail_badge();
    // The clock moves the user's own state (a pause running out, the
    // schedule's hours starting or ending); other users' flips come as
    // events, and an "until" label past its time is dropped when drawn.
    setInterval(() => {
        if (ykphone_notification_pause.is_paused(new Date()) !== drawn_own_paused) {
            ykphone_notification_pause.notify();
        }
    }, 30 * 1000);
}
