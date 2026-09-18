// The Slack-style search results page of the 옆커폰 fork: the data side.
//
// Pressing Enter in the navbar search opens #ykphone/search/<query>,
// which is the round-11 split-pane shell with the result list on the
// left and the message the user clicks on the right. This module holds
// everything that can be decided without the DOM: the hash, the query
// (a Zulip search string) and the narrows it stands for, the four tabs,
// the filter bar and the sort, the rows of each tab and the
// highlighting of the matched words.
//
// Zulip's search is chronological, so the sort offers 최신순 and
// 오래된순 only; there is no relevance ranking to offer.

import * as z from "zod/mini";

import * as channel from "./channel.ts";
import {Filter} from "./filter.ts";
import {$t} from "./i18n.ts";
import type {RawMessage} from "./message_store.ts";
import {raw_message_schema} from "./message_store.ts";
import * as people from "./people.ts";
import type {NarrowCanonicalTerm, NarrowTerm, NarrowTermSuggestion} from "./state_data.ts";
import * as stream_data from "./stream_data.ts";
import * as timerender from "./timerender.ts";
import * as ykphone_activity from "./ykphone_activity.ts";
import type {FileFilters, FilterOption} from "./ykphone_files.ts";
import {NO_FILE_FILTERS} from "./ykphone_files.ts";
import * as ykphone_highlight from "./ykphone_highlight.ts";

export type SearchTab = "messages" | "files" | "channels" | "people";
export const SEARCH_TABS: SearchTab[] = ["messages", "files", "channels", "people"];

export type SortOrder = "newest" | "oldest";
export type DateRange = "any" | "today" | "week" | "month" | "year";

// As many results as one request brings; a count that reaches it is
// shown as "N+" because Zulip's API has no total.
export const MAX_RESULTS = 100;
const SNIPPET_LENGTH = 160;
const ELLIPSIS = "…";
// Characters of context kept before the first matched word.
const SNIPPET_LEAD = 40;

export function tab_label(tab: SearchTab): string {
    const labels: Record<SearchTab, string> = {
        messages: $t({defaultMessage: "Messages"}),
        files: $t({defaultMessage: "Files"}),
        channels: $t({defaultMessage: "Channels"}),
        people: $t({defaultMessage: "People"}),
    };
    return labels[tab];
}

export function is_search_tab(value: string | undefined): value is SearchTab {
    const tabs: readonly (string | undefined)[] = SEARCH_TABS;
    return tabs.includes(value);
}

// ---- The query in the hash ----

// The query is a Zulip search string, so it holds spaces and may hold
// a slash inside a channel name or a word. encodeURIComponent keeps
// the hash one component; "+" for a space matches how Zulip writes
// operands into hashes.
export function encode_query(query: string): string {
    try {
        return encodeURIComponent(query.trim()).replaceAll("%20", "+");
    } catch {
        // A lone surrogate (pasteable) cannot be percent-encoded; the
        // page then opens on an empty query rather than throwing.
        return "";
    }
}

export function decode_query(part: string): string {
    try {
        return decodeURIComponent(part.replaceAll("+", " "));
    } catch {
        // A hand-edited hash with a stray "%" is taken literally.
        return part.replaceAll("+", " ");
    }
}

// ---- The query as search terms ----

export function query_terms(query: string): NarrowCanonicalTerm[] | undefined {
    const terms: NarrowCanonicalTerm[] = [];
    for (const suggestion of Filter.parse(query)) {
        const term = Filter.convert_suggestion_to_term(suggestion);
        if (term === undefined) {
            return undefined;
        }
        terms.push(term);
    }
    return terms.length === 0 ? undefined : terms;
}

export function query_from_terms(terms: NarrowTerm[]): string {
    return Filter.unparse(terms).trim();
}

// The narrow the Files tab searches: the same query with a file
// filter, unless it already has one.
export function files_terms(terms: NarrowCanonicalTerm[]): NarrowCanonicalTerm[] {
    if (terms.some((term) => term.operator === "has" && term.operand === "attachment")) {
        return terms;
    }
    return [...terms, {operator: "has", operand: "attachment"}];
}

