// The Slack-style search dropdown of the 옆커폰 fork.
//
// Upstream's typeahead offers one flat list of Zulip search operators
// with English descriptions, topic operators among them. Slack's
// dropdown is grouped: the searches you ran before, the channels and
// people whose names match, and a row of search filters ("chips") that
// are always offered. This module keeps upstream's suggestion data —
// the search strings it produces are what the typeahead selects and
// turns into pills — and only decides which of them to show, in what
// order, under which heading, and how each row reads in Korean.
//
// Everything here is pure (it reads the channel and people stores);
// the rendering hooks live in search.ts (three lines) and the row
// template is ykphone_search_suggestion.hbs.

import {Filter} from "./filter.ts";
import {$t} from "./i18n.ts";
import {localstorage} from "./localstorage.ts";
import {page_params} from "./page_params.ts";
import * as people from "./people.ts";
import type {NarrowCanonicalTerm, NarrowTermSuggestion} from "./state_data.ts";
import {current_user} from "./state_data.ts";
import * as stream_data from "./stream_data.ts";
import * as ykphone_flags from "./ykphone_flags.ts";

// Slack shows about a dozen rows; upstream's cap is 50, which fills
// the screen with channels alone.
const MAX_ROWS = 16;
export const MAX_RECENT_SEARCHES = 5;
// Recent searches shown while the box is empty; a typed query filters
// them and shows at most this many, so the sections below stay visible.
const MAX_RECENT_ROWS_WHILE_TYPING = 3;
// Channels and people matching what is typed; every section is capped
// so that no one of them pushes the others off the list.
const MAX_MATCHES_PER_SECTION = 5;

export type SuggestionSection = "query" | "recent" | "channel" | "person" | "filter";

export type SuggestionRow = {
    search_string: string;
    section: SuggestionSection;
    // Set on the first row of a section only; the others continue it.
    section_label: string | undefined;
    // A zulip-icon name, shown when there is no avatar.
    icon: string | undefined;
    avatar_url: string | undefined;
    label: string;
    description: string;
};

const section_order: SuggestionSection[] = ["query", "recent", "channel", "person", "filter"];

function section_label(section: SuggestionSection): string | undefined {
    const labels: Record<SuggestionSection, string | undefined> = {
        // The typed words need no heading.
        query: undefined,
        recent: $t({defaultMessage: "Recent searches"}),
        channel: $t({defaultMessage: "Channels"}),
        person: $t({defaultMessage: "People"}),
        filter: $t({defaultMessage: "Search filters"}),
    };
    return labels[section];
}

// ---- What the fork leaves out ----

// Topics are threads in this fork and have no search operators of
// their own, so the dropdown never teaches Zulip's.
const HIDDEN_IS_OPERANDS = new Set(["followed", "resolved", "muted", "alerted"]);
const HIDDEN_OPERATORS = new Set(["topic"]);

// The operators Slack's search has no modifier for, hidden together
// behind ykphone_flags.SEARCH_DROPDOWN_SLACK_OPERATORS_ONLY. ("in:" is
// not among them: Slack has that one.)
const NON_SLACK_OPERATORS = new Set(["channels", "id", "near", "with"]);
const NON_SLACK_IS_OPERANDS = new Set(["unread"]);
const NON_SLACK_HAS_OPERANDS = new Set(["reaction"]);

function is_hidden_term(term: NarrowTermSuggestion): boolean {
    const operator = term.operator;
    if (HIDDEN_OPERATORS.has(operator)) {
        return true;
    }
    if (operator === "is" && HIDDEN_IS_OPERANDS.has(term.operand)) {
        return true;
    }
    if (!ykphone_flags.SEARCH_DROPDOWN_SLACK_OPERATORS_ONLY) {
        return false;
    }
    if (NON_SLACK_OPERATORS.has(operator)) {
        return true;
    }
    if (operator === "is") {
        return NON_SLACK_IS_OPERANDS.has(term.operand);
    }
    return operator === "has" && NON_SLACK_HAS_OPERANDS.has(term.operand);
}

