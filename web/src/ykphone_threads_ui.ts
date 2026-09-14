import $ from "jquery";
import assert from "minimalistic-assert";

import {$t} from "./i18n.ts";
import * as keydown_util from "./keydown_util.ts";
import * as lightbox from "./lightbox.ts";
import * as message_store from "./message_store.ts";
import * as message_view from "./message_view.ts";
import * as rows from "./rows.ts";
import * as sidebar_ui from "./sidebar_ui.ts";
import * as ykphone_flags from "./ykphone_flags.ts";
import * as ykphone_thread_panel from "./ykphone_thread_panel.ts";
import * as ykphone_threads from "./ykphone_threads.ts";
import type {ThreadInfo} from "./ykphone_threads.ts";

export function open_in_full_view(thread: ThreadInfo): void {
    ykphone_thread_panel.close();
    message_view.show(
        [
            {operator: "channel", operand: thread.stream_id.toString()},
            {operator: "topic", operand: thread.topic_name},
        ],
        {trigger: "ykphone thread", change_hash: true},
    );
}

function open_thread(thread: ThreadInfo): void {
    // A buddy list opened as an overlay on narrow screens would sit
    // on top of the panel; the panel takes the column over instead.
    sidebar_ui.hide_userlist_sidebar();
    ykphone_thread_panel.open_thread(thread);
}

export function open_thread_for_message(message_id: number): void {
    const message = message_store.get(message_id);
    assert(message?.type === "stream");
    ykphone_threads.create_thread(message_id, open_thread);
}

// The lightbox takes the sender from the enclosing .message_row, which
// panel rows and the root block do not have (on purpose: feed handlers
// must not treat them as feed rows), so it is filled in from the row's
// message id instead.
function show_lightbox_sender($media: JQuery): void {
    const message_id = Number(
        $media.closest(".ykphone-thread-panel-message").attr("data-message-id"),
    );
    const sender = message_store.get(message_id)?.sender_full_name;
    if (sender !== undefined) {
        $("#lightbox_overlay .media-description .user").text(sender).prop("title", sender);
    }
}

function add_mount_points(): void {
    // The right column's contents are rendered by sidebar_ui; the
    // panel sits beside the buddy list and the theme shows one or the
    // other. The root block goes above the message lists in the feed.
    $("#right-sidebar-container").append(
        $("<div>")
            .attr("id", "ykphone-thread-panel")
            .addClass("ykphone-thread-panel")
            .attr("role", "complementary")
            .attr("aria-label", $t({defaultMessage: "Thread"})),
    );
    $("#message-lists-container").before($("<div>").attr("id", "ykphone-thread-root"));
}

export function initialize(): void {
    ykphone_flags.set_channels_open_in_general_chat(true);
    add_mount_points();

    // Feed controls are delegated from #main_div, like upstream's own
    // message controls: the row-selection handler there stops
    // propagation, so a body-level handler would never see the click.
    $("#main_div").on("click", ".ykphone-thread-button", function (this: HTMLElement, e) {
        e.stopPropagation();
        e.preventDefault();
        const $row = rows.get_closest_row($(this));
        open_thread_for_message(rows.id($row));
    });

    $("#main_div").on("click", ".ykphone-thread-pill", function (this: HTMLElement, e) {
        e.stopPropagation();
        e.preventDefault();
        const $row = rows.get_closest_row($(this));
        const thread = ykphone_threads.get_thread(rows.id($row));
        assert(thread !== undefined);
        open_thread(thread);
    });

    $("body").on("click", ".ykphone-thread-panel-close", () => {
        ykphone_thread_panel.close();
    });

    $("body").on("click", ".ykphone-thread-panel-full-view", (e) => {
        e.preventDefault();
        const thread = ykphone_thread_panel.get_open_thread();
        assert(thread !== undefined);
        open_in_full_view(thread);
    });

    $("body").on("click", ".ykphone-thread-panel-send", () => {
        ykphone_thread_panel.send_reply();
    });

    // Enter sends and Shift+Enter inserts a newline, as in Slack; the
    // event stops here so the global hotkey handler does not see it.
    $("body").on("keydown", ".ykphone-thread-panel-textarea", (e) => {
        if (keydown_util.is_enter_event(e) && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            ykphone_thread_panel.send_reply();
        }
    });

    // The lightbox binds its inline-media handlers to the feed only;
    // without these the browser would follow the link and leave the app.
    $("body").on(
        "click",
        "#ykphone-thread-panel .message-media-inline-image a, #ykphone-thread-panel .message-media-preview-image:not(.message_inline_video) a, #ykphone-thread-panel .message_inline_animated_image_still",
        function (this: HTMLElement, e) {
            e.preventDefault();
            e.stopPropagation();
            lightbox.handle_inline_media_element_click($(this).find<HTMLImageElement>("img"), true);
            show_lightbox_sender($(this));
        },
    );
    $("body").on(
        "click",
        "#ykphone-thread-panel .message_inline_video",
        function (this: HTMLElement, e) {
            e.preventDefault();
            e.stopPropagation();
            lightbox.handle_inline_media_element_click(
                $(this).find<HTMLMediaElement>("video"),
                true,
            );
            show_lightbox_sender($(this));
        },
    );
    // The root block sits inside the feed, where the lightbox's own
    // handler (registered earlier on the same element) opens the media;
    // this one only supplies the sender.
    $("#main_div").on(
        "click",
        "#ykphone-thread-root .message-media-inline-image a, #ykphone-thread-root .message-media-preview-image a, #ykphone-thread-root .message_inline_animated_image_still, #ykphone-thread-root .message_inline_video",
        function (this: HTMLElement) {
            show_lightbox_sender($(this));
        },
    );

    ykphone_threads.on_stream_threads_loaded(() => {
        ykphone_thread_panel.update_full_view_root();
    });
    ykphone_thread_panel.update_full_view_root();
}
