// Keeps the composer open in a conversation, as Slack does: the box is
// opened for the conversation on screen from the narrow-activated hook
// (a channel the user may post to, or a direct message conversation
// the user may write to), and opened again after upstream closes it
// (the close button, a hotkey flow that cancels first). Below the md
// breakpoint the open box would cover the feed on a phone, so
// upstream's collapsed bar stays there.
//
// This lives apart from ykphone_compose because it needs
// compose_actions, which compose_recipient (a caller of
// ykphone_compose) sits underneath.

import * as compose_actions from "./compose_actions.ts";
import type {NarrowActivateOpts} from "./compose_actions.ts";
import * as compose_state from "./compose_state.ts";
import * as message_util from "./message_util.ts";
import * as narrow_state from "./narrow_state.ts";
import {page_params} from "./page_params.ts";
import * as stream_data from "./stream_data.ts";
import * as ui_util from "./ui_util.ts";
import * as util from "./util.ts";
import * as ykphone_compose from "./ykphone_compose.ts";

export const TRIGGER = "ykphone conversation";

// Narrows reached by hotkeys must leave the keyboard in the feed, or
// the next hotkey would be typed into the box.
const KEYBOARD_TRIGGERS = new Set(["hotkey", "next_topic_unread_hotkey"]);

// A channel the user may post to (announcement-only and archived
// channels get upstream's collapsed bar, which explains why).
function can_open_for_channel(): boolean {
    const target = ykphone_compose.channel_narrow_target();
    if (target === undefined) {
        return false;
    }
    const sub = stream_data.get_sub_by_id(target.stream_id);
    return sub !== undefined && stream_data.can_post_messages_in_stream(sub);
}

// A direct message conversation with valid recipients the user may
// write to: the same checks upstream's on_narrow makes before it opens
// the box itself.
function can_open_for_direct_messages(): boolean {
    const filter = narrow_state.filter();
    if (filter === undefined || !narrow_state.narrowed_by_pm_reply(filter)) {
        return false;
    }
    const user_ids = narrow_state.set_compose_defaults().private_message_recipient_ids ?? [];
    return (
        user_ids.length > 0 &&
        message_util.user_can_send_direct_message(util.sorted_ids(user_ids).join(","))
    );
}

export function auto_open_target(): "stream" | "private" | undefined {
    if (page_params.is_spectator || !ui_util.matches_viewport_state("gte_md_min")) {
        return undefined;
    }
    if (can_open_for_channel()) {
        return "stream";
    }
    if (can_open_for_direct_messages()) {
        return "private";
    }
    return undefined;
}

export function open(message_type: "stream" | "private", opts: {focus: boolean}): void {
    const previously_focused = document.activeElement;
    compose_actions.start({
        message_type,
        trigger: TRIGGER,
        // The narrow has already placed the selected message.
        skip_scrolling_selected_message: true,
        // Deferred like upstream's own direct message auto-open, to
        // avoid a whole-screen scrolling bug on iPad/Safari.
        defer_focus: opts.focus,
    });
    if (!opts.focus) {
        // start() focused the textarea synchronously; hand focus back.
        if (previously_focused instanceof HTMLElement && previously_focused !== document.body) {
            previously_focused.focus();
        } else {
            compose_actions.blur_compose_inputs();
        }
    }
    ykphone_compose.update_recipient_row();
}

function is_keyboard_narrow(opts: NarrowActivateOpts): boolean {
    return opts.force_close === true || KEYBOARD_TRIGGERS.has(opts.trigger ?? "");
}

export function handle_narrow_activated(opts: NarrowActivateOpts): void {
    ykphone_compose.update_recipient_row();
    if (compose_state.composing()) {
        // Upstream kept the box open (a topic hop within the channel, a
        // direct message narrow) and, in the topic case, focused it;
        // a keyboard hop must not end with the next key in the box.
        if (is_keyboard_narrow(opts)) {
            compose_actions.blur_compose_inputs();
        }
        return;
    }
    const message_type = auto_open_target();
    if (message_type === undefined) {
        return;
    }
    open(message_type, {focus: !is_keyboard_narrow(opts)});
}

// After upstream cancels the box (the close button, a hotkey flow that
// cancels first, `p` between direct message conversations) the
// conversation's box comes back, without taking focus from whatever
// the user moved to.
export function reopen_after_cancel(): void {
    if (compose_state.composing()) {
        return;
    }
    const message_type = auto_open_target();
    if (message_type === undefined) {
        return;
    }
    open(message_type, {focus: false});
}

export function initialize(): void {
    compose_actions.register_compose_cancel_hook(() => {
        // cancel() finishes its own teardown after the hooks run, so
        // the reopen waits for the current call stack; a microtask
        // keeps it within the same frame, so the box never paints
        // closed.
        queueMicrotask(reopen_after_cancel);
    });
}