// The words the search looks for, for the client-side highlighting of
// a file name or a channel description.
export function search_words(query: string): string[] {
    return Filter.parse(query)
        .filter((term) => term.operator === "search")
        .flatMap((term) => term.operand.split(/\s+/))
        .filter((word) => word !== "");
}

// ---- Editing the query from the filter bar ----

function unparse(terms: NarrowTermSuggestion[]): string {
    return Filter.unparse(terms).trim();
}

// Replaces every term with this operator, or drops them when the
// operand is undefined. The filter bar's dropdowns edit the query this
// way, so the page's URL always says what is being searched.
export function query_with_operator(
    query: string,
    operator: NarrowTerm["operator"],
    operand: string | undefined,
): string {
    const kept = Filter.parse(query).filter((term) => term.operator !== operator);
    if (operand === undefined) {
        return unparse(kept);
    }
    // A search term stays last so the query still reads as one line.
    const words = kept.filter((term) => term.operator === "search");
    const filters = kept.filter((term) => term.operator !== "search");
    return unparse([...filters, {operator, operand, negated: false}, ...words]);
}

export function operand_for(query: string, operator: NarrowTerm["operator"]): string | undefined {
    return Filter.parse(query).find((term) => term.operator === operator)?.operand;
}

export function has_operand(query: string, operator: string, operand: string): boolean {
    return Filter.parse(query).some(
        (term) => term.operator === operator && term.operand === operand,
    );
}

export function query_with_has_attachment(query: string, wanted: boolean): string {
    if (wanted) {
        return query_with_operator(query, "has", "attachment");
    }
    return unparse(
        Filter.parse(query).filter(
            (term) => !(term.operator === "has" && term.operand === "attachment"),
        ),
    );
}

// ---- Highlighting ----

// The server marks the words a search matched in match_content with
// <span class="highlight"> (zerver/views/message_fetch.py). The marks
// are lifted out of the HTML, each piece between them is flattened to
// text on its own, and the result leaves as runs — never as markup —
// so a message body can neither forge a mark nor close one. A match
// the server wrapped around markup of its own (a highlighted word
// inside a code span) ends at the first </span>, so the mark can be
// shorter than the match; the words around it are still shown.
const HIGHLIGHT_MARKUP = /<span class="highlight">(.*?)<\/span>/gis;

// Collapses the whitespace of a flattened message across the pieces
// the marks cut it into, carrying each character's mark with it.
function collapse(text: string, marks: boolean[]): {text: string; marks: boolean[]} {
    let out = "";
    const out_marks: boolean[] = [];
    let after_space = true;
    // One mark per UTF-16 code unit of the text.
    for (const [index, mark] of marks.entries()) {
        const character = text[index]!;
        if (character === " ") {
            if (!after_space) {
                out += " ";
                out_marks.push(mark);
            }
            after_space = true;
            continue;
        }
        out += character;
        out_marks.push(mark);
        after_space = false;
    }
    if (out.endsWith(" ")) {
        out = out.slice(0, -1);
        out_marks.pop();
    }
    return {text: out, marks: out_marks};
}

// One line of a result, cut around the first matched word with an
// ellipsis on the side that was cut.
export function highlighted_runs(
    html: string,
    max_length = SNIPPET_LENGTH,
): ykphone_highlight.HighlightRun[] {
    // A split on a pattern with one group alternates the pieces
    // outside the marks with the pieces inside them.
    const pieces = html.split(HIGHLIGHT_MARKUP);
    let flat = "";
    const flat_marks: boolean[] = [];
    for (const [index, piece] of pieces.entries()) {
        const piece_text = ykphone_highlight.plain_text(piece);
        flat += piece_text;
        flat_marks.push(...Array.from({length: piece_text.length}, () => index % 2 === 1));
    }
    const {text, marks} = collapse(flat, flat_marks);
    const first_mark = marks.indexOf(true);
    // The words kept before the first match for context, never so many
    // that the match itself falls outside the line.
    const lead = Math.min(SNIPPET_LEAD, Math.floor(max_length / 4));
    const start = first_mark > lead ? first_mark - lead : 0;
    const runs = ykphone_highlight.runs_from_marks(
        text.slice(start, start + max_length),
        marks.slice(start, start + max_length),
    );
    return [
        ...(start > 0 ? ykphone_highlight.plain_runs(ELLIPSIS) : []),
        ...runs,
        ...(start + max_length < text.length ? ykphone_highlight.plain_runs(ELLIPSIS) : []),
    ];
}

