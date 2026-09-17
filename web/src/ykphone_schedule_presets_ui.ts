// DOM side of ykphone_schedule_presets: draws the open scheduling menu
// again when the day changes under it, as upstream's midnight refresh
// did, keeping the reminder note the user may be typing. Exempt from
// node coverage like the other ykphone_*_ui glue.

import $ from "jquery";

import render_schedule_message_popover from "../templates/popovers/schedule_message_popover.hbs";

import * as ykphone_schedule_presets from "./ykphone_schedule_presets.ts";

// Called every minute while the menu is open.
export function refresh_open_menu(now: Date): void {
    const $menu = $("#send-later-options");
    if ($menu.length === 0 || !ykphone_schedule_presets.day_changed_since_render(now)) {
        return;
    }
    const is_reminder = $menu.hasClass("message-reminder-popover");
    const $new_menu = $(
        render_schedule_message_popover({
            ...ykphone_schedule_presets.popover_context(now, is_reminder),
            is_reminder,
        }),
    );
    // The typed note, its focus and its autosize binding move over.
    $new_menu
        .find("textarea.schedule-reminder-note")
        .replaceWith($menu.find("textarea.schedule-reminder-note"));
    $menu.replaceWith($new_menu);
}
