// Slack-style pinned messages for the 옆커폰 fork.
//
// A pin marks a channel message as worth keeping at hand; the server
// stores the pins (see ykphone/models.py) and sends a ykphone_pin
// event to the channel's subscribers when one is added or removed.
// This module caches the pins per channel for the feed's "pinned by"
// line, the message menu, the pane header's count and the pins panel,
// and keeps the panel's open/closed state. The DOM work lives in
// ykphone_pins_ui.ts, which listens for changes here.

import * as z from "zod/mini";

import * as channel from "./channel.ts";
import * as feedback_widget from "./feedback_widget.ts";
import * as hash_util from "./hash_util.ts";
import {$t} from "./i18n.ts";
import type {Message} from "./message_store.ts";
import {page_params} from "./page_params.ts";
import * as people from "./people.ts";
import * as ykphone_time from "./ykphone_time.ts";

const pin_schema = z.object({
    message_id: z.number(),
    stream_id: z.number(),
    topic_name: z.string(),
    pinned_by_user_id: z.nullable(z.number()),
    date_pinned: z.number(),
    sender_id: z.number(),
    sender_full_name: z.string(),
    timestamp: z.number(),
    content: z.string(),
});
const pins_response_schema = z.object({pins: z.array(pin_schema)});
const pin_event_schema = z.discriminatedUnion("op", [
    z.object({type: z.literal("ykphone_pin"), op: z.literal("add"), pin: pin_schema}),
    z.object({
        type: z.literal("ykphone_pin"),
        op: z.literal("remove"),
        stream_id: z.number(),
        message_id: z.number(),
    }),
]);

export type PinInfo = z.infer<typeof pin_schema>;

export type PinLineContext = {
    pinned_by_label: string;
};

export type PinMenuContext = {
    message_id: number;
    is_pinned: boolean;
};

// One row of the pins panel.
export type PinRowContext = {
    message_id: number;
    sender_name: string;
    avatar_url: string;
    time_label: string;
    content: string;
    pinned_by_label: string;
    jump_url: string;
};

// Called with the channel and the messages whose pin state changed, so
// their rows can be re-rendered; an empty list means only the channel's
// list (order, count) may have changed.
type ChangeListener = (stream_id: number, message_ids: number[]) => void;
type PanelListener = () => void;

const pins_by_message = new Map<number, PinInfo>();
const loaded_streams = new Set<number>();
const loading_streams = new Set<number>();
// Channels whose pins could not be fetched; rendering must not retry
// these on every pass, an explicit forced load may.
const failed_streams = new Set<number>();
const change_listeners: ChangeListener[] = [];
const panel_listeners: PanelListener[] = [];
// The channel whose pins panel is open, if any.
let panel_stream_id: number | undefined;

export function on_pins_changed(listener: ChangeListener): void {
    change_listeners.push(listener);
}

export function on_panel_changed(listener: PanelListener): void {
    panel_listeners.push(listener);
}

function notify_change(stream_id: number, message_ids: number[]): void {
    for (const listener of change_listeners) {
        listener(stream_id, message_ids);
    }
}

export function is_pinned(message_id: number): boolean {
    return pins_by_message.has(message_id);
}

export function get_pin(message_id: number): PinInfo | undefined {
    return pins_by_message.get(message_id);
}

// Newest pin first.
export function pins_for_stream(stream_id: number): PinInfo[] {
    return [...pins_by_message.values()]
        .filter((pin) => pin.stream_id === stream_id)
        .toSorted((a, b) => b.date_pinned - a.date_pinned || b.message_id - a.message_id);
}

export function pin_count(stream_id: number): number {
    return pins_for_stream(stream_id).length;
}

export function can_pin(message: Message): boolean {
    return !page_params.is_spectator && message.type === "stream";
}

export function pinned_by_label(pin: PinInfo): string {
    const pinner =
        pin.pinned_by_user_id === null
            ? undefined
            : people.maybe_get_user_by_id(pin.pinned_by_user_id, true);
    if (pinner === undefined) {
        return $t({defaultMessage: "Pinned to this channel"});
    }
    return $t({defaultMessage: "Pinned by {name}"}, {name: pinner.full_name});
}

// Called while building message rows, so it must stay cheap; the
// first look at a channel kicks off a fetch and the rows re-render
// when it lands.
export function get_pin_line_context(message: Message): PinLineContext | undefined {
    // The pin endpoints need a logged-in user; a spectator's request
    // would open the login prompt on its own.
    if (page_params.is_spectator || message.type !== "stream") {
        return undefined;
    }
    load_stream_pins(message.stream_id);
    const pin = pins_by_message.get(message.id);
    if (pin === undefined) {
        return undefined;
    }
    return {pinned_by_label: pinned_by_label(pin)};
}

export function get_menu_context(message: Message): PinMenuContext | undefined {
    if (!can_pin(message)) {
        return undefined;
    }
    return {message_id: message.id, is_pinned: pins_by_message.has(message.id)};
}

function apply_add(pin: PinInfo): void {
    const previous = pins_by_message.get(pin.message_id);
    pins_by_message.set(pin.message_id, pin);
    notify_change(
        pin.stream_id,
        previous?.pinned_by_user_id === pin.pinned_by_user_id ? [] : [pin.message_id],
    );
}

function apply_remove(stream_id: number, message_id: number): void {
    if (!pins_by_message.delete(message_id)) {
        return;
    }
    notify_change(stream_id, [message_id]);
}

