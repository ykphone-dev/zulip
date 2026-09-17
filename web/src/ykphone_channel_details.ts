// What the Slack-style "채널 정보" dialog shows and sends, for the 옆커폰
// fork.
//
// Slack keeps everything about a channel in one modal with three tabs:
// About (description, who made it, privacy, leave, archive), Members
// (search, add, remove) and Settings (rename, notifications, mute).
// Zulip spreads the same things over its channel-manager overlay, whose
// four tabs and weekly-traffic table belong to an admin tool rather than
// to a chat room; the overlay stays reachable from "채널 찾아보기".
//
// This module holds the rules and the request bodies; the dialog itself
// (a dialog_widget with upstream's tab switcher) is wired in
// ykphone_channel_details_ui.ts.

import {$t, $t_html} from "./i18n.ts";
import * as peer_data from "./peer_data.ts";
import * as people from "./people.ts";
import type {User} from "./people.ts";
import * as stream_data from "./stream_data.ts";
import type {SubData} from "./stream_settings_api.ts";
import type {StreamSubscription} from "./sub_store.ts";
import * as timerender from "./timerender.ts";
import * as util from "./util.ts";

export type DetailsTab = "info" | "members" | "settings";

// Slack's three choices for a channel. Zulip has no single setting for
// them: a channel carries five per-channel notification settings, each
// of which is null while it follows the user's global default. The
// choices set all five as a group (see notification_sub_data), so
// "없음" silences this channel's email digest too.
export type NotificationChoice = "all" | "mentions" | "none";

export type InfoContext = {
    stream_id: number;
    name: string;
    // The channel's own description, raw for the editor and rendered
    // for display.
    description: string;
    rendered_description: string;
    has_description: boolean;
    can_edit_description: boolean;
    privacy_label: string;
    privacy_icon: string;
    // Undefined for a channel created before Zulip recorded creators,
    // or whose creator is no longer in the organization.
    created_by: string | undefined;
    created_date: string;
    member_count: number;
    is_archived: boolean;
    can_leave: boolean;
    can_archive: boolean;
};

export type MemberRow = {
    user_id: number;
    full_name: string;
    avatar_url: string;
    role: string | undefined;
    is_me: boolean;
    can_remove: boolean;
};

export type MembersContext = {
    stream_id: number;
    rows: MemberRow[];
    // Whether the list is still being fetched: the rows are empty and
    // the dialog shows a loading line rather than "아무도 없습니다".
    loading: boolean;
    can_add: boolean;
    no_results: boolean;
};

export type SettingsContext = {
    stream_id: number;
    name: string;
    can_rename: boolean;
    // The per-channel notification settings and the mute belong to a
    // subscription: an unsubscribed administrator only renames.
    is_subscribed: boolean;
    notification_choice: NotificationChoice;
    is_muted: boolean;
    is_archived: boolean;
};

export function privacy_label(sub: StreamSubscription): string {
    if (sub.is_archived) {
        return $t({defaultMessage: "Archived channel"});
    }
    if (sub.invite_only) {
        return $t({defaultMessage: "Private channel"});
    }
    if (sub.is_web_public) {
        return $t({defaultMessage: "Web-public channel"});
    }
    return $t({defaultMessage: "Public channel"});
}

function privacy_icon(sub: StreamSubscription): string {
    if (sub.is_archived) {
        return "archive";
    }
    if (sub.invite_only) {
        return "lock";
    }
    if (sub.is_web_public) {
        return "globe";
    }
    return "hashtag";
}

function creator_name(creator_id: number | null): string | undefined {
    if (creator_id === null) {
        return undefined;
    }
    const person = people.maybe_get_user_by_id(creator_id, true);
    return person === undefined ? undefined : person.full_name;
}

export function info_context(sub: StreamSubscription): InfoContext {
    return {
        stream_id: sub.stream_id,
        name: sub.name,
        description: sub.description,
        rendered_description: sub.rendered_description,
        has_description: sub.description !== "",
        // The server asks only for metadata access to change a
        // description (zerver/views/streams.py), which is what
        // upstream's own channel settings gate it on, and what the
        // rename on the 설정 tab uses.
        can_edit_description:
            stream_data.can_change_permissions_requiring_metadata_access(sub) && !sub.is_archived,
        privacy_label: privacy_label(sub),
        privacy_icon: privacy_icon(sub),
        created_by: creator_name(sub.creator_id),
        created_date: timerender.get_localized_date_or_time_for_format(
            new Date(sub.date_created * 1000),
            "dayofyear_year",
        ),
        member_count: peer_data.get_subscriber_count(sub.stream_id),
        is_archived: sub.is_archived,
        can_leave: sub.subscribed && stream_data.can_toggle_subscription(sub),
        can_archive: stream_data.can_archive_stream(sub),
    };
}

// Slack lists a channel's members with their role, the search matching
// name or email, and offers "제거" only where the user may remove that
// member (themselves always, others with permission).
export function member_rows(sub: StreamSubscription, query: string): MemberRow[] {
    const user_ids = peer_data.has_full_subscriber_data(sub.stream_id)
        ? peer_data.get_subscriber_ids_assert_loaded(sub.stream_id)
        : [];
    const can_remove_others = stream_data.can_unsubscribe_others(sub);
    const term = query.trim().toLowerCase();
    return user_ids
        .map((user_id) => people.maybe_get_user_by_id(user_id, true))
        .filter((person) => person !== undefined)
        .filter(
            (person) =>
                term === "" ||
                person.full_name.toLowerCase().includes(term) ||
                person.email.toLowerCase().includes(term),
        )
        .map((person) => {
            const is_me = people.is_my_user_id(person.user_id);
            return {
                user_id: person.user_id,
                full_name: person.full_name,
                avatar_url: people.small_avatar_url_for_person(person),
                role: people.get_user_type(person.user_id),
                is_me,
                can_remove:
                    !sub.is_archived &&
                    (is_me ? stream_data.can_toggle_subscription(sub) : can_remove_others),
            };
        })
        .toSorted((a, b) => util.strcmp(a.full_name, b.full_name));
}

