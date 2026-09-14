// Slack-style header at the top of the message pane for the 옆커폰
// fork.
//
// Upstream shows the current channel or view in the navbar
// (message_view_header); Slack shows it in a header row of the pane
// itself, with a member-count button for channels. This module renders
// that row from the same inputs upstream uses, into an element mounted
// at the top of the middle column, whenever upstream re-renders its
// own title area (message_view_header.render_title_area calls render
// directly: going through ykphone_ui_hooks would close an import cycle
// through the thread panel). The navbar copy is hidden by the theme but
// left in place for the code that expects it.
//
// The DOM event wiring lives in ykphone_threads_ui.ts.

import $ from "jquery";
import assert from "minimalistic-assert";
import type {ReferenceElement} from "tippy.js";

import render_ykphone_pane_header from "../templates/ykphone_pane_header.hbs";

import type {Filter} from "./filter.ts";
import * as hash_util from "./hash_util.ts";
import {$t} from "./i18n.ts";
import * as inbox_util from "./inbox_util.ts";
import * as narrow_state from "./narrow_state.ts";
import {page_params} from "./page_params.ts";
import * as peer_data from "./peer_data.ts";
import * as people from "./people.ts";
import * as presence from "./presence.ts";
import * as recent_view_util from "./recent_view_util.ts";
import * as rendered_markdown from "./rendered_markdown.ts";
import * as stream_data from "./stream_data.ts";
import * as ui_util from "./ui_util.ts";
import * as util from "./util.ts";

export type PaneHeaderChannel = {
    stream_id: number;
    settings_url: string;
    member_count: number;
    // Up to MAX_HEADER_AVATARS subscriber avatars for the member
    // button; empty until the subscriber list has been fetched.
    avatar_urls: string[];
    is_archived: boolean;
};

export type PaneHeaderContext = {
    title: string;
    zulip_icon?: string | undefined;
    icon?: string | undefined;
    // The channel description, as rendered by the server; views have
    // no second line.
    description_html?: string;
    // The thread's name in a thread's full view (topic narrow).
    topic?: string;
    channel?: PaneHeaderChannel;
    // Presence class of the other person in a one-to-one direct
    // message narrow; group conversations show the DM icon instead.
    user_circle_class?: string;
};

const MAX_HEADER_AVATARS = 3;

// Streams whose subscriber list is being fetched for the avatars.
const fetching_subscribers = new Set<number>();

function channel_avatar_urls(stream_id: number): string[] {
    if (!peer_data.has_full_subscriber_data(stream_id)) {
        return [];
    }
    return peer_data
        .get_subscriber_ids_assert_loaded(stream_id)
        .filter((user_id) => !people.is_valid_bot_user(user_id))
        .sort((a, b) => a - b)
        .slice(0, MAX_HEADER_AVATARS)
        .map((user_id) => people.small_avatar_url_for_user_id(user_id));
}

