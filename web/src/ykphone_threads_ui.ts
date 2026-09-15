// DOM event wiring for the 옆커폰 web UI: Slack-style threads (the
// feed controls and the side panel), the icon rail, the sidebar card
// header, the pane header, the navbar history controls, the always-open
// two-row compose box and the conversation intro. Pinned messages have
// their own wiring in ykphone_pins_ui. The state and rendering live in the other
// ykphone_* modules; this one only mounts them and binds handlers, so
// it is exempt from node coverage.

import $ from "jquery";
import assert from "minimalistic-assert";

import * as compose_actions from "./compose_actions.ts";
import * as hashchange from "./hashchange.ts";
import {$t} from "./i18n.ts";
import * as keydown_util from "./keydown_util.ts";
import * as lightbox from "./lightbox.ts";
import * as message_store from "./message_store.ts";
import * as message_view from "./message_view.ts";
import * as rows from "./rows.ts";
import * as sidebar_ui from "./sidebar_ui.ts";
import * as stream_popover from "./stream_popover.ts";
import * as ykphone_compose from "./ykphone_compose.ts";
import * as ykphone_compose_narrow from "./ykphone_compose_narrow.ts";
import * as ykphone_conversation from "./ykphone_conversation.ts";
import * as ykphone_flags from "./ykphone_flags.ts";
import * as ykphone_history from "./ykphone_history.ts";
import * as ykphone_layout from "./ykphone_layout.ts";
import * as ykphone_pane_header from "./ykphone_pane_header.ts";
import * as ykphone_pins from "./ykphone_pins.ts";
import * as ykphone_pins_ui from "./ykphone_pins_ui.ts";
import * as ykphone_rail from "./ykphone_rail.ts";
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
    // on top of the panel, and the pins panel shares the column; the
    // thread panel takes it over.
    sidebar_ui.hide_userlist_sidebar();
    ykphone_pins.close_panel();
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
// message id instead; pinned messages, which may not be in the store,
// carry the name on the row.
function show_lightbox_sender($media: JQuery): void {
    const $row = $media.closest(".ykphone-thread-panel-message");
    const message_id = Number($row.attr("data-message-id"));
    const sender = message_store.get(message_id)?.sender_full_name ?? $row.attr("data-sender-name");
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
            .addClass("ykphone-thread-panel ykphone-side-panel")
            .attr("role", "complementary")
            .attr("aria-label", $t({defaultMessage: "Thread"})),
    );
    $("#message-lists-container").before($("<div>").attr("id", "ykphone-thread-root"));
    // The conversation intro takes the place of upstream's logo.
    $(".top-messages-logo").before(
        $("<div>")
            .attr("id", "ykphone-conversation-intro")
            .addClass("ykphone-conversation-intro")
            .hide(),
    );
}

export function initialize(): void {
    ykphone_flags.set_channels_open_in_general_chat(true);
    add_mount_points();
    ykphone_rail.mount();
    ykphone_layout.reorder_left_sidebar_sections();
    ykphone_layout.hide_member_list_by_default();
    ykphone_pane_header.mount();
    ykphone_compose.mount();
    ykphone_compose_narrow.initialize();
    ykphone_pins_ui.initialize();
    ykphone_conversation.update_body_class();
    // The label on the "new messages" line is drawn by the theme CSS.
    document.documentElement.style.setProperty(
        "--yk-new-label",
        JSON.stringify($t({defaultMessage: "New"})),
    );

    ykphone_history.initialize();
    $("body").on("click", ".ykphone-navbar-back", () => {
        ykphone_history.go_back();
    });
    $("body").on("click", ".ykphone-navbar-forward", () => {
        ykphone_history.go_forward();
    });

    // The member button stands in for the navbar toggle, which keeps
    // the show/hide state; while a thread is open the panel holds the
    // column, so it closes first.
    $("body").on("click", ".ykphone-pane-header-members", () => {
        ykphone_thread_panel.close();
        $("#userlist-toggle-button").trigger("click");
        ykphone_pane_header.update_members_button();
    });

    $("#compose").on("click", ".ykphone-compose-formatting-toggle", (e) => {
        e.preventDefault();
        ykphone_compose.toggle_formatting_row();
    });
    $("#compose").on("click", ".ykphone-compose-mention", (e) => {
        e.preventDefault();
        ykphone_compose.insert_mention();
    });
    $("#compose").on("click", ".ykphone-compose-more", (e) => {
        e.preventDefault();
        ykphone_compose.toggle_extras();
    });

    // The channel title opens the channel menu, as in Slack; modified
    // clicks keep the link to the channel settings.
    $("body").on("click", ".ykphone-pane-header-channel", function (this: HTMLElement, e) {
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        stream_popover.build_stream_popover({
            elt: this,
            stream_id: Number($(this).attr("data-stream-id")),
            placement: "bottom-start",
        });
    });

    // The logo keeps upstream's navbar behaviour (click_handlers.ts binds
    // "#header-container .brand", which the moved node no longer matches):
    // plain clicks go to the home view without touching the URL fragment,
    // modified clicks fall through to the link.
    $("body").on("click", "#ykphone-rail .brand", (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        hashchange.set_hash_to_home_view();
    });

    // Like the compose bar's "Start new conversation" button, this
    // opens an empty channel composer rather than a reply to the
    // current conversation.
    $("body").on("click", ".ykphone-sidebar-compose", () => {
        compose_actions.start({
            message_type: "stream",
            trigger: "sidebar new message",
            keep_composebox_empty: true,
        });
    });

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
        ".ykphone-side-panel .message-media-inline-image a, .ykphone-side-panel .message-media-preview-image:not(.message_inline_video) a, .ykphone-side-panel .message_inline_animated_image_still",
        function (this: HTMLElement, e) {
            e.preventDefault();
            e.stopPropagation();
            lightbox.handle_inline_media_element_click($(this).find<HTMLImageElement>("img"), true);
            show_lightbox_sender($(this));
        },
    );
    $("body").on(
        "click",
        ".ykphone-side-panel .message_inline_video",
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
