// DOM side of pinned messages for the 옆커폰 web UI: the pins panel in
// the right column (the thread panel's card, own contents), the rows
// that re-render when a pin comes or goes, and the click handlers for
// the pane header's Pins tab, the message menu items and the panel's
// controls. The state lives in ykphone_pins.ts; this module is exempt
// from node coverage like ykphone_threads_ui.

import $ from "jquery";

import render_ykphone_pins_panel from "../templates/ykphone_pins_panel.hbs";
import render_ykphone_pins_panel_body from "../templates/ykphone_pins_panel_body.hbs";

import {$t} from "./i18n.ts";
import * as message_lists from "./message_lists.ts";
import * as message_store from "./message_store.ts";
import type {Message} from "./message_store.ts";
import * as narrow_state from "./narrow_state.ts";
import {page_params} from "./page_params.ts";
import * as popovers from "./popovers.ts";
import * as rendered_markdown from "./rendered_markdown.ts";
import * as sidebar_ui from "./sidebar_ui.ts";
import * as spectators from "./spectators.ts";
import * as stream_data from "./stream_data.ts";
import * as ykphone_pane_header from "./ykphone_pane_header.ts";
import * as ykphone_conversation from "./ykphone_conversation.ts";
import * as ykphone_pins from "./ykphone_pins.ts";
import * as ykphone_thread_panel from "./ykphone_thread_panel.ts";

function $panel(): JQuery {
    return $("#ykphone-pins-panel");
}

function rerender_rows(message_ids: number[]): void {
    const messages = message_ids
        .map((id) => message_store.get(id))
        .filter((message): message is Message => message !== undefined);
    if (messages.length === 0) {
        return;
    }
    for (const list of message_lists.all_rendered_message_lists()) {
        list.view.rerender_messages(messages);
    }
}

function render_body(stream_id: number): void {
    const pins = ykphone_pins.pins_for_stream(stream_id);
    const $body = $panel().find(".ykphone-pins-panel-body");
    $body.html(
        render_ykphone_pins_panel_body({
            pins: pins.map((pin) => ykphone_pins.pin_row_context(pin)),
            empty_label:
                pins.length === 0
                    ? $t({defaultMessage: "No messages have been pinned in this channel yet."})
                    : undefined,
        }),
    );
    rendered_markdown.update_elements($body.find(".rendered_markdown"));
}

function render_panel(): void {
    const stream_id = ykphone_pins.get_panel_stream_id();
    if (stream_id === undefined) {
        $("body").removeClass("ykphone-pins-open");
        // Drop the content so a later open never flashes the old list.
        $panel().html("");
        return;
    }
    $panel().html(render_ykphone_pins_panel({channel: stream_data.get_sub_by_id(stream_id)}));
    $("body").addClass("ykphone-pins-open");
    render_body(stream_id);
}

function open_panel(stream_id: number): void {
    // The thread panel and the buddy list share the column.
    ykphone_thread_panel.close();
    sidebar_ui.hide_userlist_sidebar();
    ykphone_pins.open_panel(stream_id);
}

export function close_panel(): boolean {
    return ykphone_pins.close_panel();
}

export function handle_narrow_activated(): void {
    const filter = narrow_state.filter();
    ykphone_pins.handle_narrow_activated({
        stream_id: narrow_state.stream_id(),
        topic: narrow_state.topic(),
        is_files_narrow:
            filter !== undefined && ykphone_conversation.is_channel_files_narrow(filter),
    });
}

function add_mount_point(): void {
    $("#right-sidebar-container").append(
        $("<div>")
            .attr("id", "ykphone-pins-panel")
            .addClass("ykphone-side-panel")
            .attr("role", "complementary")
            .attr("aria-label", $t({defaultMessage: "Pinned messages"})),
    );
}

export function initialize(): void {
    add_mount_point();

    ykphone_pins.on_pins_changed((stream_id, message_ids) => {
        rerender_rows(message_ids);
        if (ykphone_pins.get_panel_stream_id() === stream_id) {
            render_body(stream_id);
        }
        // The count in the Pins tab.
        ykphone_pane_header.render();
    });
    ykphone_pins.on_panel_changed(() => {
        render_panel();
        // The active tab.
        ykphone_pane_header.render();
    });

    $("body").on("click", ".ykphone-pane-header-pins-tab", function (this: HTMLElement) {
        if (page_params.is_spectator) {
            spectators.login_to_access();
            return;
        }
        const stream_id = Number($(this).attr("data-stream-id"));
        if (ykphone_pins.get_panel_stream_id() === stream_id) {
            ykphone_pins.close_panel();
        } else {
            open_panel(stream_id);
        }
    });

    $("body").on("click", ".ykphone-pins-panel-close", () => {
        ykphone_pins.close_panel();
    });

    // The menu items are rendered inside upstream's message actions
    // popover, which is closed like its own items close it.
    $("body").on("click", ".ykphone-pin-message", function (this: HTMLElement, e) {
        e.preventDefault();
        const message_id = Number($(this).attr("data-message-id"));
        popovers.hide_all();
        ykphone_pins.pin(message_id);
    });
    $("body").on("click", ".ykphone-unpin-message", function (this: HTMLElement, e) {
        e.preventDefault();
        const message_id = Number($(this).attr("data-message-id"));
        popovers.hide_all();
        ykphone_pins.unpin(message_id);
    });

    $("body").on("click", ".ykphone-pins-panel-unpin", function (this: HTMLElement) {
        const message_id = Number(
            $(this).closest(".ykphone-pins-panel-item").attr("data-message-id"),
        );
        ykphone_pins.unpin(message_id);
    });
}
