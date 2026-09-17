// Slack's DM, Activity, Threads and search results pages for the 옆커폰
// fork: the state and data of the split-pane shell.
//
// Each page is two columns inside the middle pane: a list on the left
// (this module's rows) and the selected conversation on the right,
// which is upstream's own message view for the narrow the selection
// stands for, or, while nothing is selected, a placeholder shown
// through the same show/hide protocol as the inbox. Reading, sending,
// reactions, the always-open composer and unread marking are therefore
// upstream's, untouched. The hashes are #ykphone/dms[/<user ids>],
// #ykphone/activity[/<tab>[/<message id>]],
// #ykphone/threads[/<root message id>] and
// #ykphone/search/<query>[/<tab>[/<result>]]. The DOM side lives in
// ykphone_split_view_ui.ts; the search page's own data (the query, the
// results, the filters) lives in ykphone_search.ts.

import assert from "minimalistic-assert";
import * as z from "zod/mini";

import * as buddy_data from "./buddy_data.ts";
import * as channel from "./channel.ts";
import {$t} from "./i18n.ts";
import type {Message, RawMessage} from "./message_store.ts";
import * as message_store from "./message_store.ts";
import {raw_message_schema} from "./message_store.ts";
import * as message_util from "./message_util.ts";
import * as people from "./people.ts";
import * as pm_conversations from "./pm_conversations.ts";
import type {NarrowTerm} from "./state_data.ts";
import {current_user, realm} from "./state_data.ts";
import * as stream_data from "./stream_data.ts";
import * as timerender from "./timerender.ts";
import * as unread from "./unread.ts";
import * as ykphone_activity from "./ykphone_activity.ts";
import type {ActivityItem, ActivityTab} from "./ykphone_activity.ts";
import * as ykphone_files from "./ykphone_files.ts";
import * as ykphone_search from "./ykphone_search.ts";
import type {DateRange, SearchTab, SortOrder} from "./ykphone_search.ts";
import * as ykphone_threads from "./ykphone_threads.ts";

export type SplitPage = "dms" | "activity" | "threads" | "search";

// The Activity page's filters and the search results page's tabs are
// the same row of chips in the list header.
export type SplitTab = ActivityTab | SearchTab;

export type SplitRoute = {
    page: SplitPage;
    // Pages without tabs carry "all".
    tab: SplitTab;
    // The list row shown on the right: a DM's user ids ("7" or "7,9"),
    // an activity item's message id, a thread's root message id, or a
    // search result (a message id, "c<channel id>", "u<user id>").
    selection: string | undefined;
    // The search results page only: the Zulip search string, and the
    // two view choices that belong in the URL with it.
    query?: string | undefined;
    sort?: SortOrder | undefined;
    range?: DateRange | undefined;
};

// The trigger of the narrows the shell activates; message_view's hook
// tells them apart from a narrow that leaves the page.
export const TRIGGER = "ykphone split";
// Below this width the list is the whole pane and a selection replaces
// it, as Slack's mobile layout does.
export const STACKED_MEDIA_QUERY = "(width < 900px)";
// Slack lists about this many recent conversations; older ones are
// reached through search.
const MAX_DM_CONVERSATIONS = 100;
const MAX_PEOPLE_RESULTS = 8;

let route: SplitRoute | undefined;
// Whether the "nothing selected" placeholder is the current view.
let placeholder_visible = false;
// The selection whose narrow is on the right (recorded when its narrow
// is requested), so that a re-render of the rows or a tab switch does
// not narrow to it again.
let shown_selection: {page: SplitPage; selection: string} | undefined;

export function get_route(): SplitRoute | undefined {
    return route;
}

export function is_open(): boolean {
    return route !== undefined;
}

export function set_route(new_route: SplitRoute | undefined): void {
    route = new_route;
}

export function is_placeholder_visible(): boolean {
    return placeholder_visible;
}

export function set_placeholder_visible(value: boolean): void {
    placeholder_visible = value;
}

export function note_shown_selection(current: SplitRoute | undefined): void {
    shown_selection =
        current?.selection === undefined
            ? undefined
            : {page: current.page, selection: current.selection};
}

export function is_narrow_shown_for(current: SplitRoute): boolean {
    return (
        !placeholder_visible &&
        shown_selection?.page === current.page &&
        shown_selection.selection === current.selection
    );
}

