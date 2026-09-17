// Slack-style "Create a channel": the small two-step modal that
// replaces upstream's channel-management overlay for the common case.
// This module holds what the modal decides and sends; the popover
// menu, the dialog and the pill widget are wired in
// ykphone_channel_create_ui.
//
// The creation endpoint (POST /json/users/me/subscriptions) creates a
// channel of that name or, if one exists, subscribes the user to it,
// and its response does not say which happened or carry the channel's
// id. So the name is checked against the server's channel list right
// before the request, the response is checked for a channel the user
// was merely subscribed to, and the subscription event that follows
// (stream_events.mark_subscribed calls on_subscribed) settles it: a
// channel whose creator is someone else was joined, not created, and
// the UI leaves it again. The app moves to the new channel once that
// event has arrived and the modal has closed, whichever happens last.

import * as z from "zod/mini";

import render_channel_name_conflict_error from "../templates/stream_settings/channel_name_conflict_error.hbs";

import * as browser_history from "./browser_history.ts";
import * as channel_folders from "./channel_folders.ts";
import * as hash_util from "./hash_util.ts";
import {$t} from "./i18n.ts";
import {page_params} from "./page_params.ts";
import * as people from "./people.ts";
import * as settings_data from "./settings_data.ts";
import {current_user, realm} from "./state_data.ts";
import * as stream_data from "./stream_data.ts";
import type {StreamSubscription} from "./sub_store.ts";

// Slack offers "add everyone" only for organizations small enough
// that it cannot be a mistake.
export const ADD_EVERYONE_LIMIT = 500;

// How long after the modal has closed a subscription event may still
// count as the channel just created. Later ones are somebody else's.
export const PENDING_TIMEOUT_MS = 30_000;

export type Permissions = {
    can_create_public: boolean;
    can_create_private: boolean;
};

export type FolderOption = {
    id: number;
    name: string;
    selected: boolean;
};

export type FormContext = Permissions & {
    invite_only: boolean;
    has_folders: boolean;
    folders: FolderOption[];
    max_stream_name_length: number;
    max_stream_description_length: number;
};

export type NameCheck = {
    valid: boolean;
    error_html?: string;
    // A channel the client knows and can open, offered as a way out.
    existing_stream_id?: number;
};

export type CreateParams = {
    name: string;
    description: string;
    invite_only: boolean;
    folder_id: number | undefined;
};

export type ResponseConflict = "already_subscribed" | "not_subscribed";

type PendingCreation = {
    name: string;
    stream_id: number | undefined;
    modal_closed: boolean;
    on_conflict: (sub: StreamSubscription) => void;
    expiry: ReturnType<typeof setTimeout> | undefined;
};

const streams_response_schema = z.object({
    streams: z.array(z.object({name: z.string()})),
});

const subscribe_response_schema = z.object({
    subscribed: z.record(z.string(), z.array(z.string())),
    already_subscribed: z.record(z.string(), z.array(z.string())),
});

let pending: PendingCreation | undefined;

export function permissions(): Permissions {
    if (page_params.is_spectator) {
        return {can_create_public: false, can_create_private: false};
    }
    return {
        can_create_public: settings_data.user_can_create_public_streams(),
        can_create_private: settings_data.user_can_create_private_streams(),
    };
}

// Whether the "+" opens the menu with "Create a channel" in it; a
// user who can create nothing goes straight to the channel browser,
// as upstream's own "+" does.
export function can_create(): boolean {
    const {can_create_public, can_create_private} = permissions();
    return can_create_public || can_create_private;
}

export function form_context(preselected_folder_id: number | undefined): FormContext {
    const {can_create_public, can_create_private} = permissions();
    const folders = channel_folders.get_channel_folders().map((folder) => ({
        id: folder.id,
        name: folder.name,
        selected: folder.id === preselected_folder_id,
    }));
    return {
        can_create_public,
        can_create_private,
        // Public is the default, as in Slack, unless the user may only
        // create private channels.
        invite_only: !can_create_public,
        has_folders: folders.length > 0,
        folders,
        max_stream_name_length: realm.max_stream_name_length,
        max_stream_description_length: realm.max_stream_description_length,
    };
}

// Upstream's conflict message, as plain text: its link would change
// the hash, which closes any open modal. The modal offers its own
// way to the existing channel instead.
export function conflict(sub: StreamSubscription | undefined): NameCheck {
    const check: NameCheck = {
        valid: false,
        error_html: render_channel_name_conflict_error({
            stream_id: sub?.stream_id,
            is_archived: sub?.is_archived ?? false,
            show_rename: false,
            can_view_channel: false,
        }),
    };
    if (sub !== undefined && !sub.is_archived) {
        check.existing_stream_id = sub.stream_id;
    }
    return check;
}

// Checked on every keystroke, so a name that is already taken is
// reported before the user fills in the rest. An empty name only
// keeps the button disabled; the length is capped by the input. The
// client knows public channels and its own private ones; the server
// is asked again right before the request.
export function check_name(raw_name: string): NameCheck {
    const name = raw_name.trim();
    if (name === "") {
        return {valid: false};
    }
    const sub = stream_data.get_sub(name);
    if (sub === undefined) {
        return {valid: true};
    }
    return conflict(sub);
}

