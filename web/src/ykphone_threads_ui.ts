// DOM event wiring for the 옆커폰 web UI: Slack-style threads (the
// feed controls and the side panel), the icon rail, the sidebar card
// header, the pane header, the navbar history controls, the always-open
// two-row compose box and the conversation intro. Pinned messages,
// favourites and the split pages (DM, Activity, Threads) have their own
// wiring in ykphone_pins_ui, ykphone_favorites_ui and
// ykphone_split_view_ui (the last one initialized from ui_init beside
// the inbox and recent views, whose show/hide it shares). The state and rendering live in the other
// ykphone_* modules; this one only mounts them and binds handlers, so
// it is exempt from node coverage.

import $ from "jquery";
import assert from "minimalistic-assert";

import render_ykphone_history_menu from "../templates/ykphone_history_menu.hbs";

import * as compose_actions from "./compose_actions.ts";
import * as compose_banner from "./compose_banner.ts";
import * as hashchange from "./hashchange.ts";
import {$t} from "./i18n.ts";
import * as lightbox from "./lightbox.ts";
import * as message_store from "./message_store.ts";
import * as message_view from "./message_view.ts";
import {page_params} from "./page_params.ts";
import * as popover_menus from "./popover_menus.ts";
import * as popovers from "./popovers.ts";
import * as reactions from "./reactions.ts";
import * as rows from "./rows.ts";
import * as sidebar_ui from "./sidebar_ui.ts";
import * as stream_popover from "./stream_popover.ts";
import {parse_html} from "./ui_util.ts";
import * as ykphone_channel_create_ui from "./ykphone_channel_create_ui.ts";
import * as ykphone_channel_details_ui from "./ykphone_channel_details_ui.ts";
import * as ykphone_compose from "./ykphone_compose.ts";
import * as ykphone_compose_narrow from "./ykphone_compose_narrow.ts";
import * as ykphone_conversation from "./ykphone_conversation.ts";
import * as ykphone_favorites_ui from "./ykphone_favorites_ui.ts";
import * as ykphone_forward from "./ykphone_forward.ts";
import * as ykphone_forward_ui from "./ykphone_forward_ui.ts";
import * as ykphone_history from "./ykphone_history.ts";
import * as ykphone_keyboard_nav from "./ykphone_keyboard_nav.ts";
import * as ykphone_layout from "./ykphone_layout.ts";
import * as ykphone_message_toolbar from "./ykphone_message_toolbar.ts";
import * as ykphone_pane_header from "./ykphone_pane_header.ts";
import * as ykphone_pins from "./ykphone_pins.ts";
import * as ykphone_pins_ui from "./ykphone_pins_ui.ts";
import * as ykphone_places from "./ykphone_places.ts";
import * as ykphone_rail from "./ykphone_rail.ts";
import * as ykphone_rich_compose from "./ykphone_rich_compose.ts";
import * as ykphone_rich_surfaces from "./ykphone_rich_surfaces.ts";
import * as ykphone_shell_theme_ui from "./ykphone_shell_theme_ui.ts";
import * as ykphone_split_view_ui from "./ykphone_split_view_ui.ts";
import * as ykphone_thread_panel from "./ykphone_thread_panel.ts";
import * as ykphone_threads from "./ykphone_threads.ts";
import type {ThreadInfo} from "./ykphone_threads.ts";
import * as ykphone_unread_badges from "./ykphone_unread_badges.ts";
import * as ykphone_unread_banner from "./ykphone_unread_banner.ts";

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
    ykphone_rich_surfaces.mount_thread_reply(thread, ykphone_thread_panel.send_reply);
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
    // The forward card sits above the compose form, inside the
    // composer's own area; its container is mounted once so that the
    // card can be rendered and dropped without touching the form.
    $("#send_message_form").before($("<div>").attr("id", "ykphone-forward-card-container"));
    // Slack fills a conversation from the bottom; this empty first
    // child of the feed takes whatever height the messages leave over
    // (see "Message feed" in the theme).
    $("#main_div").prepend($("<div>").attr("id", "ykphone-feed-spacer"));
    // The conversation intro takes the place of upstream's logo.
    $(".top-messages-logo").before(
        $("<div>")
            .attr("id", "ykphone-conversation-intro")
            .addClass("ykphone-conversation-intro")
            .hide(),
    );
}

