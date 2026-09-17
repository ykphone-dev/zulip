// Slack's keyboard shortcuts for the 옆커폰 fork, dispatched from
// hotkey.ts (one lookup for the extra key combinations, one call per
// processed hotkey and one for Escape):
//
// - ⌘K / Ctrl+K opens the quick switcher (upstream's search keeps "/"),
//   also while typing in the rich editor, where it is not a link key;
// - ⌘⇧K, ⌘⇧M and ⌘⇧T (Ctrl on other systems) open the direct message,
//   activity and threads pages, and so do the sequences G D, G A and
//   G T, which no browser reserves;
// - ⌥⇧↓ / ⌥⇧↑ go to the next or previous conversation in the sidebar
//   with unread messages;
// - ↑ in an empty compose box edits the user's last message in the
//   conversation;
// - "i" opens the channel details dialog when no message is selected;
//   Escape in a conversation marks it as read.
//
// Spectators keep upstream's keys: none of the fork's views are theirs.

import * as browser_history from "./browser_history.ts";
import * as compose_state from "./compose_state.ts";
import * as emoji_picker from "./emoji_picker.ts";
import * as message_edit from "./message_edit.ts";
import * as message_lists from "./message_lists.ts";
import * as modals from "./modals.ts";
import * as narrow_state from "./narrow_state.ts";
import * as overlays from "./overlays.ts";
import {page_params} from "./page_params.ts";
import * as pm_list_data from "./pm_list_data.ts";
import * as popover_menus from "./popover_menus.ts";
import * as popovers from "./popovers.ts";
import * as sidebar_ui from "./sidebar_ui.ts";
import * as stream_list from "./stream_list.ts";
import * as stream_list_sort from "./stream_list_sort.ts";
import * as unread from "./unread.ts";
import * as unread_ops from "./unread_ops.ts";
import * as ykphone_channel_details_ui from "./ykphone_channel_details_ui.ts";
import * as ykphone_compose from "./ykphone_compose.ts";
import * as ykphone_flags from "./ykphone_flags.ts";
import * as ykphone_keyboard_nav from "./ykphone_keyboard_nav.ts";
import * as ykphone_pins from "./ykphone_pins.ts";
import * as ykphone_places from "./ykphone_places.ts";
import type {Place} from "./ykphone_places.ts";
import * as ykphone_quick_switcher_ui from "./ykphone_quick_switcher_ui.ts";
import * as ykphone_rich_hooks from "./ykphone_rich_hooks.ts";
import * as ykphone_split_view from "./ykphone_split_view.ts";
import type {SplitPage} from "./ykphone_split_view.ts";
import * as ykphone_thread_panel from "./ykphone_thread_panel.ts";
import * as ykphone_unread_badges from "./ykphone_unread_badges.ts";

type Hotkey = {
    name: string;
    message_view_only: boolean;
};

// "Cmd" is macOS, "Ctrl" every other system. Chrome and Firefox reserve
// some of these (⌘⇧T reopens a closed tab, Ctrl+Shift+K opens the web
// console), which is what the G sequences below are for.
const KEYDOWN_MAPPINGS: Record<string, Hotkey> = {
    "Cmd+Shift+K": {name: "ykphone_open_dms", message_view_only: false},
    "Ctrl+Shift+K": {name: "ykphone_open_dms", message_view_only: false},
    "Cmd+Shift+M": {name: "ykphone_open_activity", message_view_only: false},
    "Ctrl+Shift+M": {name: "ykphone_open_activity", message_view_only: false},
    "Cmd+Shift+T": {name: "ykphone_open_threads", message_view_only: false},
    "Ctrl+Shift+T": {name: "ykphone_open_threads", message_view_only: false},
    "Alt+Shift+ArrowDown": {name: "ykphone_next_unread_conversation", message_view_only: false},
    "Alt+Shift+ArrowUp": {name: "ykphone_previous_unread_conversation", message_view_only: false},
};

// The fork's own key table, consulted by hotkey.get_keydown_hotkey for
// combinations upstream leaves unmapped. Without the fork's layout the
// keys stay unmapped, as upstream has them.
export function keydown_hotkey(key: string): Hotkey | undefined {
    if (!is_enabled()) {
        return undefined;
    }
    return KEYDOWN_MAPPINGS[key];
}

function is_enabled(): boolean {
    return ykphone_flags.channels_open_in_general_chat() && !page_params.is_spectator;
}

// ---- What holds the keyboard ----

// A place where the keys are the user's text, not hotkeys: any input,
// any rich editor, and the pill and dropdown widgets upstream's
// processing_text() also counts.
function is_text_focused(): boolean {
    if (ykphone_rich_hooks.editor_has_focus()) {
        return true;
    }
    const element = document.activeElement;
    return (
        element !== null &&
        (element.matches("input, select, textarea, [contenteditable='true']") ||
            element.closest(".pill-container, .dropdown-list-container") !== null)
    );
}

function is_thread_panel_focused(): boolean {
    const element = document.activeElement;
    return element !== null && element.closest("#ykphone-thread-panel") !== null;
}

