// The places Slack-style navigation in the 옆커폰 fork can return to:
// a channel's conversation (its general chat), a direct message
// conversation, a thread (a channel topic) and the fork's pages.
//
// Home (the last conversation viewed), the navbar's History dropdown
// and the ⌘K quick switcher all keep and show places in this form, so
// a place stored yesterday is described with today's channel name and
// is dropped once its channel or one of its people is gone.

import * as z from "zod/mini";

import type {Filter} from "./filter.ts";
import * as hash_util from "./hash_util.ts";
import {$t} from "./i18n.ts";
import * as narrow_state from "./narrow_state.ts";
import * as people from "./people.ts";
import {current_user} from "./state_data.ts";
import * as stream_data from "./stream_data.ts";
import type {StreamSubscription} from "./sub_store.ts";
import * as util from "./util.ts";
import * as ykphone_split_view from "./ykphone_split_view.ts";

const page_ids = [
    "dms",
    "activity",
    "threads",
    "files",
    "saved",
    "drafts",
    "scheduled",
    "reminders",
    "settings",
    "admin",
] as const;

export type PageId = (typeof page_ids)[number];

export const place_schema = z.discriminatedUnion("kind", [
    z.object({kind: z.literal("channel"), stream_id: z.number()}),
    // The other participants, sorted; just the user for a
    // conversation with themselves.
    z.object({kind: z.literal("dm"), user_ids: z.array(z.number())}),
    z.object({kind: z.literal("thread"), stream_id: z.number(), topic: z.string()}),
    z.object({kind: z.literal("page"), page: z.enum(page_ids)}),
]);

export type Place = z.infer<typeof place_schema>;

export type PlaceView = {
    key: string;
    kind: Place["kind"];
    title: string;
    // A muted second label: the channel a thread belongs to.
    context: string | undefined;
    // A zulip-icon name, shown when there is no avatar.
    icon: string;
    avatar_url: string | undefined;
    hash: string;
};

export function is_conversation(place: Place): boolean {
    return place.kind !== "page";
}

export function place_key(place: Place): string {
    switch (place.kind) {
        case "channel":
            return `channel:${place.stream_id}`;
        case "dm":
            return `dm:${place.user_ids.join(",")}`;
        case "thread":
            // Topics are case-insensitive.
            return `thread:${place.stream_id}:${place.topic.toLowerCase()}`;
    }
    return `page:${place.page}`;
}

export function dm_place(user_ids: number[]): Place {
    return {kind: "dm", user_ids: people.sorted_other_user_ids(user_ids)};
}

export function channel_place(stream_id: number): Place {
    return {kind: "channel", stream_id};
}

export function page_place(page: PageId): Place {
    return {kind: "page", page};
}

// A page named by one of our own templates (a data attribute).
export function page_place_from_id(page: string | undefined): Place | undefined {
    const known = page_ids.find((candidate) => candidate === page);
    return known === undefined ? undefined : page_place(known);
}

// The place a narrow shows, if it is one: a conversation (a channel's
// general chat, a thread, a direct message conversation, with or
// without a message to scroll to), the Files view or saved messages.
export function place_for_filter(filter: Filter): Place | undefined {
    if (filter.is_conversation_view()) {
        const user_ids = narrow_state.pm_ids(filter);
        if (user_ids !== undefined) {
            return dm_place(user_ids);
        }
        const stream_id = narrow_state.stream_id(filter, true);
        const topic = narrow_state.topic(filter);
        if (stream_id === undefined || topic === undefined) {
            return undefined;
        }
        return topic === "" ? channel_place(stream_id) : {kind: "thread", stream_id, topic};
    }
    switch (filter.sorted_term_types().join(" ")) {
        case "has-attachment":
            return page_place("files");
        case "is-starred":
            return page_place("saved");
        default:
            return undefined;
    }
}

// The place on screen: a split page while one is open, else the
// narrow's place.
export function current_view_place(): Place | undefined {
    const route = ykphone_split_view.get_route();
    if (route !== undefined) {
        return page_place(route.page);
    }
    const filter = narrow_state.filter();
    return filter === undefined ? undefined : place_for_filter(filter);
}