// A thread (a channel topic) is the conversation on the right of a
// split page: the composer and the pane header call it a thread.
export function is_thread_shown(): boolean {
    return (
        route?.selection !== undefined &&
        !placeholder_visible &&
        (route.page === "threads" || route.page === "activity" || route.page === "search")
    );
}

function non_empty(part: string | undefined): string | undefined {
    return part === undefined || part === "" ? undefined : part;
}

// The search page's sort and date range travel in the hash, so that a
// reload, a shared link and Back all show what the page showed. The
// segment is left out while both are the default, which is why
// anything that is not one is read as the selection instead.
const DEFAULT_VIEW_OPTIONS = "newest-any";

function view_options(route: {
    sort?: SortOrder | undefined;
    range?: DateRange | undefined;
}): string {
    return `${route.sort ?? "newest"}-${route.range ?? "any"}`;
}

function parse_view_options(
    part: string | undefined,
): {sort: SortOrder; range: DateRange} | undefined {
    const [sort, range] = (part ?? "").split("-");
    if ((sort !== "newest" && sort !== "oldest") || range === undefined) {
        return undefined;
    }
    return ykphone_search.is_date_range(range) ? {sort, range} : undefined;
}

// The components of the hash after "#ykphone".
export function parse_hash(parts: string[]): SplitRoute | undefined {
    const [section, ...rest] = parts;
    switch (section) {
        case "dms":
            return {page: "dms", tab: "all", selection: non_empty(rest[0])};
        case "threads":
            return {page: "threads", tab: "all", selection: non_empty(rest[0])};
        case "activity": {
            const tab = ykphone_activity.TABS.find((candidate) => candidate === rest[0]);
            if (tab === undefined) {
                return {page: "activity", tab: "all", selection: undefined};
            }
            return {page: "activity", tab, selection: non_empty(rest[1])};
        }
        case "search": {
            // #ykphone/search/<query>[/<tab>[/<sort>-<range>[/<result>]]]
            const query = ykphone_search.decode_query(rest[0] ?? "");
            const tab = ykphone_search.is_search_tab(rest[1]) ? rest[1] : "messages";
            const view = parse_view_options(rest[2]);
            return {
                page: "search",
                tab,
                selection: non_empty(view === undefined ? rest[2] : rest[3]),
                query,
                sort: view?.sort ?? "newest",
                range: view?.range ?? "any",
            };
        }
        default:
            return undefined;
    }
}

export function page_hash(
    page: SplitPage,
    opts: {
        tab?: SplitTab | undefined;
        selection?: string | undefined;
        query?: string | undefined;
        sort?: SortOrder | undefined;
        range?: DateRange | undefined;
    } = {},
): string {
    let hash = `#ykphone/${page}`;
    if (page === "search") {
        hash += `/${ykphone_search.encode_query(opts.query ?? "")}`;
        const options = view_options(opts);
        const named = options !== DEFAULT_VIEW_OPTIONS;
        if (opts.tab !== undefined || opts.selection !== undefined || named) {
            hash += `/${opts.tab ?? "messages"}`;
        }
        if (opts.selection !== undefined || named) {
            hash += `/${options}`;
        }
        if (opts.selection !== undefined) {
            hash += `/${opts.selection}`;
        }
        return hash;
    }
    if (page === "activity" && (opts.tab !== undefined || opts.selection !== undefined)) {
        hash += `/${opts.tab ?? "all"}`;
    }
    if (opts.selection !== undefined) {
        hash += `/${opts.selection}`;
    }
    return hash;
}

export function route_hash(current: SplitRoute, selection: string | undefined): string {
    return page_hash(current.page, {
        tab: current.page === "activity" || current.page === "search" ? current.tab : undefined,
        selection,
        query: current.query,
        sort: current.sort,
        range: current.range,
    });
}

export function page_title(page: SplitPage): string {
    const titles: Record<SplitPage, string> = {
        dms: $t({defaultMessage: "Direct messages"}),
        activity: $t({defaultMessage: "Activity"}),
        threads: $t({defaultMessage: "Threads"}),
        search: $t({defaultMessage: "Search results"}),
    };
    return titles[page];
}

export function page_icon(page: SplitPage): string {
    const icons: Record<SplitPage, string> = {
        dms: "ykphone-rail-dm",
        activity: "ykphone-rail-bell",
        threads: "threads",
        search: "search",
    };
    return icons[page];
}

// ---- Direct messages ----