export function members_context(sub: StreamSubscription, query: string): MembersContext {
    const rows = member_rows(sub, query);
    const loading = !peer_data.has_full_subscriber_data(sub.stream_id);
    return {
        stream_id: sub.stream_id,
        rows,
        loading,
        can_add: stream_data.can_subscribe_others(sub) && !sub.is_archived,
        no_results: !loading && rows.length === 0,
    };
}

// The settings a message notification comes from, as opposed to the
// wildcard-mention one; any of them makes the channel "모든 새 메시지".
const MESSAGE_NOTIFICATION_SETTINGS = [
    "desktop_notifications",
    "audible_notifications",
    "push_notifications",
    "email_notifications",
] as const;

export function notification_choice(sub: StreamSubscription): NotificationChoice {
    if (
        MESSAGE_NOTIFICATION_SETTINGS.some((name) =>
            stream_data.receives_notifications(sub.stream_id, name),
        )
    ) {
        return "all";
    }
    if (stream_data.receives_notifications(sub.stream_id, "wildcard_mentions_notify")) {
        return "mentions";
    }
    return "none";
}

// The settings each choice writes. "모든 새 메시지" turns the four
// message notifications on, "멘션만" turns them off and leaves
// @channel mentions notifying, "없음" turns @channel mentions off too.
// What no per-channel setting can silence — a mention of the user by
// name, an alert word, a followed thread — the dialog says under
// "없음" (zerver/lib/notification_data.py, message_notifications.ts).
export function notification_sub_data(stream_id: number, choice: NotificationChoice): SubData {
    const messages = choice === "all";
    return [
        ...MESSAGE_NOTIFICATION_SETTINGS.map((property) => ({
            stream_id,
            property,
            value: messages,
        })),
        {stream_id, property: "wildcard_mentions_notify" as const, value: choice !== "none"},
    ];
}

export function settings_context(sub: StreamSubscription): SettingsContext {
    return {
        stream_id: sub.stream_id,
        name: sub.name,
        can_rename:
            stream_data.can_change_permissions_requiring_metadata_access(sub) && !sub.is_archived,
        is_subscribed: sub.subscribed && !sub.is_archived,
        notification_choice: notification_choice(sub),
        is_muted: sub.is_muted,
        is_archived: sub.is_archived,
    };
}

// Whether the dialog has anything to show on its 설정 tab: a user who
// may not rename the channel still has their own notification choices,
// but an unsubscribed user has none of them (the per-channel settings
// belong to a subscription).
export function has_settings(sub: StreamSubscription): boolean {
    const context = settings_context(sub);
    return context.is_subscribed || context.can_rename;
}

export function name_error(name: string, sub: StreamSubscription): string | undefined {
    const trimmed = name.trim();
    if (trimmed === "") {
        return $t({defaultMessage: "Channel name is required."});
    }
    if (trimmed === sub.name) {
        return undefined;
    }
    const existing = stream_data.get_sub(trimmed);
    if (existing !== undefined) {
        return $t({defaultMessage: "A channel with this name already exists."});
    }
    return undefined;
}

export function rename_request_data(name: string): {new_name: string} {
    return {new_name: name.trim()};
}

export function description_request_data(description: string): {description: string} {
    return {description: description.trim()};
}

// The people the "사람 추가" pill may offer: everyone in the
// organization who is not already a member.
export function potential_members(sub: StreamSubscription): User[] {
    const members = new Set(
        peer_data.has_full_subscriber_data(sub.stream_id)
            ? peer_data.get_subscriber_ids_assert_loaded(sub.stream_id)
            : [],
    );
    return people.get_realm_users().filter((user) => !members.has(user.user_id));
}

export function leave_confirm_html(sub: StreamSubscription): string {
    return $t_html(
        {
            defaultMessage:
                "You will no longer receive messages from #{name}. You can join it again later.",
        },
        {name: sub.name},
    );
}

export function private_leave_confirm_html(sub: StreamSubscription): string {
    return $t_html(
        {
            defaultMessage:
                "#{name} is private. Once you leave, you will need an invitation to join it again.",
        },
        {name: sub.name},
    );
}

// The channel changed under an open dialog: a rename, a description, a
// mute or a notification setting (stream_events.update_property), or
// somebody added or removed (stream_events.process_subscriber_update).
// The dialog registers a listener; the events call notify_stream_changed
// with one line each.
const change_listeners: ((stream_id: number) => void)[] = [];

export function on_stream_changed(listener: (stream_id: number) => void): void {
    change_listeners.push(listener);
}

export function notify_stream_changed(stream_id: number): void {
    for (const listener of change_listeners) {
        listener(stream_id);
    }
}

export function clear_for_testing(): void {
    change_listeners.length = 0;
}

export function created_by_line(context: InfoContext): string {
    if (context.created_by === undefined) {
        return $t({defaultMessage: "Created on {date}"}, {date: context.created_date});
    }
    return $t(
        {defaultMessage: "Created by {name} on {date}"},
        {name: context.created_by, date: context.created_date},
    );
}
