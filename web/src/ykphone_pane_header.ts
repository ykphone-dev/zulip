// Slack-style header at the top of the message pane for the 옆커폰
// fork.
//
// Upstream shows the current channel or view in the navbar
// (message_view_header); Slack shows it in a header row of the pane
// itself, with a member-count button and a row of tabs (Messages,
// Files, Pins) for channels. This module renders that row from the
// same inputs upstream uses, into an element mounted at the top of
// the middle column, whenever upstream re-renders its own title area
// (message_view_header.render_title_area calls render directly: going
// through ykphone_ui_hooks would close an import cycle through the
// thread panel) and whenever the pins change. The navbar copy is
// hidden by the theme but left in place for the code that expects it.
//
// The DOM event wiring lives in ykphone_threads_ui.ts and
// ykphone_pins_ui.ts.

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
import * as stream_data from "./stream_data.ts";
import type {StreamSubscription} from "./sub_store.ts";
import * as ui_util from "./ui_util.ts";
import * as util from "./util.ts";
import * as ykphone_activity from "./ykphone_activity.ts";
import * as ykphone_conversation from "./ykphone_conversation.ts";
import * as ykphone_pins from "./ykphone_pins.ts";

export type PaneHeaderChannel = {
    stream_id: number;
    settings_url: string;
    member_count: number;
    // Up to MAX_HEADER_AVATARS subscriber avatars for the member
    // button; empty until the subscriber list has been fetched.
    avatar_urls: string[];
    has_avatars: boolean;
    is_archived: boolean;
};

export type PaneHeaderTabs = {
    active: "messages" | "files" | "pins";
    messages_url: string;
    files_url: string;
    // Undefined while unknown: spectators cannot fetch pins.
    pin_count: number | undefined;
    has_pins: boolean;
};

export type PaneHeaderContext = {
    title: string;
    zulip_icon?: string | undefined;
    icon?: string | undefined;
    // The thread's name in a thread's full view (topic narrow).
    topic?: string;
    channel?: PaneHeaderChannel;
    // Slack's Messages / Files / Pins row, in a channel's own views.
    tabs?: PaneHeaderTabs;
    // Presence class and avatar of the other person in a one-to-one
    // direct message narrow; group conversations show the DM icon.
    user_circle_class?: string;
    dm_avatar_url?: string;
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
        .toSorted((a, b) => a - b)
        .slice(0, MAX_HEADER_AVATARS)
        .map((user_id) => people.small_avatar_url_for_user_id(user_id));
}

export function files_url(stream_id: number): string {
    return hash_util.search_terms_to_hash([
        {operator: "channel", operand: stream_id.toString()},
        {operator: "has", operand: "attachment"},
    ]);
}

function tabs_context(sub: StreamSubscription, active: PaneHeaderTabs["active"]): PaneHeaderTabs {
    const pin_count = page_params.is_spectator ? undefined : ykphone_pins.pin_count(sub.stream_id);
    return {
        active,
        messages_url: hash_util.channel_url_by_user_setting(sub.stream_id),
        files_url: files_url(sub.stream_id),
        pin_count,
        has_pins: pin_count !== undefined && pin_count > 0,
    };
}

function channel_context(sub: StreamSubscription): PaneHeaderChannel {
    const avatar_urls = channel_avatar_urls(sub.stream_id);
    return {
        stream_id: sub.stream_id,
        settings_url: hash_util.channels_settings_edit_url(sub, "general"),
        member_count: peer_data.get_subscriber_count(sub.stream_id),
        avatar_urls,
        has_avatars: avatar_urls.length > 0,
        is_archived: sub.is_archived,
    };
}

function icon_context(
    filter: Filter,
    title: string,
): Pick<PaneHeaderContext, "zulip_icon" | "icon"> {
    const icon_data = filter.add_icon_data({title, is_spectator: page_params.is_spectator});
    const zulip_icon = "zulip_icon" in icon_data ? icon_data.zulip_icon : undefined;
    return {
        // The sidebar row for the Later view uses a bookmark.
        zulip_icon: zulip_icon === "star" ? "bookmark" : zulip_icon,
        icon: "icon" in icon_data ? icon_data.icon : undefined,
    };
}