export type DmRowContext = {
    user_ids_string: string;
    url: string;
    recipients: string;
    is_group: boolean;
    avatar_url: string | undefined;
    // A group conversation stacks the first two members' avatars.
    avatar_urls: string[];
    user_circle_class: string | undefined;
    dm_user_id: number | undefined;
    snippet: string;
    time_label: string;
    unread: number;
    has_unread: boolean;
    is_active: boolean;
};

export type PersonRowContext = {
    user_id: number;
    url: string;
    name: string;
    avatar_url: string;
    user_circle_class: string | undefined;
};

type LastMessage = {id: number; sender_id: number; content: string; timestamp: number};

// The newest message of each conversation, by user_ids_string, for the
// snippet and time of its row.
const last_dm_messages = new Map<string, LastMessage>();

const messages_response_schema = z.object({messages: z.array(raw_message_schema)});

// The listed conversations: the newest ones, or every one that
// matches a search.
export function dm_conversations(search = ""): {user_ids_string: string; max_message_id: number}[] {
    return pm_conversations.recent
        .get()
        .filter((conversation) => {
            if (search === "") {
                return true;
            }
            const user_ids = people.user_ids_string_to_ids_array(conversation.user_ids_string);
            return people.dm_matches_search_string(people.get_users_from_ids(user_ids), search);
        })
        .slice(0, MAX_DM_CONVERSATIONS);
}

// The key pm_conversations files a direct message under: the other
// participants' ids, or one's own for a conversation with oneself.
function dm_key(message: RawMessage | Message): string | undefined {
    if (message.type !== "private" || typeof message.display_recipient === "string") {
        return undefined;
    }
    const user_ids = message.display_recipient.map((recipient) => recipient.id);
    const other_ids = user_ids.filter((user_id) => user_id !== current_user.user_id);
    const key_ids = other_ids.length === 0 ? [current_user.user_id] : other_ids;
    return key_ids.toSorted((a, b) => a - b).join(",");
}

function remember_dm_message(message: RawMessage | Message): boolean {
    const key = dm_key(message);
    if (key === undefined) {
        return false;
    }
    const previous = last_dm_messages.get(key);
    if (previous !== undefined && previous.id >= message.id) {
        return false;
    }
    last_dm_messages.set(key, {
        id: message.id,
        sender_id: message.sender_id,
        content: message.content,
        timestamp: message.timestamp,
    });
    return true;
}

// Newly arrived messages (message_events) keep the rows current;
// returns whether a direct message conversation changed.
export function note_new_messages(messages: Message[]): boolean {
    let changed = false;
    for (const message of messages) {
        if (remember_dm_message(message)) {
            changed = true;
        }
    }
    return changed;
}

// Fetches the newest message of every listed conversation that is not
// known yet (the initial state carries only its id), in one request.
export function load_dm_snippets(on_loaded: () => void): void {
    const missing_ids: number[] = [];
    for (const conversation of dm_conversations()) {
        const known = last_dm_messages.get(conversation.user_ids_string);
        if (known !== undefined && known.id >= conversation.max_message_id) {
            continue;
        }
        const cached = message_store.get(conversation.max_message_id);
        if (cached === undefined) {
            missing_ids.push(conversation.max_message_id);
        } else {
            remember_dm_message(cached);
        }
    }
    if (missing_ids.length === 0) {
        return;
    }
    void channel.get({
        url: "/json/messages",
        data: {
            message_ids: JSON.stringify(missing_ids),
            apply_markdown: true,
            client_gravatar: true,
            allow_empty_topic_name: true,
        },
        success(raw_data) {
            for (const message of messages_response_schema.parse(raw_data).messages) {
                remember_dm_message(message);
            }
            on_loaded();
        },
        error() {
            // The rows stand without snippets; the next visit retries.
        },
    });
}

function presence_class(user_id: number): string | undefined {
    if (realm.realm_presence_disabled) {
        return undefined;
    }
    return buddy_data.get_user_circle_class(user_id, !people.is_active_user_or_system_bot(user_id));
}

function dm_snippet(last: LastMessage | undefined): string {
    if (last === undefined) {
        return "";
    }
    const snippet = ykphone_activity.plain_text_snippet(last.content);
    if (last.sender_id === current_user.user_id) {
        return $t({defaultMessage: "You: {snippet}"}, {snippet});
    }
    return snippet;
}

