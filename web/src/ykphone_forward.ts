// The pending forward for the 옆커폰 fork: the message shown as a card
// above the compose box while the user writes their note, and the quote
// markdown that is folded in front of that note when the message is
// sent.
//
// Upstream's "Forward message" pastes the markdown into the compose box,
// so the user edits a wall of ```quote fences. Slack keeps the forwarded
// message as a card of its own and leaves the box for the note. The
// price of that is state outside the textarea, which everything that
// replaces the compose contents has to know about — hence the small
// surface here, called from compose.ts, compose_actions.ts, drafts.ts
// and reload_setup.ts:
//
//   arm/clear              a forward is started / the box was replaced
//   apply_to_compose       fold the quote in, just before the send
//   restore                the send did not happen; put the note and
//                          the card back
//   remember_for_draft     the box was saved as a draft: the forward
//   restore_for_draft      rides along with it, through a reload too
//   forget_drafts          the draft is gone, so is its forward
//
// Everything the card and the quote need is stored, so a restore never
// has to reach back into the message store (a message may not be there
// after a reload) or rebuild the markdown. Building those inputs is
// ykphone_forward_ui's job; this module is imported by upstream files,
// so its imports must stay clear of compose_actions/compose_reply.

import $ from "jquery";
import * as z from "zod/mini";

import render_ykphone_forward_card from "../templates/ykphone_forward_card.hbs";

import * as compose_state from "./compose_state.ts";
import * as compose_ui from "./compose_ui.ts";
import {localstorage} from "./localstorage.ts";
import * as rendered_markdown from "./rendered_markdown.ts";

const forward_schema = z.object({
    card: z.object({
        message_id: z.number(),
        sender_name: z.string(),
        avatar_url: z.string(),
        time_label: z.string(),
        content: z.string(),
    }),
    markdown: z.string(),
});
const stored_forwards_schema = z.record(z.string(), forward_schema);

export type ForwardCard = z.infer<typeof forward_schema>["card"];
export type PendingForward = z.infer<typeof forward_schema>;

const STORAGE_KEY = "ykphone-forwards";
// Drafts are deleted through forget_drafts, but a draft removed while
// another tab held the lock would leave an entry behind; keeping only
// the newest few bounds the damage.
const MAX_STORED_FORWARDS = 20;

// The forward the compose box is currently carrying.
let pending: PendingForward | undefined;
// Set between apply_to_compose() and the send being accepted or
// abandoned, so that a send that never happens can be undone.
let applied: {forward: PendingForward; note: string} | undefined;

function $textarea(): JQuery<HTMLTextAreaElement> {
    return $<HTMLTextAreaElement>("textarea#compose-textarea");
}

// The card's mount point is added once, above the compose form, by
// ykphone_threads_ui.
function $card_container(): JQuery {
    return $("#ykphone-forward-card-container");
}

function remove_card(): void {
    $card_container().empty();
}

function show_card(forward: PendingForward): void {
    $card_container().html(render_ykphone_forward_card(forward.card));
    // Post-processing (timestamps, user mentions, spoilers) is applied
    // once the card is in the document, as the message feed does.
    rendered_markdown.update_elements($("#ykphone-forward-card .ykphone-forward-card-content"));
}

export function pending_message_id(): number | undefined {
    return pending?.card.message_id;
}

export function arm(forward: PendingForward): void {
    pending = forward;
    applied = undefined;
    show_card(forward);
}

// The raw markdown of the forwarded message usually arrives after the
// card is up; until then the card carries a fallback built from the
// rendered HTML.
export function set_markdown(message_id: number, markdown: string): void {
    if (pending?.card.message_id === message_id) {
        pending.markdown = markdown;
    }
}

// The compose box's contents were replaced or thrown away: the forward
// goes with them. Any draft that was saved first keeps it (see
// remember_for_draft).
export function clear(): void {
    pending = undefined;
    applied = undefined;
    remove_card();
}

// Called from compose.finish once the content is about to be read: the
// quote goes in front of the note the user typed and the card steps
// aside. It is not dropped yet — the send can still fail.
export function apply_to_compose(): void {
    if (pending === undefined) {
        return;
    }
    const note = compose_state.message_content();
    compose_state.message_content(
        note === "" ? pending.markdown : `${pending.markdown}\n\n${note}`,
    );
    compose_ui.autosize_textarea($textarea());
    applied = {forward: pending, note};
    pending = undefined;
    $("#ykphone-forward-card").hide();
}

// The message did not go out (it failed validation, or the server
// refused it): give the user back their note and their card rather than
// the wall of markdown this feature exists to hide.
export function restore(): void {
    if (applied === undefined) {
        return;
    }
    pending = applied.forward;
    compose_state.message_content(applied.note);
    compose_ui.autosize_textarea($textarea());
    applied = undefined;
    $("#ykphone-forward-card").show();
}

function stored_forwards(): Record<string, PendingForward> {
    const raw = localstorage().get(STORAGE_KEY);
    if (raw === undefined) {
        return {};
    }
    const parsed = stored_forwards_schema.safeParse(raw);
    return parsed.success ? parsed.data : {};
}

function set_stored_forwards(forwards: Record<string, PendingForward>): void {
    const keys = Object.keys(forwards);
    const kept = keys.slice(Math.max(0, keys.length - MAX_STORED_FORWARDS));
    localstorage().set(STORAGE_KEY, Object.fromEntries(kept.map((key) => [key, forwards[key]])));
}

// Called whenever the compose box is saved as a draft, so that closing
// the box, switching conversations or reloading for a new version all
// keep the forward with the text it belongs to. A box with no forward
// clears the draft's entry, so a draft cannot resurrect an old one.
export function remember_for_draft(draft_id: string): void {
    const forwards = stored_forwards();
    if (pending === undefined) {
        if (forwards[draft_id] === undefined) {
            return;
        }
        delete forwards[draft_id];
    } else {
        forwards[draft_id] = pending;
    }
    set_stored_forwards(forwards);
}

// Called when a draft is restored into the compose box.
export function restore_for_draft(draft_id: string): void {
    const forward = stored_forwards()[draft_id];
    if (forward === undefined) {
        return;
    }
    arm(forward);
}

export function forget_drafts(draft_ids: string[]): void {
    const forwards = stored_forwards();
    if (!draft_ids.some((draft_id) => forwards[draft_id] !== undefined)) {
        return;
    }
    for (const draft_id of draft_ids) {
        delete forwards[draft_id];
    }
    set_stored_forwards(forwards);
}

export function clear_for_testing(): void {
    pending = undefined;
    applied = undefined;
}
