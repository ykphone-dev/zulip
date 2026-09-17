// What the 옆커폰 fork asks of upstream's navbar search: the Slack-style
// dropdown (ykphone_search_suggestions decides the rows, this module
// renders them) and the search results page (ykphone_search holds its
// data and decides what Enter does, ykphone_split_view_ui draws it).
//
// search.ts calls into this module in four places and is otherwise
// untouched. Everything here is DOM glue — a template, a hash, a
// lookup table — and every decision it carries out is made in a pure
// module that has tests.

import render_ykphone_search_suggestion from "../templates/ykphone_search_suggestion.hbs";

import * as browser_history from "./browser_history.ts";
import type {NarrowCanonicalTerm} from "./state_data.ts";
import * as ykphone_search from "./ykphone_search.ts";
import * as ykphone_search_suggestions from "./ykphone_search_suggestions.ts";
import type {SuggestionRow} from "./ykphone_search_suggestions.ts";
import * as ykphone_split_view from "./ykphone_split_view.ts";

// The row of each suggestion the dropdown is showing: the typeahead
// hands the search string back for rendering and for selecting, so the
// rows are looked up by it.
const rows_by_search_string = new Map<string, SuggestionRow>();

// The suggestions the dropdown shows, in the fork's order. Upstream's
// list is the input, so a row the typeahead selects is still one of
// upstream's own search strings.
export function order_suggestions(
    suggestions: string[],
    query: string,
    pill_terms: NarrowCanonicalTerm[],
): string[] {
    if (!ykphone_search_suggestions.enabled()) {
        return suggestions;
    }
    const rows = ykphone_search_suggestions.rows_for_search_bar(suggestions, query, pill_terms);
    rows_by_search_string.clear();
    for (const row of rows) {
        rows_by_search_string.set(row.search_string, row);
    }
    return rows.map((row) => row.search_string);
}

export function suggestion_html(search_string: string): string | undefined {
    const row = rows_by_search_string.get(search_string);
    return row === undefined ? undefined : render_ykphone_search_suggestion(row);
}

function open_page(query: string): void {
    ykphone_search_suggestions.note_search(query);
    browser_history.go_to_location(ykphone_split_view.page_hash("search", {query}));
}

// What upstream does while the query is being built
// (ykphone_search.search_bar_action decides which of the three it is).
export function handle_search_contents(terms: NarrowCanonicalTerm[], finished: boolean): boolean {
    const query = ykphone_search.query_from_terms(terms);
    const action = ykphone_search.search_bar_action({
        enabled: ykphone_search_suggestions.enabled(),
        finished,
        query,
    });
    if (action === "upstream") {
        return false;
    }
    if (action === "open") {
        open_page(query);
    }
    return true;
}

// Enter in the navbar search opens the fork's results page. Spectators
// and a fork run without the flag keep upstream's search narrow, and
// so does #narrow/search/… typed by hand.
export function open_results(terms: NarrowCanonicalTerm[]): boolean {
    const query = ykphone_search.query_from_terms(terms);
    if (
        ykphone_search.search_bar_action({
            enabled: ykphone_search_suggestions.enabled(),
            finished: true,
            query,
        }) !== "open"
    ) {
        return false;
    }
    open_page(query);
    return true;
}