export function dm_rows(search: string, selection: string | undefined): DmRowContext[] {
    const rows: DmRowContext[] = [];
    for (const conversation of dm_conversations(search)) {
        const {user_ids_string} = conversation;
        const user_ids = people.user_ids_string_to_ids_array(user_ids_string);
        const is_group = user_ids.length > 1;
        const last = last_dm_messages.get(user_ids_string);
        const unread_count = unread.num_unread_for_user_ids_string(user_ids_string);
        rows.push({
            user_ids_string,
            url: page_hash("dms", {selection: user_ids_string}),
            recipients: people.format_recipients(user_ids_string, "narrow"),
            is_group,
            avatar_url: is_group ? undefined : people.small_avatar_url_for_user_id(user_ids[0]!),
            avatar_urls: is_group
                ? user_ids
                      .slice(0, 2)
                      .map((user_id) => people.small_avatar_url_for_user_id(user_id))
                : [],
            user_circle_class: is_group ? undefined : presence_class(user_ids[0]!),
            dm_user_id: is_group ? undefined : user_ids[0],
            snippet: dm_snippet(last),
            time_label:
                last === undefined
                    ? ""
                    : timerender.relative_time_string_from_date(new Date(last.timestamp * 1000)),
            unread: unread_count,
            has_unread: unread_count > 0,
            is_active: selection === user_ids_string,
        });
    }
    return rows;
}

// People matching the search who have no conversation row: selecting
// one starts a new direct message with them (upstream's search-bar
// person matching), limited to people the user may write to under the
// realm's direct message permission.
export function people_rows(
    search: string,
    listed_user_ids_strings: Set<string>,
): PersonRowContext[] {
    const query = search.trim();
    if (query === "") {
        return [];
    }
    return people
        .get_people_for_search_bar(query)
        .filter(
            (user) =>
                !user.is_bot &&
                people.is_active_user(user.user_id) &&
                !listed_user_ids_strings.has(user.user_id.toString()) &&
                message_util.user_can_send_direct_message(user.user_id.toString()),
        )
        .slice(0, MAX_PEOPLE_RESULTS)
        .map((user) => ({
            user_id: user.user_id,
            url: page_hash("dms", {selection: user.user_id.toString()}),
            name: user.full_name,
            avatar_url: people.small_avatar_url_for_person(user),
            user_circle_class: presence_class(user.user_id),
        }));
}

export function dm_narrow_terms(selection: string): NarrowTerm[] | undefined {
    const user_ids = selection.split(",").map((part) => Number.parseInt(part, 10));
    if (user_ids.some((user_id) => Number.isNaN(user_id)) || !people.is_valid_user_ids(user_ids)) {
        return undefined;
    }
    return [{operator: "dm", operand: user_ids}];
}

// ---- Activity ----

export type ActivityRowContext = {
    message_id: number;
    url: string;
    avatar_url: string;
    // "Othello mentioned you in #Verona", and the like.
    line: string;
    snippet: string;
    time_label: string;
    is_unread: boolean;
    is_active: boolean;
};

export type ActivityTabLink = {
    id: ActivityTab;
    label: string;
    active: boolean;
    url: string;
};

let activity_items: ActivityItem[] = [];
// Whether the current page's feed has answered (a selection that names
// nothing in it is stale only once it has).
let activity_loaded = false;

export function get_activity_items(): ActivityItem[] {
    return activity_items;
}

export function set_activity_items(items: ActivityItem[]): void {
    activity_items = items;
    activity_loaded = true;
}

export function clear_activity_items(): void {
    activity_items = [];
    activity_loaded = false;
}

export function find_activity_item(message_id: number): ActivityItem | undefined {
    return activity_items.find((item) => item.message.id === message_id);
}

export function activity_tab_links(current: SplitRoute): ActivityTabLink[] {
    return ykphone_activity.TABS.map((tab) => ({
        id: tab,
        label: ykphone_activity.tab_label(tab),
        active: tab === current.tab,
        // Switching the filter keeps the conversation on the right.
        url: page_hash("activity", {tab, selection: current.selection}),
    }));
}

function emoji_text(reaction: RawMessage["reactions"][number]): string {
    if (reaction.reaction_type === "unicode_emoji") {
        return String.fromCodePoint(
            ...reaction.emoji_code.split("-").map((code) => Number.parseInt(code, 16)),
        );
    }
    return `:${reaction.emoji_name}:`;
}

// The newest reaction by somebody else on one of the user's messages.
export function last_reaction_by_other(
    message: RawMessage,
): RawMessage["reactions"][number] | undefined {
    return message.reactions.findLast((reaction) => reaction.user_id !== current_user.user_id);
}

