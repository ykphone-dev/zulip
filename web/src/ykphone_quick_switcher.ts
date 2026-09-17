// The data side of Slack's ⌘K "Jump to…" switcher for the 옆커폰 fork:
// every place the user can go (channels, direct message conversations,
// people, the threads they take part in and the fork's pages), ranked
// against what they type. With nothing typed it lists where they were
// most recently. The modal lives in ykphone_quick_switcher_ui.ts.

import * as channel from "./channel.ts";
import {$t} from "./i18n.ts";
import {page_params} from "./page_params.ts";
import * as people from "./people.ts";
import * as pm_conversations from "./pm_conversations.ts";
import * as stream_data from "./stream_data.ts";
import * as stream_list_sort from "./stream_list_sort.ts";
import * as ykphone_places from "./ykphone_places.ts";
import type {PageId, Place, PlaceView} from "./ykphone_places.ts";
import * as ykphone_recents from "./ykphone_recents.ts";
import * as ykphone_split_view from "./ykphone_split_view.ts";
import type {ThreadRow} from "./ykphone_split_view.ts";

export const MAX_RESULTS = 20;
export const MAX_RECENT_RESULTS = 10;
// The candidates (every channel, conversation, person, thread and page,
// described) are built once and kept, rather than on every keystroke:
// describing the realm's people alone is thousands of calls. They are
// dropped when the user navigates (ykphone_ui_hooks, the split pages)
// and when the threads answer, and in any case after this long.
const CANDIDATES_MAX_AGE_MS = 60_000;
// The user's threads are asked for when the switcher opens, at most
// this often: threads/mine is a heavy aggregate on the server.
const THREADS_MAX_AGE_MS = 30_000;

const PAGES: PageId[] = [
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
];

export type SwitcherItem = PlaceView & {
    // What kind of place it is, in a word, beside its name; pages
    // need none.
    kind_label: string | undefined;
    // Pages are the only places that do not record themselves as a
    // narrow, so the row carries the page for the visit history.
    page: PageId | undefined;
};

type Candidate = {
    item: SwitcherItem;
    // Other texts a query is matched against, below the place's own
    // name: a group's members, a thread's first message.
    other_names: string[];
};

// ---- Threads ----

let fetched_threads: {threads: ThreadRow[]; at: number} | undefined;

// The threads page may already hold the user's threads; the switcher
// asks for its own copy, so that a thread joined since shows.
export function known_threads(): ThreadRow[] | undefined {
    return fetched_threads?.threads ?? ykphone_split_view.get_thread_rows();
}

export function load_threads(on_loaded: () => void, now = Date.now()): void {
    if (
        // A spectator has no threads of their own, and the request
        // would send them to the login page.
        page_params.is_spectator ||
        (fetched_threads !== undefined && now - fetched_threads.at < THREADS_MAX_AGE_MS)
    ) {
        return;
    }
    void channel.get({
        url: "/json/ykphone/threads/mine",
        success(raw_data) {
            fetched_threads = {
                threads: ykphone_split_view.threads_response_schema.parse(raw_data).threads,
                at: now,
            };
            invalidate();
            on_loaded();
        },
        // Without the threads the switcher still finds everything else.
    });
}

export function clear_for_testing(): void {
    fetched_threads = undefined;
    invalidate();
}

// ---- Candidates ----

function candidate(
    place: Place,
    kind_label: string | undefined,
    other_names: string[],
): Candidate[] {
    const view = ykphone_places.describe(place);
    if (view === undefined) {
        return [];
    }
    const page = place.kind === "page" ? place.page : undefined;
    return [{item: {...view, kind_label, page}, other_names}];
}

function kind_label(place: Place): string | undefined {
    switch (place.kind) {
        case "channel":
            return $t({defaultMessage: "Channel"});
        case "dm":
            return $t({defaultMessage: "Direct message"});
        case "thread":
            return $t({defaultMessage: "Thread"});
    }
    // Pages need none.
    return undefined;
}

function all_candidates(): Candidate[] {
    const place_candidate = (place: Place, other_names: string[] = []): Candidate[] =>
        candidate(place, kind_label(place), other_names);
    const candidates = [
        ...stream_data
            .subscribed_subs()
            .filter((sub) => !sub.is_archived)
            .flatMap((sub) => place_candidate(ykphone_places.channel_place(sub.stream_id))),
        ...pm_conversations.recent.get().flatMap(({user_ids_string}) => {
            const user_ids = user_ids_string.split(",").map(Number);
            return place_candidate(
                ykphone_places.dm_place(user_ids),
                // Each person's own name, so that a group is found by
                // any of its members.
                people.is_valid_user_ids(user_ids)
                    ? people.get_users_from_ids(user_ids).map((user) => user.full_name)
                    : [],
            );
        }),
        ...people
            .get_realm_active_human_users()
            .flatMap((user) => place_candidate(ykphone_places.dm_place([user.user_id]))),
        ...(known_threads() ?? []).flatMap((row) =>
            place_candidate({kind: "thread", stream_id: row.stream_id, topic: row.topic_name}, [
                row.root_snippet,
            ]),
        ),
        ...PAGES.flatMap((page) => place_candidate(ykphone_places.page_place(page))),
    ];
    // A person with a conversation already listed is that conversation.
    const seen = new Set<string>();
    return candidates.filter(({item}) => {
        if (seen.has(item.key)) {
            return false;
        }
        seen.add(item.key);
        return true;
    });
}