// ---- Rows ----

export type MessageRowContext = {
    message_id: number;
    url: string;
    avatar_url: string;
    sender_name: string;
    context_label: string;
    snippet: ykphone_highlight.HighlightRun[];
    time_label: string;
    is_active: boolean;
};

export type PlaceRowContext = {
    selection: string;
    url: string;
    label: ykphone_highlight.HighlightRun[];
    description: string;
    icon: string;
    avatar_url: string | undefined;
    is_active: boolean;
};

function within_range(timestamp: number, range: DateRange, now: number): boolean {
    if (range === "any") {
        return true;
    }
    const days: Record<Exclude<DateRange, "any">, number> = {
        today: 1,
        week: 7,
        month: 30,
        year: 365,
    };
    return now / 1000 - timestamp <= days[range] * 24 * 60 * 60;
}

// The date range is the one filter Zulip has no operator for, so it is
// applied to the messages the search brought back rather than to the
// search itself.
export function filter_by_date<Item extends {timestamp: number}>(
    items: Item[],
    range: DateRange,
    now = Date.now(),
): Item[] {
    return items.filter((item) => within_range(item.timestamp, range, now));
}

export function sort_messages(messages: RawMessage[], order: SortOrder): RawMessage[] {
    return messages.toSorted((a, b) =>
        order === "newest"
            ? b.timestamp - a.timestamp || b.id - a.id
            : a.timestamp - b.timestamp || a.id - b.id,
    );
}

export function message_rows(
    messages: RawMessage[],
    opts: {selection: string | undefined; hash_for: (selection: string) => string},
): MessageRowContext[] {
    return messages.map((message) => {
        const sender = people.maybe_get_user_by_id(message.sender_id, true);
        const selection = message.id.toString();
        return {
            message_id: message.id,
            url: opts.hash_for(selection),
            avatar_url:
                sender === undefined
                    ? `/avatar/${message.sender_id}`
                    : people.small_avatar_url_for_person(sender),
            sender_name: message.sender_full_name,
            context_label: ykphone_activity.context_label(message),
            snippet: highlighted_runs(message.match_content ?? message.content),
            time_label: timerender.relative_time_string_from_date(
                new Date(message.timestamp * 1000),
            ),
            is_active: opts.selection === selection,
        };
    });
}

export function message_selection(id: number): string {
    return id.toString();
}

export function channel_selection(stream_id: number): string {
    return `c${stream_id}`;
}

export function person_selection(user_id: number): string {
    return `u${user_id}`;
}

export function parse_selection(
    selection: string,
): {kind: "message" | "channel" | "person"; id: number} | undefined {
    const kind = selection.startsWith("c")
        ? "channel"
        : selection.startsWith("u")
          ? "person"
          : "message";
    const id = Number.parseInt(kind === "message" ? selection : selection.slice(1), 10);
    return Number.isNaN(id) ? undefined : {kind, id};
}

// Channels the user can open whose name or description matches the
// query's words; the Channels tab is answered from the client's own
// data, as Slack's is.
// Channels the user can open or join whose name or description
// matches the query's words, and the people it matches. Both tabs are
// answered from the client's own data, as Slack's are; with no words
// to match they show an empty state rather than the whole directory.
export function channel_rows(
    words: string[],
    opts: {selection: string | undefined; hash_for: (selection: string) => string},
): PlaceRowContext[] {
    if (words.length === 0) {
        return [];
    }
    const needle = words.join(" ").toLowerCase();
    return stream_data
        .get_unsorted_subs()
        .filter(
            (sub) =>
                !sub.is_archived &&
                // A channel the user could join counts: looking one up
                // is what Slack's Channels tab is for.
                (sub.subscribed || !sub.invite_only) &&
                (sub.name.toLowerCase().includes(needle) ||
                    sub.description.toLowerCase().includes(needle)),
        )
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((sub) => {
            const selection = channel_selection(sub.stream_id);
            return {
                selection,
                url: opts.hash_for(selection),
                label: ykphone_highlight.highlight_words(`#${sub.name}`, words),
                description: sub.description,
                icon: sub.invite_only ? "lock" : sub.is_web_public ? "globe" : "hashtag",
                avatar_url: undefined,
                is_active: opts.selection === selection,
            };
        });
}