function user_name(user_id: number): string {
    return people.maybe_get_user_by_id(user_id, true)?.full_name ?? "";
}

export function activity_line(item: ActivityItem): string {
    const {message} = item;
    const name = message.sender_full_name;
    if (item.source === "reactions") {
        // Listed reaction items carry one (listed_activity_items).
        const reaction = last_reaction_by_other(message);
        assert(reaction !== undefined);
        return $t(
            {defaultMessage: "{name} reacted {emoji} to your message"},
            {name: user_name(reaction.user_id), emoji: emoji_text(reaction)},
        );
    }
    if (item.source === "threads") {
        return $t({defaultMessage: "{name} replied in a thread"}, {name});
    }
    if (item.source === "dm") {
        return $t({defaultMessage: "{name} sent you a direct message"}, {name});
    }
    if (message.type === "private") {
        return $t({defaultMessage: "{name} mentioned you in a direct message"}, {name});
    }
    return $t(
        {defaultMessage: "{name} mentioned you in {channel}"},
        {name, channel: ykphone_activity.context_label(message)},
    );
}

// Items with a row: a reaction item needs a reaction by somebody else
// (the last one may have been removed since the feed was fetched).
export function listed_activity_items(): ActivityItem[] {
    return activity_items.filter(
        (item) => item.source !== "reactions" || last_reaction_by_other(item.message) !== undefined,
    );
}

export function activity_rows(current: SplitRoute): ActivityRowContext[] {
    return listed_activity_items().map((item) => {
        const base = ykphone_activity.row_context(item);
        const message_id = item.message.id;
        let avatar_url = base.avatar_url;
        // A reaction row shows who reacted, not who wrote the message
        // (the user did), and has no unread state of its own.
        let is_unread = unread.get_unread_message_ids([message_id]).length > 0;
        if (item.source === "reactions") {
            const reaction = last_reaction_by_other(item.message);
            assert(reaction !== undefined);
            avatar_url = people.small_avatar_url_for_user_id(reaction.user_id);
            is_unread = false;
        }
        return {
            message_id,
            url: route_hash(current, message_id.toString()),
            avatar_url,
            line: activity_line(item),
            snippet: base.snippet,
            time_label: base.time_label,
            is_unread,
            is_active: current.selection === message_id.toString(),
        };
    });
}

export function activity_narrow_terms(item: ActivityItem): NarrowTerm[] {
    return ykphone_activity.message_terms(item.message);
}

// Whether newly arrived messages could add a row to the Activity page:
// a mention, a direct message from somebody else, or a reply from
// somebody else in a topic the user takes part in.
export function affects_activity(messages: Message[]): boolean {
    return messages.some((message) => {
        if (message.sender_id === current_user.user_id) {
            return false;
        }
        if (message.mentioned || message.type === "private") {
            return true;
        }
        return (
            message.topic !== "" &&
            (ykphone_threads.user_takes_part_in_topic(message.stream_id, message.topic) ||
                ykphone_threads.get_thread_for_topic(message.stream_id, message.topic)
                    ?.user_participated === true)
        );
    });
}

// A reaction event is activity when somebody else reacted to one of
// the user's messages (known from the store, or already listed);
// additions and removals both change the rows.
export function reaction_affects_activity(event: {message_id: number; user_id: number}): boolean {
    if (route?.page !== "activity" || (route.tab !== "all" && route.tab !== "reactions")) {
        return false;
    }
    if (event.user_id === current_user.user_id) {
        return false;
    }
    return (
        message_store.get(event.message_id)?.sender_id === current_user.user_id ||
        find_activity_item(event.message_id) !== undefined
    );
}

// ---- Threads ----

const thread_row_schema = z.object({
    root_message_id: z.number(),
    stream_id: z.number(),
    topic_name: z.string(),
    // A topic other than a thread that the user took part in has its
    // first message for a root.
    is_thread: z.boolean(),
    reply_count: z.number(),
    last_reply_timestamp: z.nullable(z.number()),
    root_sender_id: z.number(),
    root_sender_full_name: z.string(),
    root_snippet: z.string(),
    root_timestamp: z.number(),
    last_activity_timestamp: z.number(),
});
export const threads_response_schema = z.object({threads: z.array(thread_row_schema)});

export type ThreadRow = z.infer<typeof thread_row_schema>;