// Whether GET /json/streams (public channels and the user's own) lists
// the name. Names are unique regardless of case on the server.
export function name_taken_on_server(name: string, response: unknown): boolean {
    const parsed = streams_response_schema.safeParse(response);
    if (!parsed.success) {
        return false;
    }
    const wanted = name.trim().toLowerCase();
    return parsed.data.streams.some((stream) => stream.name.toLowerCase() === wanted);
}

// What the creation response says happened to the name: subscribed
// (created, or joined an existing channel; the subscription event
// tells which), already subscribed, or neither.
export function response_conflict(response: unknown, name: string): ResponseConflict | undefined {
    const parsed = subscribe_response_schema.safeParse(response);
    if (!parsed.success) {
        return "not_subscribed";
    }
    const wanted = name.trim().toLowerCase();
    const lists = (names: Record<string, string[]>): boolean =>
        Object.values(names).some((list) => list.some((n) => n.toLowerCase() === wanted));
    if (lists(parsed.data.already_subscribed)) {
        return "already_subscribed";
    }
    if (!lists(parsed.data.subscribed)) {
        return "not_subscribed";
    }
    return undefined;
}

export function create_request_data(params: CreateParams): Record<string, string> {
    const data: Record<string, string> = {
        subscriptions: JSON.stringify([{name: params.name, description: params.description}]),
        invite_only: JSON.stringify(params.invite_only),
        announce: JSON.stringify(false),
    };
    if (params.folder_id !== undefined) {
        data["folder_id"] = JSON.stringify(params.folder_id);
    }
    return data;
}

export function add_request_data(name: string, principals: number[]): Record<string, string> {
    return {
        subscriptions: JSON.stringify([{name}]),
        principals: JSON.stringify(principals),
    };
}

export function leave_request_data(name: string): Record<string, string> {
    return {subscriptions: JSON.stringify([name])};
}

export function add_people_title(name: string): string {
    return $t({defaultMessage: "Add people to #{name}"}, {name});
}

// "Everyone" means the organization's members: active humans who are
// not guests, and not the creator, who is subscribed already.
export function everyone_user_ids(): number[] {
    return people
        .get_realm_active_human_user_ids()
        .filter(
            (user_id) =>
                user_id !== current_user.user_id && !people.get_by_user_id(user_id).is_guest,
        );
}

export function everyone_count(): number {
    return everyone_user_ids().length;
}

export function can_add_everyone(invite_only: boolean): boolean {
    return !invite_only && everyone_count() <= ADD_EVERYONE_LIMIT;
}

// An empty result means there is nobody to add and no request to send.
export function principals_to_add({
    add_everyone,
    pill_user_ids,
}: {
    add_everyone: boolean;
    pill_user_ids: number[];
}): number[] {
    if (add_everyone) {
        return everyone_user_ids();
    }
    return [...new Set(pill_user_ids)].filter((user_id) => user_id !== current_user.user_id);
}

function clear_pending(): void {
    if (pending?.expiry !== undefined) {
        clearTimeout(pending.expiry);
    }
    pending = undefined;
}

export function begin_creation(name: string, on_conflict: (sub: StreamSubscription) => void): void {
    clear_pending();
    pending = {name, stream_id: undefined, modal_closed: false, on_conflict, expiry: undefined};
}

export function abandon_creation(): void {
    clear_pending();
}

// True from begin_creation until the creation was abandoned, turned
// out to be a conflict, or ended in the navigation.
export function is_creating(name: string): boolean {
    return pending !== undefined && pending.name.toLowerCase() === name.trim().toLowerCase();
}

function maybe_navigate(creation: PendingCreation): void {
    if (creation.stream_id === undefined || !creation.modal_closed) {
        return;
    }
    clear_pending();
    browser_history.go_to_location(hash_util.channel_url_by_user_setting(creation.stream_id));
}

// Called for every subscription the user gains; only the one whose
// name was just submitted here is of interest. A channel somebody
// else created is one the request joined instead of creating.
export function on_subscribed(sub: StreamSubscription): void {
    if (
        pending === undefined ||
        pending.stream_id !== undefined ||
        sub.name.toLowerCase() !== pending.name.toLowerCase()
    ) {
        return;
    }
    if (sub.creator_id !== current_user.user_id) {
        const {on_conflict} = pending;
        clear_pending();
        on_conflict(sub);
        return;
    }
    pending.stream_id = sub.stream_id;
    maybe_navigate(pending);
}

// Skipping, finishing, Escape and the close button all end here. If
// the event has not arrived yet, it is waited for a little longer.
export function on_modal_closed(): void {
    if (pending === undefined) {
        return;
    }
    pending.modal_closed = true;
    if (pending.stream_id !== undefined) {
        maybe_navigate(pending);
        return;
    }
    pending.expiry = setTimeout(() => {
        pending = undefined;
    }, PENDING_TIMEOUT_MS);
}

export function clear_for_testing(): void {
    clear_pending();
}