export function people_rows(
    words: string[],
    opts: {selection: string | undefined; hash_for: (selection: string) => string},
): PlaceRowContext[] {
    if (words.length === 0) {
        return [];
    }
    const needle = words.join(" ").toLowerCase();
    return (
        people
            // The same list however much is typed: people of this
            // organization, no bots, whoever happens to be in the message
            // cache.
            .get_realm_active_human_users()
            .filter((person) => person.full_name.toLowerCase().includes(needle))
            .toSorted((a, b) => a.full_name.localeCompare(b.full_name))
            .map((person) => {
                const selection = person_selection(person.user_id);
                return {
                    selection,
                    url: opts.hash_for(selection),
                    label: ykphone_highlight.highlight_words(person.full_name, words),
                    // An email address here would be the synthetic one in
                    // an organization that hides addresses.
                    description: "",
                    icon: "user",
                    avatar_url: people.small_avatar_url_for_person(person),
                    is_active: opts.selection === selection,
                };
            })
    );
}

// ---- Counts ----

// Zulip's message API answers with messages, not with a total, so a
// count the fork could not finish reading is shown as "N+" — including
// when a date range cut a full page down to a few rows.
export function count_label(count: number, complete: boolean): string {
    return complete ? count.toString() : `${count}+`;
}

// ---- The selection's narrow ----

export function selection_terms(
    selection: string,
    messages: RawMessage[],
): NarrowTerm[] | undefined {
    const parsed = parse_selection(selection);
    if (parsed === undefined) {
        return undefined;
    }
    if (parsed.kind === "channel") {
        if (stream_data.get_sub_by_id(parsed.id) === undefined) {
            return undefined;
        }
        return [
            {operator: "channel", operand: parsed.id.toString()},
            {operator: "topic", operand: ""},
        ];
    }
    if (parsed.kind === "person") {
        if (!people.is_valid_user_ids([parsed.id])) {
            return undefined;
        }
        return [{operator: "dm", operand: [parsed.id]}];
    }
    const message = messages.find((candidate) => candidate.id === parsed.id);
    return message === undefined ? undefined : ykphone_activity.message_terms(message);
}

// ---- What the search bar's contents mean ----

// In this fork a query is not run until it is finished: picking a
// filter from the dropdown only adds it to the search bar ("hold" —
// the middle pane stays where it is), and a finished query — words
// typed and chosen — opens the results page. Without the fork's
// dropdown the search bar is upstream's, narrow and all.
export type SearchBarAction = "open" | "hold" | "upstream";

export function search_bar_action(opts: {
    enabled: boolean;
    finished: boolean;
    query: string;
}): SearchBarAction {
    if (!opts.enabled) {
        return "upstream";
    }
    return opts.finished && opts.query !== "" ? "open" : "hold";
}

// ---- The page's state ----

// The results of the query the page is showing. Both tabs are fetched
// when the page opens, so the tab counts are known before a tab is
// opened. The sort and the date range are not kept here: they are part
// of the route (the page owns its URL), and only the file facets,
// which name one result set, are the module's own state.
export type SearchResults = {
    query: string;
    sort: SortOrder;
    range: DateRange;
    messages: RawMessage[];
    files: RawMessage[];
    // Whether the fetch reached the end of the history, so a count is
    // the whole count and not "N+".
    messages_complete: boolean;
    files_complete: boolean;
};

