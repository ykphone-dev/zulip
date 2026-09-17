// The places the user visited most recently, newest first, for the
// 옆커폰 fork's History dropdown, its Home (the last conversation) and
// the quick switcher's list before anything is typed.
//
// Slack keeps this history across sessions, so it lives in
// localStorage under the user's id (several accounts can share a
// browser). It is read back on every use rather than cached, so that
// two open tabs add to one history instead of overwriting each other.

import * as z from "zod/mini";

import type {Filter} from "./filter.ts";
import {localstorage} from "./localstorage.ts";
import {page_params} from "./page_params.ts";
import {current_user} from "./state_data.ts";
import * as ykphone_places from "./ykphone_places.ts";
import type {Place} from "./ykphone_places.ts";

export const MAX_RECENT_PLACES = 20;

const recent_entry_schema = z.object({
    place: ykphone_places.place_schema,
    // Milliseconds since the epoch.
    visited_at: z.number(),
});

export type RecentEntry = z.infer<typeof recent_entry_schema>;

function storage_key(): string {
    return `ykphone-recent-places-${current_user.user_id}`;
}

export function recent_entries(): RecentEntry[] {
    const stored = localstorage().get(storage_key());
    if (!Array.isArray(stored)) {
        return [];
    }
    // One unreadable entry (from an older version, or edited by hand)
    // is skipped rather than losing the whole history.
    const entries: RecentEntry[] = [];
    for (const item of stored) {
        const parsed = recent_entry_schema.safeParse(item);
        if (parsed.success) {
            entries.push(parsed.data);
        }
    }
    return entries;
}

export function note_visit(place: Place, visited_at = Date.now()): void {
    const key = ykphone_places.place_key(place);
    const entries = [
        {place, visited_at},
        ...recent_entries().filter((entry) => ykphone_places.place_key(entry.place) !== key),
    ].slice(0, MAX_RECENT_PLACES);
    localstorage().set(storage_key(), entries);
}

// Called for every narrow (through ykphone_ui_hooks); the split pages
// note themselves when they open.
export function note_narrow(filter: Filter | undefined): void {
    if (filter === undefined || page_params.is_spectator) {
        return;
    }
    const place = ykphone_places.place_for_filter(filter);
    if (place !== undefined) {
        note_visit(place);
    }
}
