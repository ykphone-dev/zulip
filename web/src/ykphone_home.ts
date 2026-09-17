// Home in the 옆커폰 fork: Slack has no Inbox, and its Home reopens the
// conversation the user was last in. The rail's Home item, the logo,
// Escape (with the "Esc goes to home view" setting) and Ctrl+[ and an
// empty or unknown URL all lead there; upstream's Inbox stays reachable
// by its URL.
//
// The last conversation comes from the visit history
// (ykphone_recents). A user with none yet, or whose last conversations
// are all gone, lands on the first channel in the sidebar with unread
// messages in its conversation, else on the first channel.

import * as browser_history from "./browser_history.ts";
import type {ShowMessageViewOpts} from "./message_view.ts";
import * as narrow_state from "./narrow_state.ts";
import type {NarrowTerm} from "./state_data.ts";
import * as stream_list_sort from "./stream_list_sort.ts";
import * as ykphone_flags from "./ykphone_flags.ts";
import * as ykphone_places from "./ykphone_places.ts";
import type {Place, PlaceView} from "./ykphone_places.ts";
import * as ykphone_recents from "./ykphone_recents.ts";
import * as ykphone_split_view from "./ykphone_split_view.ts";
import * as ykphone_unread_badges from "./ykphone_unread_badges.ts";

export const TRIGGER = "ykphone home";

type ConversationPlace = Exclude<Place, {kind: "page"}>;

type Home = {place: ConversationPlace; view: PlaceView};

function as_home(place: Place): Home | undefined {
    if (place.kind === "page") {
        return undefined;
    }
    // A channel the user left or that was archived, or a conversation
    // with someone who is gone, cannot be opened.
    const view = ykphone_places.describe(place);
    return view === undefined ? undefined : {place, view};
}

function home(): Home | undefined {
    if (!ykphone_flags.channels_open_in_general_chat()) {
        return undefined;
    }
    for (const {place} of ykphone_recents.recent_entries()) {
        const candidate = as_home(place);
        if (candidate !== undefined) {
            return candidate;
        }
    }
    const stream_ids = stream_list_sort
        .get_stream_ids()
        .filter((id) => ykphone_places.is_open_channel(id));
    const stream_id =
        stream_ids.find((id) => ykphone_unread_badges.channel_has_unread_general_chat(id)) ??
        stream_ids[0];
    return stream_id === undefined ? undefined : as_home({kind: "channel", stream_id});
}

// The URL of Home, or undefined where upstream's home view applies.
export function home_hash(): string | undefined {
    return home()?.view.hash;
}

export function narrow_terms(place: ConversationPlace): NarrowTerm[] {
    if (place.kind === "dm") {
        return [{operator: "dm", operand: place.user_ids}];
    }
    return [
        {operator: "channel", operand: place.stream_id.toString()},
        {operator: "topic", operand: place.kind === "thread" ? place.topic : ""},
    ];
}

// In place of hashchange's show_home_view, which shows the home view
// for an empty or unknown URL and behind an overlay opened by URL.
// Returns whether Home was shown.
export function show_home_view(
    show_narrow: (terms: NarrowTerm[], opts: ShowMessageViewOpts) => void,
    narrow_opts: ShowMessageViewOpts | undefined,
): boolean {
    const current_home = home();
    if (current_home === undefined) {
        return false;
    }
    if (window.location.hash === "" || window.location.hash === "#") {
        // An empty URL takes the conversation's, so that a reload stays
        // in it, without a history entry: Back from the conversation
        // must not land on the empty URL, which would open it again.
        // Any other URL (an overlay's, or one that could not be read)
        // is left as it is, as upstream does.
        window.history.replaceState(null, "", browser_history.get_full_url(current_home.view.hash));
    }
    show_narrow(narrow_terms(current_home.place), {
        trigger: TRIGGER,
        ...narrow_opts,
        change_hash: false,
    });
    return true;
}

// Whether the conversation on screen is Home itself (in the ordinary
// view, not inside one of the split pages).
function is_showing(current_home: Home): boolean {
    const filter = narrow_state.filter();
    const place =
        filter === undefined || ykphone_split_view.is_open()
            ? undefined
            : ykphone_places.place_for_filter(filter);
    return (
        place !== undefined &&
        ykphone_places.place_key(place) === ykphone_places.place_key(current_home.place)
    );
}

// In place of hashchange's set_hash_to_home_view (the rail's Home item,
// the logo, Escape and Ctrl+[). Returns whether it was handled.
export function go_home(go_to_location: (hash: string) => void): boolean {
    const current_home = home();
    if (current_home === undefined) {
        return false;
    }
    if (!is_showing(current_home)) {
        go_to_location(current_home.view.hash);
    }
    return true;
}