// Without the fork's flag the dropdown is upstream's, as everywhere
// else topics are still Zulip's; a spectator, who has no account to
// file recent searches under and no results page to open, keeps
// upstream's too.
export function enabled(): boolean {
    return ykphone_flags.channels_open_in_general_chat() && !page_params.is_spectator;
}

// ---- Reading a term ----

function channel_icon(stream_id: number): string {
    const sub = stream_data.get_sub_by_id(stream_id);
    if (sub === undefined) {
        return "hashtag";
    }
    if (sub.invite_only) {
        return "lock";
    }
    return sub.is_web_public ? "globe" : "hashtag";
}

function channel_label(operand: string): string {
    const stream_id = Number.parseInt(operand, 10);
    const sub = Number.isNaN(stream_id) ? undefined : stream_data.get_sub_by_id(stream_id);
    return `#${sub?.name ?? operand}`;
}

function person_ids(operand: string): number[] {
    return operand
        .split(",")
        .map((part) => Number.parseInt(part, 10))
        .filter((user_id) => !Number.isNaN(user_id));
}

function person_label(operand: string): string {
    const names = person_ids(operand).map(
        (user_id) => people.maybe_get_user_by_id(user_id, true)?.full_name ?? operand,
    );
    return names.length === 0 ? operand : names.join(", ");
}

function person_avatar(operand: string): string | undefined {
    const ids = person_ids(operand);
    if (ids.length !== 1) {
        return undefined;
    }
    const person = people.maybe_get_user_by_id(ids[0]!, true);
    return person === undefined ? undefined : people.small_avatar_url_for_person(person);
}

type TermView = {
    section: SuggestionSection;
    icon: string | undefined;
    avatar_url: string | undefined;
    label: string;
    description: string;
};