let results: SearchResults | undefined;
let loading = false;
let load_failed = false;
// A query Zulip cannot read (a channel name or an email where an id
// belongs, usually from a hand-edited or shared URL): the page says so
// rather than reporting "no results" for a search it never ran.
let query_invalid = false;
let load_generation = 0;
let file_filters: FileFilters = NO_FILE_FILTERS;
// The senders and channels the filter bar offers: the results of this
// query without its own sender/channel filter, so that a second choice
// is possible ("Zoe" → "Hamlet") without going back to "everyone"
// first.
let facet_source: {base: string; messages: RawMessage[]} | undefined;

export function get_results(): SearchResults | undefined {
    return results;
}

export function is_loading(): boolean {
    return loading;
}

export function has_failed(): boolean {
    return load_failed;
}

export function is_query_invalid(): boolean {
    return query_invalid;
}

export function get_file_filters(): FileFilters {
    return file_filters;
}

export function set_file_filters(filters: FileFilters): void {
    file_filters = filters;
}

// The file facets name the senders and channels of one result set, so
// a new query starts them over.
export function reset_facets(): void {
    file_filters = NO_FILE_FILTERS;
}

export function clear_for_testing(): void {
    results = undefined;
    loading = false;
    load_failed = false;
    query_invalid = false;
    load_generation = 0;
    file_filters = NO_FILE_FILTERS;
    facet_source = undefined;
}

// The query without the filters the bar writes, which is what its
// dropdowns list the choices of.
export function base_query(query: string): string {
    return query_with_operator(
        query_with_operator(query, "sender", undefined),
        "channel",
        undefined,
    );
}

export function facet_messages(query: string): RawMessage[] {
    if (facet_source?.base === base_query(query)) {
        return facet_source.messages;
    }
    return results?.query === query ? results.messages : [];
}

const messages_response_schema = z.object({
    messages: z.array(raw_message_schema),
    found_oldest: z.optional(z.boolean()),
    found_newest: z.optional(z.boolean()),
});

// The API reads a channel operand that is a string as a channel
// *name*; the id has to go out as a number (upstream's message_fetch
// converts the same way before every fetch).
function api_narrow(terms: NarrowCanonicalTerm[]): string {
    return JSON.stringify(
        terms.map((term) =>
            term.operator === "channel" ? {...term, operand: Number(term.operand)} : term,
        ),
    );
}

function fetch_terms(
    terms: NarrowCanonicalTerm[],
    newest_first: boolean,
    on_loaded: (messages: RawMessage[], complete: boolean) => void,
    on_error: () => void,
): void {
    void channel.get({
        url: "/json/messages",
        data: {
            anchor: newest_first ? "newest" : "oldest",
            num_before: newest_first ? MAX_RESULTS : 0,
            num_after: newest_first ? 0 : MAX_RESULTS,
            narrow: api_narrow(terms),
            apply_markdown: true,
            client_gravatar: true,
            allow_empty_topic_name: true,
        },
        success(raw_data) {
            const data = messages_response_schema.parse(raw_data);
            const complete = (newest_first ? data.found_oldest : data.found_newest) ?? false;
            on_loaded(data.messages, complete);
        },
        error: on_error,
    });
}