export type ThreadRowContext = {
    root_message_id: number;
    url: string;
    channel_name: string;
    avatar_url: string;
    sender_name: string;
    snippet: string;
    reply_label: string;
    last_reply_label: string;
    unread: number;
    has_unread: boolean;
    is_active: boolean;
};

// Undefined until the first load has answered.
let thread_rows: ThreadRow[] | undefined;
let threads_load_generation = 0;

export function get_thread_rows(): ThreadRow[] | undefined {
    return thread_rows;
}

export function find_thread_row(root_message_id: number): ThreadRow | undefined {
    return thread_rows?.find((row) => row.root_message_id === root_message_id);
}

export function load_my_threads(callbacks: {
    on_loaded: (rows: ThreadRow[]) => void;
    on_error: () => void;
}): void {
    threads_load_generation += 1;
    const generation = threads_load_generation;
    void channel.get({
        url: "/json/ykphone/threads/mine",
        success(raw_data) {
            if (generation !== threads_load_generation) {
                return;
            }
            thread_rows = threads_response_schema.parse(raw_data).threads;
            callbacks.on_loaded(thread_rows);
        },
        error() {
            if (generation === threads_load_generation) {
                callbacks.on_error();
            }
        },
    });
}

export function thread_unread_count(row: ThreadRow): number {
    return unread.num_unread_for_topic(row.stream_id, row.topic_name);
}

// Unread threads first, then the newest activity first, as Slack's
// Threads page orders them.
export function sorted_thread_rows(rows: ThreadRow[]): ThreadRow[] {
    return rows.toSorted((a, b) => {
        const unread_difference =
            Number(thread_unread_count(b) > 0) - Number(thread_unread_count(a) > 0);
        return (
            unread_difference ||
            b.last_activity_timestamp - a.last_activity_timestamp ||
            b.root_message_id - a.root_message_id
        );
    });
}

export function thread_row_contexts(current: SplitRoute, rows: ThreadRow[]): ThreadRowContext[] {
    return sorted_thread_rows(rows).map((row) => {
        const unread_count = thread_unread_count(row);
        const sender = people.maybe_get_user_by_id(row.root_sender_id, true);
        return {
            root_message_id: row.root_message_id,
            url: page_hash("threads", {selection: row.root_message_id.toString()}),
            channel_name: stream_data.get_sub_by_id(row.stream_id)?.name ?? "",
            avatar_url:
                sender === undefined
                    ? `/avatar/${row.root_sender_id}`
                    : people.small_avatar_url_for_person(sender),
            sender_name: row.root_sender_full_name,
            snippet: row.root_snippet,
            // A topic nobody has replied in yet shows no count.
            reply_label:
                row.reply_count === 0
                    ? ""
                    : $t(
                          {defaultMessage: "{count, plural, one {# reply} other {# replies}}"},
                          {count: row.reply_count},
                      ),
            last_reply_label:
                row.last_reply_timestamp === null
                    ? ""
                    : $t(
                          {defaultMessage: "Last reply {time}"},
                          {
                              time: timerender.relative_time_string_from_date(
                                  new Date(row.last_reply_timestamp * 1000),
                              ),
                          },
                      ),
            unread: unread_count,
            has_unread: unread_count > 0,
            is_active: current.selection === row.root_message_id.toString(),
        };
    });
}

// Whether newly arrived messages change the Threads page: the user's
// own replies (a new thread or topic of theirs), replies in a listed
// thread, and replies in a topic the user takes part in or was
// mentioned in (a thread the list does not know yet).
export function affects_threads(messages: Message[]): boolean {
    const listed = new Set(
        (thread_rows ?? []).map((row) => `${row.stream_id}:${row.topic_name.toLowerCase()}`),
    );
    return messages.some(
        (message) =>
            message.type === "stream" &&
            message.topic !== "" &&
            (message.sender_id === current_user.user_id ||
                message.mentioned ||
                listed.has(`${message.stream_id}:${message.topic.toLowerCase()}`) ||
                ykphone_threads.user_takes_part_in_topic(message.stream_id, message.topic) ||
                ykphone_threads.get_thread_for_topic(message.stream_id, message.topic)
                    ?.user_participated === true),
    );
}

export function thread_narrow_terms(row: ThreadRow): NarrowTerm[] {
    return [
        {operator: "channel", operand: row.stream_id.toString()},
        {operator: "topic", operand: row.topic_name},
    ];
}

// ---- Search results ----