export function load_stream_pins(stream_id: number, force = false): void {
    if (
        loading_streams.has(stream_id) ||
        ((loaded_streams.has(stream_id) || failed_streams.has(stream_id)) && !force)
    ) {
        return;
    }
    loading_streams.add(stream_id);
    void channel.get({
        url: "/json/ykphone/pins",
        data: {stream_id},
        success(raw_data) {
            loading_streams.delete(stream_id);
            loaded_streams.add(stream_id);
            failed_streams.delete(stream_id);
            const fresh = new Map(
                pins_response_schema
                    .parse(raw_data)
                    .pins.map((pin) => [pin.message_id, pin] as const),
            );
            const changed: number[] = [];
            for (const pin of pins_for_stream(stream_id)) {
                if (!fresh.has(pin.message_id)) {
                    pins_by_message.delete(pin.message_id);
                    changed.push(pin.message_id);
                }
            }
            for (const pin of fresh.values()) {
                const previous = pins_by_message.get(pin.message_id);
                if (previous?.pinned_by_user_id !== pin.pinned_by_user_id) {
                    changed.push(pin.message_id);
                }
                pins_by_message.set(pin.message_id, pin);
            }
            notify_change(stream_id, changed);
        },
        error() {
            loading_streams.delete(stream_id);
            failed_streams.add(stream_id);
        },
    });
}

function report_failure(title: string, message: string, xhr: JQuery.jqXHR<unknown>): void {
    const text = channel.xhr_error_message(message, xhr);
    feedback_widget.show({
        title_text: title,
        populate($container) {
            $container.text(text);
        },
    });
}

export function pin(message_id: number): void {
    void channel.post({
        url: "/json/ykphone/pins",
        data: {message_id},
        success(raw_data) {
            // The event says the same, whichever arrives first.
            apply_add(pin_schema.parse(raw_data));
        },
        error(xhr) {
            report_failure(
                $t({defaultMessage: "Pin"}),
                $t({defaultMessage: "Could not pin this message."}),
                xhr,
            );
        },
    });
}

export function unpin(message_id: number): void {
    const pinned = pins_by_message.get(message_id);
    void channel.del({
        url: `/json/ykphone/pins/${message_id}`,
        success() {
            if (pinned !== undefined) {
                apply_remove(pinned.stream_id, message_id);
            }
        },
        error(xhr) {
            report_failure(
                $t({defaultMessage: "Pin"}),
                $t({defaultMessage: "Could not unpin this message."}),
                xhr,
            );
        },
    });
}

export function handle_event(raw_event: unknown): void {
    const event = pin_event_schema.parse(raw_event);
    if (event.op === "add") {
        apply_add(event.pin);
    } else {
        apply_remove(event.stream_id, event.message_id);
    }
}

// Deleting a message deletes its pin on the server without an event.
export function on_messages_removed(message_ids: number[]): void {
    for (const message_id of message_ids) {
        const pin = pins_by_message.get(message_id);
        if (pin !== undefined) {
            apply_remove(pin.stream_id, message_id);
        }
    }
}

// The time only for today's messages, date and time otherwise, like
// the thread panel.
export function time_label(timestamp: number): string {
    return ykphone_time.day_or_time(timestamp);
}

export function pin_row_context(pin: PinInfo): PinRowContext {
    const sender = people.maybe_get_user_by_id(pin.sender_id, true);
    return {
        message_id: pin.message_id,
        sender_name: pin.sender_full_name,
        // The server serves avatars by user id, so a sender who is not
        // in the user store (a deactivated user, say) still gets one.
        avatar_url:
            sender === undefined
                ? `/avatar/${pin.sender_id}`
                : people.small_avatar_url_for_person(sender),
        time_label: time_label(pin.timestamp),
        content: pin.content,
        pinned_by_label: pinned_by_label(pin),
        jump_url: hash_util.search_terms_to_hash([
            {operator: "channel", operand: pin.stream_id.toString()},
            {operator: "topic", operand: pin.topic_name},
            {operator: "near", operand: pin.message_id.toString()},
        ]),
    };
}

export function get_panel_stream_id(): number | undefined {
    return panel_stream_id;
}

// The panel belongs to the channel whose Messages/Pins tabs are on
// screen: the channel narrow or its general chat. Any other narrow (a
// different channel, a thread's full view, the Files tab, a view)
// closes it.
export function handle_narrow_activated(opts: {
    stream_id: number | undefined;
    topic: string | undefined;
    is_files_narrow: boolean;
}): void {
    if (panel_stream_id === undefined) {
        return;
    }
    const room_stream_id =
        opts.is_files_narrow || (opts.topic !== undefined && opts.topic !== "")
            ? undefined
            : opts.stream_id;
    if (room_stream_id !== panel_stream_id) {
        close_panel();
    }
}

function notify_panel(): void {
    for (const listener of panel_listeners) {
        listener();
    }
}

export function open_panel(stream_id: number): void {
    if (panel_stream_id === stream_id) {
        return;
    }
    panel_stream_id = stream_id;
    load_stream_pins(stream_id, true);
    notify_panel();
}

// Returns whether a panel was open, so the Escape handler knows
// whether the key was consumed.
export function close_panel(): boolean {
    if (panel_stream_id === undefined) {
        return false;
    }
    panel_stream_id = undefined;
    notify_panel();
    return true;
}

export function toggle_panel(stream_id: number): void {
    if (panel_stream_id === stream_id) {
        close_panel();
    } else {
        open_panel(stream_id);
    }
}

export function clear_for_testing(): void {
    pins_by_message.clear();
    loaded_streams.clear();
    loading_streams.clear();
    failed_streams.clear();
    change_listeners.length = 0;
    panel_listeners.length = 0;
    panel_stream_id = undefined;
}