// An Escape pressed while an input method is putting a syllable
// together belongs to that composition, which the browser cancels on
// its own; nothing else may act on it.
function is_composing(e: JQuery.KeyDownEvent): boolean {
    const event = e.originalEvent;
    if (event === undefined) {
        return false;
    }
    if ("isComposing" in event && event.isComposing) {
        return true;
    }
    // Some input methods send the composition's keys with this code and
    // no isComposing.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return "keyCode" in event && event.keyCode === 229;
}

// Something that Escape, or the keys in general, would reach before the
// conversation: a menu, a dialog, a panel or a picker.
function is_ui_layered(): boolean {
    return (
        overlays.any_active() ||
        // Not any_active(): a dialog counts from the moment it starts
        // opening, so a key pressed during the animation is its own.
        modals.any_active_or_animating() ||
        ykphone_quick_switcher_ui.is_open() ||
        popovers.any_active() ||
        Boolean(popover_menus.get_visible_instance()) ||
        emoji_picker.is_open() ||
        sidebar_ui.any_sidebar_expanded_as_overlay() ||
        stream_list.is_zoomed_in()
    );
}

// ---- Unread conversations ----

type SidebarConversation = {place: Place; has_unread: boolean};

// The conversations in the left sidebar, top to bottom: channels (the
// fork puts them above direct messages), bold when their own
// conversation has unread messages, then direct message conversations.
function sidebar_conversations(): SidebarConversation[] {
    return [
        ...stream_list_sort.get_stream_ids().map((stream_id) => ({
            place: ykphone_places.channel_place(stream_id),
            has_unread: ykphone_unread_badges.channel_has_unread_general_chat(stream_id),
        })),
        ...pm_list_data.get_conversations().map((conversation) => ({
            place: ykphone_places.dm_place(conversation.user_ids_string.split(",").map(Number)),
            has_unread: conversation.unread > 0,
        })),
    ];
}

// The next (1) or previous (-1) unread conversation after the one on
// screen, going round the end of the list. A thread counts as its
// channel's position; from anywhere else the search starts at the top
// (or the bottom, going up).
export function adjacent_unread_place(
    direction: 1 | -1,
    current: Place | undefined,
): Place | undefined {
    const conversations = sidebar_conversations();
    const position_place =
        current?.kind === "thread" ? ykphone_places.channel_place(current.stream_id) : current;
    const current_key =
        position_place === undefined ? undefined : ykphone_places.place_key(position_place);
    const current_index = conversations.findIndex(
        (conversation) => ykphone_places.place_key(conversation.place) === current_key,
    );
    // The conversations after the current one, then those before it.
    const after_current =
        current_index === -1
            ? conversations
            : [...conversations.slice(current_index + 1), ...conversations.slice(0, current_index)];
    const in_order = direction === 1 ? after_current : after_current.toReversed();
    return in_order.find((conversation) => conversation.has_unread)?.place;
}

function current_place(): Place | undefined {
    const filter = narrow_state.filter();
    return filter === undefined ? undefined : ykphone_places.place_for_filter(filter);
}

function conversation_place(): Place | undefined {
    const place = current_place();
    return place?.kind === "page" ? undefined : place;
}

function go_to_unread_conversation(direction: 1 | -1): boolean {
    // ⌥⇧↓/↑ is "select to the end of the paragraph" in a text field on
    // macOS, so it only navigates from a conversation whose compose box
    // is empty (the fork keeps it open and focused) or from the feed
    // itself, and never over a dialog or a menu.
    if (
        conversation_place() === undefined ||
        is_ui_layered() ||
        (is_text_focused() &&
            !(ykphone_rich_hooks.has_focus() && compose_state.focus_in_empty_compose()))
    ) {
        return false;
    }
    const place = adjacent_unread_place(direction, current_place());
    const view = place === undefined ? undefined : ykphone_places.describe(place);
    if (view !== undefined) {
        browser_history.go_to_location(view.hash);
    }
    return true;
}

// ---- The pages ----

function open_page(page: SplitPage): boolean {
    if (modals.any_active_or_animating()) {
        return false;
    }
    // A sequence that started with G has the gear menu open behind it.
    popovers.hide_all();
    browser_history.go_to_location(ykphone_split_view.page_hash(page));
    return true;
}

// G opens upstream's gear menu; D, A and T while it is open are the
// fork's sequences for the pages, so that a user whose browser keeps
// ⌘⇧K, ⌘⇧M or ⌘⇧T for itself still has a way there.
function page_for_gear_menu_sequence(hotkey_name: string): SplitPage | undefined {
    if (!popover_menus.is_gear_menu_popover_displayed()) {
        return undefined;
    }
    switch (hotkey_name) {
        case "open_drafts":
            return "dms";
        case "open_combined_feed":
            return "activity";
        case "open_recent_view":
            return "threads";
        default:
            return undefined;
    }
}

// ---- The last message ----