export type SearchTabLink = {
    id: SplitTab;
    label: string;
    count: string;
    active: boolean;
    url: string;
};

// Reading the files out of a result set is a regex pass over every
// message, so it is done once per set rather than once per render.
let file_row_cache: {messages: RawMessage[]; rows: ykphone_files.FileRow[]} | undefined;

function file_rows_of(messages: RawMessage[]): ykphone_files.FileRow[] {
    if (file_row_cache?.messages !== messages) {
        file_row_cache = {messages, rows: ykphone_files.rows_from_messages(messages)};
    }
    return file_row_cache.rows;
}

function results_for(current: SplitRoute): ykphone_search.SearchResults | undefined {
    const results = ykphone_search.get_results();
    if (results === undefined) {
        return undefined;
    }
    return results.query === (current.query ?? "") ? results : undefined;
}

// How many each tab holds. A count the search could not finish reading
// is "N+"; the 파일 count is of the files the search found, not of the
// ones the facets leave on screen, so choosing a 종류 does not change
// the tab's own number.
export function search_tab_links(current: SplitRoute): SearchTabLink[] {
    const results = results_for(current);
    const words = ykphone_search.search_words(current.query ?? "");
    const hash_for = (selection: string): string => route_hash(current, selection);
    const counts: Record<SearchTab, string> = {
        messages: ykphone_search.count_label(
            search_messages(current).length,
            results?.messages_complete ?? true,
        ),
        files: ykphone_search.count_label(
            search_file_rows(current, {facets: false}).length,
            results?.files_complete ?? true,
        ),
        channels: ykphone_search
            .channel_rows(words, {selection: undefined, hash_for})
            .length.toString(),
        people: ykphone_search
            .people_rows(words, {selection: undefined, hash_for})
            .length.toString(),
    };
    return ykphone_search.SEARCH_TABS.map((tab) => ({
        id: tab,
        label: ykphone_search.tab_label(tab),
        count: counts[tab],
        active: tab === current.tab,
        // Switching tabs keeps the query and the view choices, and
        // drops the selection, whose meaning is the tab's.
        url: page_hash("search", {
            tab,
            query: current.query,
            sort: current.sort,
            range: current.range,
        }),
    }));
}

// The messages of the Messages tab: what the search brought back,
// narrowed by the date range and in the chosen order.
export function search_messages(current: SplitRoute): RawMessage[] {
    const results = results_for(current);
    if (results === undefined) {
        return [];
    }
    return ykphone_search.sort_messages(
        ykphone_search.filter_by_date(results.messages, current.range ?? "any"),
        current.sort ?? "newest",
    );
}

export function search_file_rows(
    current: SplitRoute,
    opts?: {facets: boolean},
): ykphone_files.FileRow[] {
    const results = results_for(current);
    if (results === undefined) {
        return [];
    }
    const rows = ykphone_search.filter_by_date(file_rows_of(results.files), current.range ?? "any");
    const order = current.sort ?? "newest";
    const sorted = rows.toSorted((a, b) =>
        order === "newest"
            ? b.timestamp - a.timestamp || b.message_id - a.message_id
            : a.timestamp - b.timestamp || a.message_id - b.message_id,
    );
    return opts?.facets === false
        ? sorted
        : ykphone_files.filter_rows(sorted, ykphone_search.get_file_filters());
}

// Every message the page knows about, for looking a selection up.
function search_known_messages(): RawMessage[] {
    const results = ykphone_search.get_results();
    return results === undefined ? [] : [...results.messages, ...results.files];
}

// ---- Selection ----

// The narrow the selection stands for, or undefined while the rows it
// is looked up in have not arrived (or it names nothing listed).
export function narrow_terms(current: SplitRoute): NarrowTerm[] | undefined {
    if (current.selection === undefined) {
        return undefined;
    }
    if (current.page === "dms") {
        return dm_narrow_terms(current.selection);
    }
    if (current.page === "activity") {
        const item = find_activity_item(Number.parseInt(current.selection, 10));
        return item === undefined ? undefined : activity_narrow_terms(item);
    }
    if (current.page === "search") {
        return ykphone_search.selection_terms(current.selection, search_known_messages());
    }
    const row = find_thread_row(Number.parseInt(current.selection, 10));
    return row === undefined ? undefined : thread_narrow_terms(row);
}