export function initialize(): void {
    add_mount_points();
    ykphone_rail.mount();
    ykphone_unread_badges.initialize();
    ykphone_layout.reorder_left_sidebar_sections();
    ykphone_layout.hide_member_list_by_default();
    ykphone_layout.track_feed_bottom();
    ykphone_pane_header.mount();
    ykphone_unread_banner.mount();
    ykphone_unread_banner.initialize();
    ykphone_compose.mount();
    ykphone_rich_compose.mount();
    ykphone_rich_surfaces.initialize();
    ykphone_compose_narrow.initialize();
    ykphone_pins_ui.initialize();
    ykphone_favorites_ui.initialize();
    ykphone_channel_create_ui.initialize();
    ykphone_channel_details_ui.initialize();
    ykphone_shell_theme_ui.initialize();
    ykphone_conversation.update_body_class();
    // The label on the "new messages" line is drawn by the theme CSS.
    document.documentElement.style.setProperty(
        "--yk-new-label",
        JSON.stringify($t({defaultMessage: "New"})),
    );

    // Slack shows no selection until the user asks for one: the box
    // around the selected message (and the time it reveals in the
    // gutter) appears with the first navigation hotkey and is gone
    // again as soon as the pointer moves over the feed.
    let last_pointer_position: string | undefined;
    $("#main_div").on("mousemove", (e) => {
        const position = `${e.clientX},${e.clientY}`;
        if (position === last_pointer_position) {
            return;
        }
        last_pointer_position = position;
        ykphone_keyboard_nav.clear();
        ykphone_split_view_ui.clear_highlight();
    });
    $("#main_div").on("click", () => {
        ykphone_keyboard_nav.clear();
        ykphone_split_view_ui.clear_highlight();
    });

    // Forwarding: the card above the compose box is dropped by its own
    // close button; every other way of replacing the compose contents
    // goes through compose_actions.clear_box, and a draft saved on the
    // way out keeps the forward (drafts.update_draft).
    $("#compose").on("click", ".ykphone-forward-card-close", (e) => {
        e.preventDefault();
        ykphone_forward.clear();
    });

    ykphone_history.initialize();
    popover_menus.register_popover_menu(".ykphone-navbar-history-menu", {
        theme: "popover-menu",
        placement: "bottom-start",
        offset: popover_menus.NAVBAR_POPOVER_OFFSET,
        popperOptions: {strategy: "fixed"},
        onMount(instance) {
            popover_menus.popover_instances.ykphone_history = instance;
        },
        onShow(instance) {
            instance.setContent(
                parse_html(
                    render_ykphone_history_menu({
                        items: ykphone_history.menu_items(ykphone_places.current_view_place()),
                    }),
                ),
            );
            $(instance.reference).addClass("active-navbar-menu");
        },
        onHidden(instance) {
            $(instance.reference).removeClass("active-navbar-menu");
            instance.destroy();
            popover_menus.popover_instances.ykphone_history = null;
        },
    });
    $("body").on("click", ".ykphone-navbar-back", () => {
        ykphone_history.go_back();
    });
    $("body").on("click", ".ykphone-navbar-forward", () => {
        ykphone_history.go_forward();
    });

    // The member button opens the channel details on its member list,
    // as clicking Slack's member avatars does; the list in the sidebar
    // is toggled from inside that tab.
    $("body").on("click", ".ykphone-pane-header-members", function (this: HTMLElement) {
        ykphone_channel_details_ui.open(Number($(this).attr("data-stream-id")), "members");
    });

    // User card: the ⋮ beside the 메시지 button reveals Zulip's own
    // items (the list the theme hides while the card is collapsed), and
    // 통화 opens a direct message with a video call link, which is what
    // the composer's own call button inserts.
    $("body").on("click", ".ykphone-user-card-more", function (this: HTMLElement, e) {
        e.preventDefault();
        e.stopPropagation();
        const $card = $(this).closest(".user-card-popover-actions");
        const expanded = !$card.hasClass("ykphone-user-card-expanded");
        $card.toggleClass("ykphone-user-card-expanded", expanded);
        $(this).attr("aria-expanded", expanded ? "true" : "false");
        if (expanded) {
            $card.find(".popover-menu-list .link-item .popover-menu-link").first().trigger("focus");
        }
    });
    $("body").on("click", ".ykphone-user-card-call", function (this: HTMLElement, e) {
        e.preventDefault();
        e.stopPropagation();
        const user_id = Number($(this).closest("ul").attr("data-user-id"));
        popovers.hide_all();
        compose_actions.start({
            message_type: "private",
            trigger: "ykphone call",
            private_message_recipient_ids: [user_id],
        });
        $(".compose-control-buttons-container .video_link").trigger("click");
    });

    // The "N new messages" bar at the top of the conversation.
    $("body").on("click", ".ykphone-unread-banner-read", () => {
        ykphone_unread_banner.mark_read();
    });
    $("body").on("click", ".ykphone-unread-banner-jump", () => {
        ykphone_unread_banner.jump_to_first_unread();
    });
    $("body").on("click", ".ykphone-unread-banner-close", () => {
        ykphone_unread_banner.hide();
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

    // The channel title opens the channel details dialog, as in Slack;
    // modified clicks keep the link to the channel settings. The menu
    // the title used to open is on the ⋮ button beside it. A spectator
    // has neither (the dialog needs a subscriber list they cannot
    // fetch), so their click keeps following the link.
    $("body").on("click", ".ykphone-pane-header-channel", function (this: HTMLElement, e) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || page_params.is_spectator) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        ykphone_channel_details_ui.open(Number($(this).attr("data-stream-id")), "info");
    });

    $("body").on("click", ".ykphone-pane-header-menu", function (this: HTMLElement, e) {
        e.preventDefault();
        e.stopPropagation();
        stream_popover.build_stream_popover({
            elt: this,
            stream_id: Number($(this).attr("data-stream-id")),
            placement: "bottom-end",
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

    // Home is the last conversation (ykphone_home), not a URL of its
    // own; modified clicks open the empty URL, which resolves to it.
    $("body").on("click", '#ykphone-rail .ykphone-rail-item[data-rail-item="home"]', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
            return;
        }
        e.preventDefault();
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

    $("#main_div").on("click", ".ykphone-quick-reaction", function (this: HTMLElement, e) {
        e.stopPropagation();
        e.preventDefault();
        const message = message_store.get(rows.id(rows.get_closest_row($(this))));
        const emoji_name = $(this).attr("data-emoji-name");
        assert(emoji_name !== undefined);
        // A message still being sent has no id the server knows.
        if (message === undefined || message.locally_echoed === true) {
            return;
        }
        // Adds the reaction, or takes it back if it is already the
        // user's, as a click on the reaction itself does.
        reactions.toggle_emoji_reaction(message, emoji_name);
        // The user's own emoji order may have changed.
        ykphone_message_toolbar.clear_cache();
    });

    $("#main_div").on("click", ".ykphone-forward-button", function (this: HTMLElement, e) {
        e.stopPropagation();
        e.preventDefault();
        const message_id = rows.id(rows.get_closest_row($(this)));
        // A message still being sent has no id to link to yet.
        if (message_store.get(message_id)?.locally_echoed !== true) {
            ykphone_forward_ui.start(message_id);
        }
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

    // "Yes, send" on the panel's warning about notifying everyone in a
    // large channel sends the reply. Bound on the panel, so that it runs
    // before (and instead of) upstream's handler for the compose box's.
    $("#ykphone-thread-panel").on(
        "click",
        `.${CSS.escape(compose_banner.CLASSNAMES.wildcard_warning)} .main-view-banner-action-button`,
        (e) => {
            e.preventDefault();
            e.stopPropagation();
            ykphone_thread_panel.confirm_wildcard_mention();
        },
    );

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
