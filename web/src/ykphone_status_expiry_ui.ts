// The status modal's "Clear after" for the 옆커폰 fork (see
// ykphone_status_expiry.ts). Upstream's user_status_ui calls in when
// the modal is drawn, when it decides whether Save is enabled, and
// once the status is saved (or left as it was).

import $ from "jquery";

import * as feedback_widget from "./feedback_widget.ts";
import * as flatpickr from "./flatpickr.ts";
import {$t} from "./i18n.ts";
import * as people from "./people.ts";
import * as util from "./util.ts";
import * as ykphone_notification_pause from "./ykphone_notification_pause.ts";
import type {ClearAfter} from "./ykphone_status_expiry.ts";
import * as ykphone_status_expiry from "./ykphone_status_expiry.ts";

// The choice when the modal opened, and the custom time picked (or the
// status's own time, which opens as "custom").
let initial_choice: ClearAfter = "never";
let custom_clear_at: number | undefined;

function $select(): JQuery<HTMLSelectElement> {
    return $<HTMLSelectElement>("#ykphone-status-clear-after");
}

function current_choice(): ClearAfter {
    const value = $select().val();
    return typeof value === "string" && ykphone_status_expiry.is_clear_after(value)
        ? value
        : "never";
}

function show_custom_time(clear_at: number): void {
    custom_clear_at = clear_at;
    $select()
        .find("option[value='custom']")
        .text(ykphone_notification_pause.time_phrase(clear_at * 1000, new Date()));
}

export function clear_after_changed(): boolean {
    return (
        $select().length > 0 &&
        (current_choice() !== initial_choice ||
            (initial_choice === "custom" &&
                custom_clear_at !==
                    ykphone_status_expiry.get_clear_at(people.my_current_user_id())))
    );
}

// Called from upstream's post_render with its update_button, which the
// choice now also enables.
export function status_modal_post_render(update_button: () => void): void {
    const own_clear_at = ykphone_status_expiry.get_clear_at(people.my_current_user_id());
    custom_clear_at = undefined;
    initial_choice = "never";
    if (own_clear_at !== undefined && own_clear_at * 1000 > Date.now()) {
        initial_choice = "custom";
        show_custom_time(own_clear_at);
    }
    $select().val(initial_choice);
    let previous_choice: ClearAfter = initial_choice;

    $select().on("change", () => {
        if (current_choice() !== "custom") {
            previous_choice = current_choice();
            update_button();
            return;
        }
        flatpickr.show_flatpickr(
            util.the($select()),
            (time) => {
                show_custom_time(Math.floor(new Date(time).getTime() / 1000));
                $select().val("custom");
                previous_choice = "custom";
                update_button();
            },
            custom_clear_at === undefined
                ? new Date(Date.now() + 60 * 60 * 1000)
                : new Date(custom_clear_at * 1000),
            {
                minDate: "today",
                onClose() {
                    // Closed without a time: back to the choice before
                    // (after the confirm button's own handler, if any).
                    setTimeout(() => {
                        if (custom_clear_at === undefined) {
                            $select().val(previous_choice);
                            update_button();
                        }
                    }, 0);
                },
            },
        );
    });

    // A preset status brings its usual time (upstream's own handler
    // fills in the text and the emoji).
    $("#set-user-status-modal .user-status-value").on("click", (event) => {
        const choice = ykphone_status_expiry.default_clear_after(
            $(event.currentTarget).text().trim(),
        );
        if (choice !== undefined) {
            $select().val(choice);
            previous_choice = choice;
            update_button();
        }
    });
}

function report_error(): void {
    feedback_widget.show({
        title_text: $t({defaultMessage: "Clear after"}),
        populate($container) {
            $container.text($t({defaultMessage: "Could not save when to clear your status."}));
        },
    });
}

// Called once the status is saved, or when Save left it as it was.
// Saving a new status dropped the old time on the server already.
export function save_clear_after(status_text: string, emoji_name: string | undefined): void {
    if ($select().length === 0) {
        return;
    }
    const choice = current_choice();
    const had_clear_at =
        ykphone_status_expiry.get_clear_at(people.my_current_user_id()) !== undefined;
    if (status_text === "" && !emoji_name) {
        return;
    }
    if (choice === "never") {
        if (had_clear_at) {
            ykphone_status_expiry.save(null, report_error);
        }
        return;
    }
    const clear_at =
        choice === "custom"
            ? custom_clear_at
            : ykphone_status_expiry.clear_at_for(choice, new Date());
    if (clear_at !== undefined) {
        ykphone_status_expiry.save(clear_at, report_error);
    }
}