type Candidates = {
    list: Candidate[];
    // Where each place sits in the visit history, for ranking ties.
    recent: Map<string, number>;
    at: number;
};

let cached_candidates: Candidates | undefined;

// Called when what the switcher could offer changes: a narrow (a new
// conversation, a new position in the history), a split page, the
// threads answering.
export function invalidate(): void {
    cached_candidates = undefined;
}

function candidates(now: number): Candidates {
    if (cached_candidates === undefined || now - cached_candidates.at > CANDIDATES_MAX_AGE_MS) {
        cached_candidates = {
            list: all_candidates(),
            recent: new Map(
                ykphone_recents
                    .recent_entries()
                    .map((entry, index) => [ykphone_places.place_key(entry.place), index]),
            ),
            at: now,
        };
    }
    return cached_candidates;
}

// ---- Matching ----

const WORD_SEPARATORS = /[\s#·,./:_()-]+/u;

// How well one typed word matches a name: 0 for the whole name, then
// the start of the name, the start of a word in it, anywhere in it,
// and (with fuzzy) its letters in order from the start of a word, as
// "vrn" for Verona; undefined for no match.
export function word_rank(word: string, name: string, fuzzy = true): number | undefined {
    const text = name.toLowerCase();
    if (text === word) {
        return 0;
    }
    if (text.startsWith(word)) {
        return 1;
    }
    const words = text.split(WORD_SEPARATORS);
    if (words.some((part) => part.startsWith(word))) {
        return 2;
    }
    if (text.includes(word)) {
        return 3;
    }
    if (!fuzzy) {
        return undefined;
    }
    // Matched as UTF-16 text, like the checks above; a Hangul syllable
    // is one unit.
    const first = word.slice(0, 1);
    const rest = word.slice(1);
    return words.some((part, index) => {
        if (!part.startsWith(first)) {
            return false;
        }
        const after = words.slice(index).join(" ").slice(1);
        let position = 0;
        for (const character of rest) {
            position = after.indexOf(character, position);
            if (position === -1) {
                return false;
            }
            position += character.length;
        }
        return true;
    })
        ? 4
        : undefined;
}

// Every typed word must match the name or one of the other names; the
// rank is the sum of each word's best rank. A match in another name
// (a group's member, a thread's first message) counts one step lower
// than the same match in the name, and is never fuzzy: long texts
// match almost any letters in order. A leading "#" or "@" is dropped,
// since that is how channels and people are written.
export function query_rank(
    query: string,
    name: string,
    other_names: string[] = [],
): number | undefined {
    let total = 0;
    for (const typed of query.toLowerCase().split(/\s+/u).filter(Boolean)) {
        // Users type the sigils they see: "#devel", "@othello".
        const word = /^[#@]./u.test(typed) ? typed.slice(1) : typed;
        const ranks = [
            word_rank(word, name),
            ...other_names.map((other_name) => {
                const rank = word_rank(word, other_name, false);
                return rank === undefined ? undefined : rank + 1;
            }),
        ].filter((rank) => rank !== undefined);
        if (ranks.length === 0) {
            return undefined;
        }
        total += Math.min(...ranks);
    }
    return total;
}

// ---- Results ----

// With nothing typed: the places visited most recently other than the
// one on screen, then the sidebar's channels, up to MAX_RECENT_RESULTS.
function recent_results(current: Place | undefined, now: number): SwitcherItem[] {
    const current_key = current === undefined ? undefined : ykphone_places.place_key(current);
    const by_key = new Map(candidates(now).list.map(({item}) => [item.key, item]));
    const keys = [
        ...ykphone_recents.recent_entries().map((entry) => ykphone_places.place_key(entry.place)),
        ...stream_list_sort
            .get_stream_ids()
            .map((stream_id) => ykphone_places.place_key(ykphone_places.channel_place(stream_id))),
    ];
    const items: SwitcherItem[] = [];
    for (const key of new Set(keys)) {
        const item = by_key.get(key);
        if (item !== undefined && key !== current_key) {
            items.push(item);
        }
    }
    return items.slice(0, MAX_RECENT_RESULTS);
}

export function results(
    query: string,
    current: Place | undefined,
    now = Date.now(),
): SwitcherItem[] {
    if (query.trim() === "") {
        return recent_results(current, now);
    }
    const {list, recent} = candidates(now);
    return list
        .flatMap(({item, other_names}) => {
            const rank = query_rank(query, item.title, other_names);
            return rank === undefined ? [] : [{item, rank}];
        })
        .toSorted(
            (a, b) =>
                a.rank - b.rank ||
                // Among equal matches, the places visited most recently
                // first, then by name.
                (recent.get(a.item.key) ?? Number.POSITIVE_INFINITY) -
                    (recent.get(b.item.key) ?? Number.POSITIVE_INFINITY) ||
                a.item.title.localeCompare(b.item.title),
        )
        .slice(0, MAX_RESULTS)
        .map(({item}) => item);
}