export function get_context(filter: Filter | undefined): PaneHeaderContext {
    // The view cases mirror message_view_header, including its
    // fallback to the combined feed while the initial narrow is not
    // known yet.
    if (recent_view_util.is_visible()) {
        return {title: $t({defaultMessage: "Threads"}), zulip_icon: "recent"};
    }
    if (inbox_util.is_visible() && !inbox_util.is_channel_view()) {
        return {title: $t({defaultMessage: "Inbox"}), zulip_icon: "inbox"};
    }
    if (filter === undefined || filter.is_in_home()) {
        return {title: $t({defaultMessage: "Combined feed"}), zulip_icon: "all-messages"};
    }
    if (!filter.is_common_narrow()) {
        return {title: $t({defaultMessage: "Search results"}), zulip_icon: "search"};
    }

    const title = filter.get_title();
    assert(title !== undefined);
    const icon_data = filter.add_icon_data({title, is_spectator: page_params.is_spectator});
    const zulip_icon = "zulip_icon" in icon_data ? icon_data.zulip_icon : undefined;
    const context: PaneHeaderContext = {
        title,
        // The sidebar row for the Later view uses a bookmark.
        zulip_icon: zulip_icon === "star" ? "bookmark" : zulip_icon,
        icon: "icon" in icon_data ? icon_data.icon : undefined,
    };

    if (filter.has_operator("channel")) {
        const sub = stream_data.get_sub_by_id_string(
            filter.terms_with_operator("channel")[0]!.operand,
        );
        // An unknown or inaccessible channel keeps the title upstream
        // chose ("Unknown channel") without the channel controls.
        if (sub !== undefined) {
            context.channel = {
                stream_id: sub.stream_id,
                settings_url: hash_util.channels_settings_edit_url(sub, "general"),
                member_count: peer_data.get_subscriber_count(sub.stream_id),
                avatar_urls: channel_avatar_urls(sub.stream_id),
                is_archived: sub.is_archived,
            };
            context.description_html = sub.rendered_description;
        }
        if (filter.has_operator("topic")) {
            // The empty topic is the channel's general chat.
            const topic = filter.terms_with_operator("topic")[0]!.operand;
            if (topic !== "") {
                context.topic = topic;
            }
        }
        return context;
    }

    if (filter.has_operator("dm")) {
        const user_ids = filter.terms_with_operator("dm")[0]!.operand;
        if (user_ids.length === 1) {
            context.user_circle_class = `user-circle-${presence.get_status(user_ids[0]!)}`;
        }
    }
    return context;
}

// The buddy list fetches subscribers only when it needs them, so the
// header fetches its own for the avatars, once per channel, and
// re-renders if the channel is still the one shown. Spectators cannot
// fetch subscribers (peer_data asserts), and their member button is
// hidden anyway.
function maybe_fetch_subscribers(stream_id: number): void {
    if (
        page_params.is_spectator ||
        peer_data.has_full_subscriber_data(stream_id) ||
        fetching_subscribers.has(stream_id)
    ) {
        return;
    }
    fetching_subscribers.add(stream_id);
    // A failed fetch is forgotten too, so the next narrow can retry.
    const on_done = (): void => {
        fetching_subscribers.delete(stream_id);
        if (narrow_state.stream_id() === stream_id) {
            render();
        }
    };
    void peer_data.get_subscribers_with_possible_fetch(stream_id).then(on_done, on_done);
}

// Whether the member list is on screen: the persisted toggle on wide
// screens, the overlay state below that.
function member_list_shown(): boolean {
    if (ui_util.matches_viewport_state("gte_xl_min")) {
        return !$("body").hasClass("hide-right-sidebar");
    }
    return $(".app-main .column-right").hasClass("expanded");
}

export function members_button_label(): string {
    return member_list_shown()
        ? $t({defaultMessage: "Hide members"})
        : $t({defaultMessage: "Show members"});
}

// Called after the member list is toggled from the button.
export function update_members_button(): void {
    const label = members_button_label();
    const $button = $("#ykphone-pane-header .ykphone-pane-header-members");
    if ($button.length === 0) {
        return;
    }
    $button.attr("aria-label", label).attr("data-tippy-content", label);
    // A tooltip already created reads its content once.
    const button: ReferenceElement = util.the($button);
    button._tippy?.setContent(label);
}

export function render(): void {
    const $header = $("#ykphone-pane-header");
    const context = get_context(narrow_state.filter());
    $header.html(render_ykphone_pane_header({...context, members_label: members_button_label()}));
    if (context.channel !== undefined) {
        // Channel names, emoji and mentions in the description.
        rendered_markdown.update_elements($header.find(".rendered_markdown"));
        maybe_fetch_subscribers(context.channel.stream_id);
    }
}

export function mount(): void {
    $(".app-main .column-middle-inner").prepend(
        $("<div>").attr("id", "ykphone-pane-header").addClass("ykphone-pane-header"),
    );
    render();
}

export function clear_for_testing(): void {
    fetching_subscribers.clear();
}