// ↑ in an empty compose box, as in Slack: only while the box holds the
// cursor (not a recipient field), in a conversation, and when there is
// a message of the user's that they may still edit; otherwise the key
// keeps upstream's meaning.
function edit_last_message(): boolean {
    if (
        !ykphone_rich_hooks.has_focus() ||
        !compose_state.focus_in_empty_compose() ||
        is_ui_layered()
    ) {
        return false;
    }
    const message = message_lists.current?.get_last_message_sent_by_me();
    if (
        message === undefined ||
        !narrow_state.filter()?.is_conversation_view() ||
        !message_edit.is_content_editable(message, 5)
    ) {
        return false;
    }
    message_edit.edit_last_sent_message();
    return true;
}

// ---- The channel ----

// "i" opens the channel details, as it opens Slack's channel details.
// Upstream gives the key to the selected message's ⋮ menu, which is
// what it keeps while the user is moving through the feed with the
// keyboard (the state that draws the selection box); with no selection
// showing, the key belongs to the conversation, as Slack has it.
function open_channel_details(): boolean {
    const place = conversation_place();
    if (
        ykphone_keyboard_nav.is_active() ||
        is_ui_layered() ||
        is_text_focused() ||
        (place?.kind !== "channel" && place?.kind !== "thread")
    ) {
        return false;
    }
    ykphone_channel_details_ui.open(place.stream_id, "info");
    return true;
}

// Returns whether the hotkey was handled here.
export function process_hotkey(e: JQuery.KeyDownEvent, hotkey_name: string): boolean {
    if (!is_enabled()) {
        return false;
    }
    if (hotkey_name === "search_with_k" && ykphone_quick_switcher_ui.is_open()) {
        ykphone_quick_switcher_ui.close();
        return true;
    }
    const sequence_page = page_for_gear_menu_sequence(hotkey_name);
    if (sequence_page !== undefined) {
        return open_page(sequence_page);
    }
    if (modals.any_active_or_animating()) {
        return false;
    }
    switch (hotkey_name) {
        case "search_with_k":
            ykphone_quick_switcher_ui.open();
            return true;
        case "ykphone_open_dms":
            return open_page("dms");
        case "ykphone_open_activity":
            return open_page("activity");
        case "ykphone_open_threads":
            return open_page("threads");
        case "ykphone_next_unread_conversation":
            return go_to_unread_conversation(1);
        case "ykphone_previous_unread_conversation":
            return go_to_unread_conversation(-1);
        case "up_arrow":
            // Shift+↑ selects text, as it does in Slack.
            return !e.shiftKey && edit_last_message();
        case "message_actions":
            return open_channel_details();
        default:
            return false;
    }
}

// ---- Escape ----

// Escape in a conversation marks it as read (Slack), which is all it
// does there: Home would be this conversation anyway. Called from
// hotkey.process_escape_key before upstream's own text-field handling,
// and acts only in the cases listed here.
export function process_escape_key(e: JQuery.KeyDownEvent): boolean {
    // Ctrl+[ keeps upstream's meaning (go to the home view).
    if (!is_enabled() || e.key !== "Escape") {
        return false;
    }
    if (is_composing(e)) {
        // The input method cancels the syllable; nothing else happens.
        return true;
    }
    if (is_thread_panel_focused()) {
        // In the thread panel Escape closes the panel, rather than
        // marking the conversation behind it as read.
        ykphone_thread_panel.close();
        return true;
    }
    if (
        is_ui_layered() ||
        ykphone_thread_panel.is_open() ||
        ykphone_pins.get_panel_stream_id() !== undefined ||
        // A box addressed somewhere else is cancelled by upstream,
        // which saves its draft.
        (compose_state.composing() && !ykphone_compose.composer_belongs_to_narrow()) ||
        // Only from the conversation itself: the compose box that
        // belongs to it, or the feed with no text field focused.
        (is_text_focused() && !ykphone_rich_hooks.has_focus())
    ) {
        return false;
    }
    if (!mark_current_conversation_read()) {
        return false;
    }
    // Slack leaves the box where it is; the fork's box gives up the
    // keyboard so that the feed's hotkeys work again.
    ykphone_compose.handle_dismiss();
    return true;
}

// The conversation on screen is marked read: a channel's general chat
// and a thread through upstream's narrow update (the server marks every
// unread message in it, loaded or not), a direct message conversation
// through the ids this client knows, which for direct messages is all
// of them. Returns whether there was a conversation to mark.
export function mark_current_conversation_read(): boolean {
    if (!is_enabled()) {
        return false;
    }
    // On a split page this is the conversation shown beside the list;
    // with nothing selected there is no narrow.
    const place = conversation_place();
    switch (place?.kind) {
        case "channel":
        case "thread": {
            const topic = place.kind === "thread" ? place.topic : "";
            if (unread.num_unread_for_topic(place.stream_id, topic) > 0) {
                unread_ops.mark_topic_as_read(place.stream_id, topic);
            }
            return true;
        }
        case "dm": {
            const user_ids_string = place.user_ids.join(",");
            if (unread.num_unread_for_user_ids_string(user_ids_string) > 0) {
                unread_ops.mark_pm_as_read(user_ids_string);
            }
            return true;
        }
        default:
            return false;
    }
}
