// Slack-style two-row compose controls for the 옆커폰 fork.
//
// Upstream lays out every compose control in one scrollable bar under
// the textarea. Slack puts text formatting in a row above the textarea
// and the insert tools (attach, emoji, mention, …) with the send button
// below it. On mount the two formatting groups are moved into a row of
// their own above the textarea; the row can be hidden with an "Aa"
// toggle whose state is kept in localStorage. Only the main compose
// box is changed; the message-edit form keeps upstream's layout.
//
// The DOM event wiring lives in ykphone_threads_ui.ts.

import $ from "jquery";

import render_ykphone_compose_controls from "../templates/ykphone_compose_controls.hbs";

import * as compose_ui from "./compose_ui.ts";
import {localstorage} from "./localstorage.ts";

const FORMATTING_HIDDEN_KEY = "ykphone-compose-formatting-hidden";

export function is_formatting_row_hidden(): boolean {
    return localstorage().get(FORMATTING_HIDDEN_KEY) === true;
}

function apply_formatting_row_state(): void {
    const hidden = is_formatting_row_hidden();
    $("#compose").toggleClass("ykphone-compose-formatting-hidden", hidden);
    $("#compose .ykphone-compose-formatting-toggle")
        .toggleClass("active", !hidden)
        .attr("aria-pressed", hidden ? "false" : "true");
}

export function toggle_formatting_row(): void {
    localstorage().set(FORMATTING_HIDDEN_KEY, !is_formatting_row_hidden());
    apply_formatting_row_state();
}

// Inserting the sigil at the cursor opens the mention typeahead, like
// typing it.
export function insert_mention(): void {
    compose_ui.insert_syntax_and_focus("@");
}

export function mount(): void {
    const $bar = $("#compose .compose-scrollable-buttons");
    // The formatting buttons are the bar's two nested groups; the
    // insert tools are direct children of the bar.
    const $formatting_row = $(
        '<div id="ykphone-compose-formatting-row" class="ykphone-compose-formatting-row"></div>',
    );
    $formatting_row.append($bar.children(".compose-control-buttons-container"));
    $("#compose .messagebox").prepend($formatting_row);
    $bar.prepend($(render_ykphone_compose_controls()));
    // Slack's attach button is a plus sign and its send-options
    // control a chevron; the icon font has both.
    $("#compose .compose_upload_file")
        .removeClass("zulip-icon-attachment")
        .addClass("zulip-icon-plus");
    $("#send_later .zulip-icon")
        .removeClass("zulip-icon-more-vertical")
        .addClass("zulip-icon-chevron-down");
    apply_formatting_row_state();
}