// Fetches the messages and the files of one query, in two requests
// (Zulip searches messages; the Files tab is the same query with a
// file filter). A date range always reads the newest end of the
// history, whichever way the results are then ordered: reading the
// hundred *oldest* matches and keeping this week's would find nothing.
export function load(
    query: string,
    view: {sort: SortOrder; range: DateRange},
    on_change: () => void,
): void {
    load_generation += 1;
    const generation = load_generation;
    const terms = query_terms(query);
    load_failed = false;
    query_invalid = false;
    results = undefined;
    if (terms === undefined) {
        query_invalid = query.trim() !== "";
        loading = false;
        on_change();
        return;
    }
    loading = true;
    const newest_first = view.sort === "newest" || view.range !== "any";
    const loaded: {
        messages?: {messages: RawMessage[]; complete: boolean};
        files?: {messages: RawMessage[]; complete: boolean};
    } = {};
    const is_current = (): boolean => generation === load_generation;
    const settle = (): void => {
        if (loaded.messages === undefined || loaded.files === undefined) {
            return;
        }
        loading = false;
        results = {
            query,
            sort: view.sort,
            range: view.range,
            messages: loaded.messages.messages,
            files: loaded.files.messages,
            messages_complete: loaded.messages.complete,
            files_complete: loaded.files.complete,
        };
        const base = base_query(query);
        if (base === query.trim()) {
            // This search carries no filter of the bar's own, so its
            // senders and channels are the ones to offer.
            facet_source = {base, messages: loaded.messages.messages};
        } else if (facet_source?.base !== base) {
            facet_source = undefined;
        }
        on_change();
    };
    const fail = (): void => {
        // Both requests of one search can fail; the page says so once.
        if (!is_current() || load_failed) {
            return;
        }
        loading = false;
        load_failed = true;
        on_change();
    };
    fetch_terms(
        terms,
        newest_first,
        (messages, complete) => {
            if (!is_current()) {
                return;
            }
            loaded.messages = {messages, complete};
            settle();
        },
        fail,
    );
    fetch_terms(
        files_terms(terms),
        newest_first,
        (messages, complete) => {
            if (!is_current()) {
                return;
            }
            loaded.files = {messages, complete};
            settle();
        },
        fail,
    );
}

// ---- The filter bar ----

// The senders and channels of the query without the bar's own filters
// (facet_messages), so that one choice can be swapped for another and
// the list does not collapse to whatever was just picked. Picking one
// rewrites the query, which is what the page searches for again.
export function message_sender_options(messages: RawMessage[], query: string): FilterOption[] {
    const chosen = operand_for(query, "sender");
    const names = new Map<string, string>();
    for (const message of messages) {
        names.set(message.sender_id.toString(), message.sender_full_name);
    }
    return [
        {value: "", label: $t({defaultMessage: "Anyone"}), selected: chosen === undefined},
        ...[...names.entries()]
            .toSorted((a, b) => a[1].localeCompare(b[1]))
            .map(([user_id, name]) => ({
                value: user_id,
                label: name,
                selected: chosen === user_id,
            })),
    ];
}

export function message_channel_options(messages: RawMessage[], query: string): FilterOption[] {
    const chosen = operand_for(query, "channel");
    const stream_ids = new Set<number>();
    for (const message of messages) {
        if (message.type === "stream") {
            stream_ids.add(message.stream_id);
        }
    }
    return [
        {value: "", label: $t({defaultMessage: "All channels"}), selected: chosen === undefined},
        ...[...stream_ids]
            .map((stream_id) => ({
                stream_id,
                name: stream_data.get_sub_by_id(stream_id)?.name ?? stream_id.toString(),
            }))
            .toSorted((a, b) => a.name.localeCompare(b.name))
            .map(({stream_id, name}) => ({
                value: stream_id.toString(),
                label: `#${name}`,
                selected: chosen === stream_id.toString(),
            })),
    ];
}

export const DATE_RANGES: DateRange[] = ["any", "today", "week", "month", "year"];

export function date_range_label(range: DateRange): string {
    const labels: Record<DateRange, string> = {
        any: $t({defaultMessage: "Any date"}),
        today: $t({defaultMessage: "Past 24 hours"}),
        week: $t({defaultMessage: "Past 7 days"}),
        month: $t({defaultMessage: "Past 30 days"}),
        year: $t({defaultMessage: "Past year"}),
    };
    return labels[range];
}

export function date_options(range: DateRange): FilterOption[] {
    return DATE_RANGES.map((candidate) => ({
        value: candidate,
        label: date_range_label(candidate),
        selected: candidate === range,
    }));
}

export function is_date_range(value: string): value is DateRange {
    const ranges: readonly string[] = DATE_RANGES;
    return ranges.includes(value);
}

export function sort_options(order: SortOrder): FilterOption[] {
    return [
        {
            value: "newest",
            label: $t({defaultMessage: "Newest first"}),
            selected: order === "newest",
        },
        {
            value: "oldest",
            label: $t({defaultMessage: "Oldest first"}),
            selected: order === "oldest",
        },
    ];
}