// A channel the user has left, or that was archived, cannot be opened
// as a conversation any more, so no list offers it: Home, the History
// dropdown and the quick switcher all go through describe().
export function is_open_channel(stream_id: number): boolean {
    return open_sub(stream_id) !== undefined;
}

function open_sub(stream_id: number): StreamSubscription | undefined {
    const sub = stream_data.get_sub_by_id(stream_id);
    return sub !== undefined && sub.subscribed && !sub.is_archived ? sub : undefined;
}

function channel_icon(sub: StreamSubscription): string {
    if (sub.invite_only) {
        return "lock";
    }
    return sub.is_web_public ? "globe" : "hashtag";
}

type PageInfo = {title: string; icon: string; hash: string};

function page_info(page: PageId): PageInfo | undefined {
    switch (page) {
        case "dms":
        case "activity":
        case "threads":
            return {
                title: ykphone_split_view.page_title(page),
                icon: ykphone_split_view.page_icon(page),
                hash: ykphone_split_view.page_hash(page),
            };
        case "files":
            return {
                title: $t({defaultMessage: "Files"}),
                icon: "ykphone-rail-file",
                hash: "#narrow/has/attachment",
            };
        case "saved":
            return {
                title: $t({defaultMessage: "Later"}),
                icon: "bookmark",
                hash: "#narrow/is/starred",
            };
        case "drafts":
            return {title: $t({defaultMessage: "Drafts"}), icon: "drafts", hash: "#drafts"};
        case "scheduled":
            return {
                title: $t({defaultMessage: "Scheduled messages"}),
                icon: "calendar-clock",
                hash: "#scheduled",
            };
        case "reminders":
            return {
                title: $t({defaultMessage: "Reminders"}),
                icon: "alarm-clock",
                hash: "#reminders",
            };
        case "settings":
            return {title: $t({defaultMessage: "Settings"}), icon: "gear", hash: "#settings"};
    }
    // The admin pages.
    if (!current_user.is_admin) {
        return undefined;
    }
    return {
        title: $t({defaultMessage: "Admin"}),
        icon: "ykphone-rail-gear",
        hash: "#organization",
    };
}

// How a place is shown and where it leads, or undefined when it can no
// longer be opened: its channel is gone or no longer visible, one of
// its people is gone, or a page the user may not open.
export function describe(place: Place): PlaceView | undefined {
    const key = place_key(place);
    switch (place.kind) {
        case "channel": {
            const sub = open_sub(place.stream_id);
            if (sub === undefined) {
                return undefined;
            }
            return {
                key,
                kind: place.kind,
                title: sub.name,
                context: undefined,
                icon: channel_icon(sub),
                avatar_url: undefined,
                hash: hash_util.by_stream_topic_url(place.stream_id, ""),
            };
        }
        case "thread": {
            const sub = open_sub(place.stream_id);
            if (sub === undefined) {
                return undefined;
            }
            return {
                key,
                kind: place.kind,
                title: place.topic,
                context: `#${sub.name}`,
                icon: "threads",
                avatar_url: undefined,
                hash: hash_util.by_stream_topic_url(place.stream_id, place.topic),
            };
        }
        case "dm": {
            if (place.user_ids.length === 0 || !people.is_valid_user_ids(place.user_ids)) {
                return undefined;
            }
            const user_ids_string = place.user_ids.join(",");
            const person =
                place.user_ids.length === 1
                    ? people.get_by_user_id(util.the(place.user_ids))
                    : undefined;
            return {
                key,
                kind: place.kind,
                title: people.format_recipients(user_ids_string, "narrow"),
                context: undefined,
                icon: person === undefined ? "users" : "user",
                avatar_url:
                    person === undefined ? undefined : people.small_avatar_url_for_person(person),
                hash: hash_util.pm_with_url(user_ids_string),
            };
        }
    }
    const info = page_info(place.page);
    if (info === undefined) {
        return undefined;
    }
    return {key, kind: place.kind, context: undefined, avatar_url: undefined, ...info};
}