// How the term a suggestion adds reads as a row. An operator with no
// operand ("sender:") is a filter the user still has to fill in.
// Returns undefined for a term the fork does not offer.
export function describe_term(term: NarrowTermSuggestion): TermView | undefined {
    if (is_hidden_term(term)) {
        return undefined;
    }
    const empty_operand = term.operand === "" || term.operand === "-1";
    switch (term.operator) {
        case "search":
            return {
                section: "query",
                icon: "search",
                avatar_url: undefined,
                label: term.operand,
                description: $t({defaultMessage: "Search messages"}),
            };
        case "channel":
            if (empty_operand) {
                return {
                    section: "filter",
                    icon: "hashtag",
                    avatar_url: undefined,
                    label: $t({defaultMessage: "In channel"}),
                    description: $t({defaultMessage: "Pick a channel to search in"}),
                };
            }
            return {
                section: "channel",
                icon: channel_icon(Number.parseInt(term.operand, 10)),
                avatar_url: undefined,
                label: channel_label(term.operand),
                description: $t({defaultMessage: "Search in this channel"}),
            };
        case "sender":
            if (empty_operand) {
                return {
                    section: "filter",
                    icon: "user",
                    avatar_url: undefined,
                    label: $t({defaultMessage: "From"}),
                    description: $t({defaultMessage: "Pick a person to search for"}),
                };
            }
            return {
                section: "person",
                icon: "user",
                avatar_url: person_avatar(term.operand),
                label: person_label(term.operand),
                description: $t({defaultMessage: "Messages this person sent"}),
            };
        case "dm":
            if (empty_operand) {
                return {
                    section: "filter",
                    icon: "ykphone-rail-dm",
                    avatar_url: undefined,
                    label: $t({defaultMessage: "Direct messages with"}),
                    description: $t({defaultMessage: "Pick a person to search for"}),
                };
            }
            return {
                section: "person",
                icon: "ykphone-rail-dm",
                avatar_url: person_avatar(term.operand),
                label: person_label(term.operand),
                description: $t({defaultMessage: "Direct messages with this person"}),
            };
        case "dm-including":
            if (empty_operand) {
                return undefined;
            }
            return {
                section: "person",
                icon: "users",
                avatar_url: person_avatar(term.operand),
                label: person_label(term.operand),
                description: $t({defaultMessage: "Direct messages including this person"}),
            };
        case "mentions":
            if (empty_operand) {
                return undefined;
            }
            return {
                section: "person",
                icon: "at-sign",
                avatar_url: person_avatar(term.operand),
                label: person_label(term.operand),
                description: $t({defaultMessage: "Messages that mention this person"}),
            };
        case "is":
            switch (term.operand) {
                case "dm":
                    return {
                        section: "filter",
                        icon: "ykphone-rail-dm",
                        avatar_url: undefined,
                        label: $t({defaultMessage: "Direct messages"}),
                        description: $t({defaultMessage: "Direct messages only"}),
                    };
                case "starred":
                    return {
                        section: "filter",
                        icon: "bookmark",
                        avatar_url: undefined,
                        label: $t({defaultMessage: "Saved by me"}),
                        description: $t({defaultMessage: "Messages you saved"}),
                    };
                case "mentioned":
                    return {
                        section: "filter",
                        icon: "at-sign",
                        avatar_url: undefined,
                        label: $t({defaultMessage: "Mentions me"}),
                        description: $t({defaultMessage: "Messages that mention you"}),
                    };
                case "unread":
                    return {
                        section: "filter",
                        icon: "unread",
                        avatar_url: undefined,
                        label: $t({defaultMessage: "Unread"}),
                        description: $t({defaultMessage: "Messages you have not read"}),
                    };
                default:
                    return undefined;
            }
        case "has":
            switch (term.operand) {
                case "attachment":
                    return {
                        section: "filter",
                        icon: "attachment",
                        avatar_url: undefined,
                        label: $t({defaultMessage: "Has file"}),
                        description: $t({defaultMessage: "Messages with a file"}),
                    };
                case "link":
                    return {
                        section: "filter",
                        icon: "link",
                        avatar_url: undefined,
                        label: $t({defaultMessage: "Has link"}),
                        description: $t({defaultMessage: "Messages with a link"}),
                    };
                case "image":
                    return {
                        section: "filter",
                        icon: "mobile-image",
                        avatar_url: undefined,
                        label: $t({defaultMessage: "Has image"}),
                        description: $t({defaultMessage: "Messages with an image"}),
                    };
                case "reaction":
                    return {
                        section: "filter",
                        icon: "smile",
                        avatar_url: undefined,
                        label: $t({defaultMessage: "Has reaction"}),
                        description: $t({defaultMessage: "Messages somebody reacted to"}),
                    };
                default:
                    return undefined;
            }
        case "channels":
            return {
                section: "filter",
                icon: "hashtag",
                avatar_url: undefined,
                label: $t({defaultMessage: "Channels to search"}),
                description: Filter.unparse([{...term, negated: false}]),
            };
        case "in":
            return {
                section: "filter",
                icon: "all-messages",
                avatar_url: undefined,
                label: $t({defaultMessage: "Where to search"}),
                description: Filter.unparse([{...term, negated: false}]),
            };
        case "id":
        case "near":
        case "with":
            return {
                section: "filter",
                icon: "message-square",
                avatar_url: undefined,
                label: Filter.unparse([{...term, negated: false}]),
                description: $t({defaultMessage: "A message by its id"}),
            };
        default:
            return undefined;
    }
}

// The short label of one term inside a recent search, so that
// "channel:11 예산" reads "#devel 예산".
export function term_label(term: NarrowTermSuggestion): string {
    const sign = term.negated === true ? "-" : "";
    switch (term.operator) {
        case "search":
            return term.operand;
        case "channel":
            return sign + channel_label(term.operand);
        case "sender": {
            const name = person_label(term.operand);
            return term.negated === true
                ? $t({defaultMessage: "Not from {name}"}, {name})
                : $t({defaultMessage: "From {name}"}, {name});
        }
        case "dm":
        case "dm-including":
            return sign + person_label(term.operand);
        default:
            return sign + Filter.unparse([term]);
    }
}

