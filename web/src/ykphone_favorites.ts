// Slack-style favourites for the 옆커폰 fork.
//
// Upstream's "pin channel to top" is shown as Slack's Starred /
// favourites section: the menu items read "add to / remove from
// favourites" and channel rows can be dragged into the section and out
// of it. Dropping sets the subscription's pin_to_top through the same
// API the menu item uses, and upstream's subscription event then
// re-renders the list. This module holds the decision logic; the drag
// events are wired in ykphone_favorites_ui.ts.

import assert from "minimalistic-assert";

import * as stream_data from "./stream_data.ts";
import * as stream_settings_api from "./stream_settings_api.ts";

// The id stream_list_sort gives the pinned section.
export const FAVORITES_SECTION_ID = "pinned-streams";

// The pin_to_top value a drop on the given section asks for, or
// undefined when the channel is already there.
export function pin_value_for_drop(section_id: string, pin_to_top: boolean): boolean | undefined {
    const dropped_on_favorites = section_id === FAVORITES_SECTION_ID;
    if (dropped_on_favorites === pin_to_top) {
        return undefined;
    }
    return dropped_on_favorites;
}

function requested_value(stream_id: number, section_id: string): boolean | undefined {
    const sub = stream_data.get_sub_by_id(stream_id);
    if (sub === undefined) {
        return undefined;
    }
    return pin_value_for_drop(section_id, sub.pin_to_top);
}

// Whether dropping the channel on the section would change anything;
// the drop targets only light up when it would.
export function can_drop(stream_id: number, section_id: string): boolean {
    return requested_value(stream_id, section_id) !== undefined;
}

// Returns whether a change was requested.
export function handle_drop(stream_id: number, section_id: string): boolean {
    const value = requested_value(stream_id, section_id);
    if (value === undefined) {
        return false;
    }
    const sub = stream_data.get_sub_by_id(stream_id);
    assert(sub !== undefined);
    stream_settings_api.set_stream_property(sub, {property: "pin_to_top", value});
    return true;
}