// What the page opens with when nothing is selected: the newest
// conversation or thread by activity, unless opening it would mark
// messages read that the user did not choose to read, in which case
// nothing (the placeholder). The Activity page always waits for a
// click.
export function default_selection(current: SplitRoute): string | undefined {
    if (current.page === "dms") {
        const newest = dm_conversations()[0];
        if (
            newest === undefined ||
            unread.num_unread_for_user_ids_string(newest.user_ids_string) > 0
        ) {
            return undefined;
        }
        return newest.user_ids_string;
    }
    if (current.page === "threads") {
        const newest = (thread_rows ?? []).toSorted(
            (a, b) =>
                b.last_activity_timestamp - a.last_activity_timestamp ||
                b.root_message_id - a.root_message_id,
        )[0];
        if (newest === undefined || thread_unread_count(newest) > 0) {
            return undefined;
        }
        return newest.root_message_id.toString();
    }
    return undefined;
}

// Whether the rows a selection is looked up in have arrived.
function rows_loaded(page: SplitPage): boolean {
    if (page === "dms") {
        return true;
    }
    if (page === "activity") {
        return activity_loaded;
    }
    if (page === "search") {
        return ykphone_search.get_results() !== undefined;
    }
    return thread_rows !== undefined;
}

// ---- The page's decisions (the DOM side carries them out) ----

// What opening a route needs: the whole page (shell and rows), the
// rows of another tab, or just the rows drawn again.
export type ShowPlan = "page" | "tab" | "rows";

export function plan_show(previous: SplitRoute | undefined, current: SplitRoute): ShowPlan {
    if (previous?.page !== current.page) {
        return "page";
    }
    // A new query, or an order that reads the other end of the
    // history, is a new page: its results have to be fetched again.
    if (
        current.page === "search" &&
        (previous.query !== current.query || previous.sort !== current.sort)
    ) {
        return "page";
    }
    // A date range is applied to the results that are already here.
    if (current.page === "search" && previous.range !== current.range) {
        return "tab";
    }
    if (previous.tab !== current.tab) {
        return "tab";
    }
    return "rows";
}

export type RouteAction =
    // The page's own hash replaced by one with a selection.
    | {type: "replace_hash"; hash: string}
    // Nothing to show on the right; stale when the selection named a
    // row that no longer exists.
    | {type: "placeholder"; stale: boolean}
    | {type: "activate"; terms: NarrowTerm[]}
    // The conversation is already on the right (or its rows are still
    // on the way).
    | {type: "keep"};

// What the right column should show for a route: called when the route
// is set and again when the page's rows arrive.
export function resolve_route(current: SplitRoute, opts: {stacked: boolean}): RouteAction {
    const fallback = (stale: boolean): RouteAction => {
        if (!opts.stacked) {
            const default_hash = default_selection(current);
            if (default_hash !== undefined && default_hash !== current.selection) {
                return {type: "replace_hash", hash: route_hash(current, default_hash)};
            }
        }
        return {type: "placeholder", stale};
    };
    if (current.selection === undefined) {
        return fallback(false);
    }
    const terms = narrow_terms(current);
    if (terms === undefined) {
        if (is_narrow_shown_for(current)) {
            return {type: "keep"};
        }
        if (!rows_loaded(current.page)) {
            return placeholder_visible ? {type: "keep"} : {type: "placeholder", stale: false};
        }
        return fallback(true);
    }
    if (is_narrow_shown_for(current)) {
        return {type: "keep"};
    }
    return {type: "activate", terms};
}

// How newly arrived messages change the open page: its rows drawn
// again from what is known, its rows fetched again, or nothing.
export type RefreshPlan = "rows" | "reload" | undefined;

export function refresh_for_messages(messages: Message[]): RefreshPlan {
    if (route === undefined) {
        return undefined;
    }
    if (route.page === "dms") {
        return note_new_messages(messages) ? "rows" : undefined;
    }
    if (route.page === "activity") {
        return affects_activity(messages) ? "reload" : undefined;
    }
    if (route.page === "search") {
        // A search is a snapshot: new messages do not change what was
        // searched for, and re-running it under the reader would move
        // the rows they are working through.
        return undefined;
    }
    return affects_threads(messages) ? "reload" : undefined;
}

export function clear_for_testing(): void {
    route = undefined;
    file_row_cache = undefined;
    placeholder_visible = false;
    shown_selection = undefined;
    last_dm_messages.clear();
    activity_items = [];
    activity_loaded = false;
    thread_rows = undefined;
    threads_load_generation = 0;
}