export function search_label(search_string: string): string {
    return Filter.parse(search_string)
        .map((term) => term_label(term))
        .join(" ")
        .trim();
}

// ---- Recent searches ----

function storage_key(): string {
    return `ykphone-recent-searches-${current_user.user_id}`;
}

export function recent_searches(): string[] {
    const stored = localstorage().get(storage_key());
    if (!Array.isArray(stored)) {
        return [];
    }
    return stored
        .filter((item): item is string => typeof item === "string" && item.trim() !== "")
        .slice(0, MAX_RECENT_SEARCHES);
}

export function note_search(search_string: string): void {
    const trimmed = search_string.trim();
    if (trimmed === "") {
        return;
    }
    const kept = recent_searches().filter((item) => item.toLowerCase() !== trimmed.toLowerCase());
    localstorage().set(storage_key(), [trimmed, ...kept].slice(0, MAX_RECENT_SEARCHES));
}

// ---- The chips Slack always offers ----

// Written as the search strings upstream's own suggestions use, so a
// chip and the row upstream produces for the same filter are one row.
const CHIP_SEARCH_STRINGS = [
    "sender:",
    "channel:",
    "has:attachment",
    "has:link",
    "has:image",
    "is:starred",
    "is:mentioned",
    "is:dm",
];

// A chip is offered unless the query already carries that filter, or
// it cannot be combined with what is there: Zulip refuses a channel
// and a direct message filter in one search.
export function chip_is_available(search_string: string, base: NarrowTermSuggestion[]): boolean {
    const chip = Filter.parse(search_string)[0];
    if (chip === undefined) {
        return false;
    }
    const has = (operator: string, operand?: string): boolean =>
        base.some(
            (term) =>
                term.operator === operator && (operand === undefined || term.operand === operand),
        );
    if (has(chip.operator, chip.operand === "" ? undefined : chip.operand)) {
        return false;
    }
    const is_dm_filter =
        chip.operator === "dm" || (chip.operator === "is" && chip.operand === "dm");
    if (is_dm_filter && has("channel")) {
        return false;
    }
    if (chip.operator === "channel" && (has("dm") || has("is", "dm"))) {
        return false;
    }
    return true;
}

// Typing filters the chips the way upstream filters its own: by the
// operator, by the operand and by what the row reads.
export function chip_matches_query(search_string: string, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (needle === "") {
        return true;
    }
    const term = Filter.parse(search_string)[0];
    const view = term === undefined ? undefined : describe_term(term);
    const haystacks = [
        search_string.toLowerCase(),
        search_string.slice(search_string.indexOf(":") + 1).toLowerCase(),
        view?.label.toLowerCase() ?? "",
        view?.description.toLowerCase() ?? "",
    ];
    return haystacks.some((haystack) => haystack.includes(needle));
}

// Where a filter row belongs in Slack's row of chips; a filter
// upstream offers that Slack has no chip for goes last. Every row has
// a last term (row_for drops the ones that do not).
function chip_rank(row: SuggestionRow): number {
    const last = Filter.parse(row.search_string).at(-1)!;
    const index = CHIP_SEARCH_STRINGS.indexOf(Filter.unparse([{...last, negated: false}]));
    return index === -1 ? CHIP_SEARCH_STRINGS.length : index;
}

// ---- The rows ----