export function get_context(filter: Filter | undefined): PaneHeaderContext {
    // The view cases mirror message_view_header, including its
    // fallback to the combined feed while the initial narrow is not
    // known yet.
    if (recent_view_util.is_visible()) {
        return {title: $t({defaultMessage: "Threads"}), zulip_icon: "threads"};
    }
    if (inbox_util.is_visible() && !inbox_util.is_channel_view()) {
        return {title: $t({defaultMessage: "Inbox"}), zulip_icon: "inbox"};
    }
    if (ykphone_activity.is_visible()) {
        return {title: $t({defaultMessage: "Activity"}), zulip_icon: "bell"};
    }
    if (filter === undefined || filter.is_in_home()) {
        return {title: $t({defaultMessage: "Combined feed"}), zulip_icon: "all-messages"};
    }
    if (ykphone_conversation.is_files_narrow(filter)) {
        // The rail's Files view is a search upstream would title
        // "Search results".
        return {title: $t({defaultMessage: "Files"}), zulip_icon: "file-text"};
    }

    if (ykphone_conversation.is_channel_files_narrow(filter)) {
        // The channel's Files tab is a search upstream would title
        // "Search results"; the header stays the channel's.
        const sub = stream_data.get_sub_by_id_string(
            filter.terms_with_operator("channel")[0]!.operand,
        );
        if (sub !== undefined) {
            return {
                title: sub.name,
                ...icon_context(filter, sub.name),
                channel: channel_context(sub),
                tabs: tabs_context(sub, "files"),
            };
        }
    }

    if (!filter.is_common_narrow()) {
        return {title: $t({defaultMessage: "Search results"}), zulip_icon: "search"};
    }

    const title = filter.get_title();
    assert(title !== undefined);
    const context: PaneHeaderContext = {title, ...icon_context(filter, title)};

    if (filter.has_operator("channel")) {
        const sub = stream_data.get_sub_by_id_string(
            filter.terms_with_operator("channel")[0]!.operand,
        );
        // The empty topic is the channel's general chat, which is the
        // channel itself; a thread's full view names the thread and
        // has no tabs.
        const topic = filter.has_operator("topic")
            ? filter.terms_with_operator("topic")[0]!.operand
            : "";
        if (topic !== "") {
            context.topic = topic;
        }
        // An unknown or inaccessible channel keeps the title upstream
        // chose ("Unknown channel") without the channel controls.
        if (sub !== undefined) {
            context.channel = channel_context(sub);
            if (topic === "") {
                context.tabs = tabs_context(
                    sub,
                    ykphone_pins.get_panel_stream_id() === sub.stream_id ? "pins" : "messages",
                );
            }
        }
        return context;
    }

    if (filter.has_operator("dm")) {
        const user_ids = filter.terms_with_operator("dm")[0]!.operand;
        if (user_ids.length === 1) {
            const user_id = user_ids[0]!;
            context.user_circle_class = `user-circle-${presence.get_status(user_id)}`;
            context.dm_avatar_url = people.small_avatar_url_for_user_id(user_id);
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
    void (async () => {
        try {
            await peer_data.get_subscribers_with_possible_fetch(stream_id);
        } catch {
            // A failed fetch is forgotten too, so the next narrow can
            // retry.
        }
        fetching_subscribers.delete(stream_id);
        if (narrow_state.stream_id() === stream_id) {
            render();
        }
    })();
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
        maybe_fetch_subscribers(context.channel.stream_id);
        if (context.tabs !== undefined && !page_params.is_spectator) {
            // The Pins tab's count; the rows re-render when it lands.
            ykphone_pins.load_stream_pins(context.channel.stream_id);
        }
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
