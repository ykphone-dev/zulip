// Slack-style compose controls for the 옆커폰 fork.
//
// Upstream lays out every compose control in one scrollable bar under
// the textarea. Slack puts text formatting in a row above the textarea
// and the insert tools (attach, emoji, mention, …) with the send button
// below it, with the rarely used tools behind a "⋯" button. On mount
// the two formatting groups are moved into a row of their own above
// the textarea; the row can be hidden with an "Aa" toggle whose state
// is kept in localStorage, and the extra tools are shown by the "⋯"
// toggle (state in memory). Only the main compose box is changed; the
// message-edit form keeps upstream's layout.
//
// The box also knows when it is addressed to the conversation on
// screen: then the recipient row is redundant (Slack never shows one)
// and Escape only blurs the box. Opening the box for a conversation is
// ykphone_compose_narrow's job; this module must not import
// compose_actions, since compose_recipient calls back into it.
//
// The DOM event wiring lives in ykphone_threads_ui.ts.

import $ from "jquery";
import _ from "lodash";

import render_ykphone_compose_controls from "../templates/ykphone_compose_controls.hbs";

import * as compose_state from "./compose_state.ts";
import * as compose_ui from "./compose_ui.ts";
import {localstorage} from "./localstorage.ts";
import * as narrow_state from "./narrow_state.ts";
import * as util from "./util.ts";

const FORMATTING_HIDDEN_KEY = "ykphone-compose-formatting-hidden";

let extras_open = false;

export type ChannelNarrowTarget = {
    stream_id: number;
    topic: string;
};

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

export function are_extras_open(): boolean {
    return extras_open;
}

function apply_extras_state(): void {
    $("#compose").toggleClass("ykphone-compose-extras-open", extras_open);
    $("#compose .ykphone-compose-more")
        .toggleClass("active", extras_open)
        .attr("aria-expanded", extras_open ? "true" : "false");
}

export function toggle_extras(): void {
    extras_open = !extras_open;
    apply_extras_state();
}

// Inserting the sigil at the cursor opens the mention typeahead, like
// typing it.
export function insert_mention(): void {
    compose_ui.insert_syntax_and_focus("@");
}

// The channel conversation on screen that a composer can be addressed
// to: a channel narrow (its general chat) or a channel and topic
// narrow, including its near/with forms (permalinks, "Go to message").
// Direct message conversations are not channel targets.
export function channel_narrow_target(): ChannelNarrowTarget | undefined {
    const filter = narrow_state.filter();
    if (
        filter === undefined ||
        !(filter.is_conversation_view() || narrow_state.narrowed_by_stream_reply(filter))
    ) {
        return undefined;
    }
    const stream_id = narrow_state.stream_id(filter, true);
    if (stream_id === undefined) {
        return undefined;
    }
    return {stream_id, topic: narrow_state.topic(filter) ?? ""};
}

// Whether the open composer is addressed to the conversation on
// screen; then the recipient row says nothing the pane header does not.
export function composer_belongs_to_narrow(): boolean {
    if (!compose_state.composing()) {
        return false;
    }
    const message_type = compose_state.get_message_type();
    if (message_type === "stream") {
        const target = channel_narrow_target();
        return (
            target !== undefined &&
            compose_state.stream_id() === target.stream_id &&
            util.lower_same(compose_state.topic(), target.topic)
        );
    }
    if (message_type === "private") {
        const narrow_user_ids = narrow_state.pm_ids_set();
        return (
            narrow_user_ids.size > 0 &&
            _.isEqual(narrow_user_ids, new Set(compose_state.private_message_recipient_ids()))
        );
    }
    return false;
}

// Called by compose_recipient whenever the recipient may have changed,
// and from the narrow-activated hook.
export function update_recipient_row(): void {
    $("#compose").toggleClass("ykphone-compose-recipient-implied", composer_belongs_to_narrow());
}

// Escape, or a click outside the box, would close it upstream. A box
// addressed to the conversation on screen stays open with its text and
// only gives up keyboard focus, so the feed's hotkeys work again.
// Returns whether the dismissal was handled here.
export function handle_dismiss(): boolean {
    if (!composer_belongs_to_narrow()) {
        return false;
    }
    $("#compose").find(":focus").trigger("blur");
    return true;
}

export function mount(): void {
    const $bar = $("#compose .compose-scrollable-buttons");
    // The formatting buttons are the bar's two nested groups; the
    // insert tools are direct children of the bar.
    const $formatting_row = $("<div>")
        .attr("id", "ykphone-compose-formatting-row")
        .addClass("ykphone-compose-formatting-row");
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
    apply_extras_state();
}

export function clear_for_testing(): void {
    extras_open = false;
}