function row_for(
    search_string: string,
    section_hint?: SuggestionSection,
): SuggestionRow | undefined {
    const terms = Filter.parse(search_string);
    const last = terms.at(-1);
    if (last === undefined) {
        return undefined;
    }
    if (section_hint === "recent") {
        return {
            search_string,
            section: "recent",
            section_label: undefined,
            icon: "past-time",
            avatar_url: undefined,
            label: search_label(search_string),
            description: "",
        };
    }
    const view = describe_term(last);
    if (view === undefined) {
        return undefined;
    }
    return {
        search_string,
        section: view.section,
        section_label: undefined,
        icon: view.icon,
        avatar_url: view.avatar_url,
        label:
            last.negated === true
                ? $t({defaultMessage: "{label} (excluded)"}, {label: view.label})
                : view.label,
        description: view.description,
    };
}

// The rows for what is in the search bar: upstream's suggestions, the
// text being typed (its last term is what a chip is matched against)
// and the pills already there, which a chip is added to.
export function rows_for_search_bar(
    suggestions: string[],
    typed_query: string,
    pill_terms: NarrowCanonicalTerm[],
): SuggestionRow[] {
    const typed = Filter.parse(typed_query);
    const last = typed.at(-1);
    return build_rows(suggestions, {
        query: last === undefined ? "" : Filter.unparse([last]),
        base_terms: [
            ...pill_terms.map((term) => Filter.convert_term_to_suggestion(term)),
            ...typed.slice(0, -1),
        ],
    });
}

// The dropdown, from upstream's suggestions for the query: the rows
// the fork offers, grouped in Slack's order, with the recent searches
// and the always-offered chips added.
export function build_rows(
    suggestions: string[],
    opts: {query: string; base_terms: NarrowTermSuggestion[]},
): SuggestionRow[] {
    const seen = new Set<string>();
    const rows: SuggestionRow[] = [];
    const add = (search_string: string, section_hint?: SuggestionSection): void => {
        const key = search_string.toLowerCase();
        if (seen.has(key)) {
            return;
        }
        const row = row_for(search_string, section_hint);
        if (row === undefined) {
            return;
        }
        seen.add(key);
        rows.push(row);
    };

    const query = opts.query.trim();
    const recents = recent_searches().filter(
        (item) =>
            query === "" ||
            item.toLowerCase().includes(query.toLowerCase()) ||
            search_label(item).toLowerCase().includes(query.toLowerCase()),
    );
    // A recent search stands on its own; it is not added to the pills
    // already in the box.
    if (opts.base_terms.length === 0) {
        for (const item of recents) {
            add(item, "recent");
        }
    }
    for (const suggestion of suggestions) {
        add(suggestion);
    }
    const base_prefix = opts.base_terms.length === 0 ? "" : Filter.unparse(opts.base_terms) + " ";
    for (const chip of CHIP_SEARCH_STRINGS) {
        if (chip_is_available(chip, opts.base_terms) && chip_matches_query(chip, query)) {
            add(base_prefix + chip);
        }
    }

    // With nothing typed Slack's dropdown is the searches you ran
    // before and the filters; a channel row is only offered then for
    // the conversation on screen ("search in this channel"), which
    // upstream puts first.
    const caps: Record<SuggestionSection, number> = {
        query: 1,
        recent: query === "" ? MAX_RECENT_SEARCHES : MAX_RECENT_ROWS_WHILE_TYPING,
        channel: query === "" ? 1 : MAX_MATCHES_PER_SECTION,
        person: query === "" ? 0 : MAX_MATCHES_PER_SECTION,
        filter: CHIP_SEARCH_STRINGS.length,
    };
    const ordered: SuggestionRow[] = [];
    for (const section of section_order) {
        let of_section = rows.filter((row) => row.section === section);
        if (section === "filter") {
            // The filters read in Slack's order, whichever order
            // upstream happened to offer them in.
            of_section = of_section.toSorted((a, b) => chip_rank(a) - chip_rank(b));
        }
        of_section = of_section.slice(0, caps[section]);
        for (const [index, row] of of_section.entries()) {
            ordered.push({
                ...row,
                section_label: index === 0 ? section_label(section) : undefined,
            });
        }
    }
    return ordered.slice(0, MAX_ROWS);
}
