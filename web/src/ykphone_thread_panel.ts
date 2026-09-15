// Slack-style thread side panel for the 옆커폰 fork.
//
// Opening a thread shows its root message and replies in the right
// column, in place of the buddy list, instead of narrowing the main
// feed away from the channel; the "Open in full view" link keeps the
// old topic narrow for everything the panel does not offer. The panel
// is deliberately minimal: no typeahead, uploads, emoji picker or
// reactions here, since the full view has all of those.
//
// This module owns the state and rendering; the DOM event wiring
// lives in ykphone_threads_ui.ts.

import $ from "jquery";
import assert from "minimalistic-assert";
import * as z from "zod/mini";

import render_ykphone_thread_panel from "../templates/ykphone_thread_panel.hbs";
import render_ykphone_thread_panel_body from "../templates/ykphone_thread_panel_body.hbs";
import render_ykphone_thread_root from "../templates/ykphone_thread_root.hbs";

import * as channel from "./channel.ts";
import * as hash_util from "./hash_util.ts";
import {$t} from "./i18n.ts";
import * as message_helper from "./message_helper.ts";
import * as message_store from "./message_store.ts";
import {raw_message_schema} from "./message_store.ts";
import type {Message} from "./message_store.ts";
import * as message_util from "./message_util.ts";
import * as message_viewport from "./message_viewport.ts";
import * as narrow_state from "./narrow_state.ts";
import * as people from "./people.ts";
import * as rendered_markdown from "./rendered_markdown.ts";
import * as stream_data from "./stream_data.ts";
import * as timerender from "./timerender.ts";
import * as unread_ops from "./unread_ops.ts";
import * as ykphone_threads from "./ykphone_threads.ts";
import type {ThreadInfo} from "./ykphone_threads.ts";

const fetch_message_response_schema = z.object({message: raw_message_schema});
const fetch_messages_response_schema = z.object({messages: z.array(raw_message_schema)});

// Only the newest replies are fetched; longer threads show their tail
// here and everything in the full view.
const MAX_REPLIES_FETCHED = 200;

// Consecutive replies from one sender within this window share the
// avatar and name line, like the main feed.
const SENDER_COLLAPSE_SECONDS = 5 * 60;

type MessageRowContext = {
    message_id: number;
    include_sender: boolean;
    is_root: boolean;
    sender_name: string;
    avatar_url: string;
    time_label: string;
    // The time alone, for the gutter of a grouped row.
    gutter_time: string;
    content: string;
};

type PanelStatus = "loading" | "error" | "ready";

let current_thread: ThreadInfo | undefined;
let status: PanelStatus = "loading";
let error_message = "";
let root: Message | undefined;
// Sorted by id. Replies arriving through the event system while the
// fetch is in flight are collected here too, so none are lost.
let replies: Message[] = [];
let pending_requests = 0;
// Bumped on every open, swap, close and failure so that responses to
// requests that no longer matter are ignored.
let load_generation = 0;
// The thread whose reply is being posted; a response for a thread that
// was swapped out must not unblock sending for the current one.
let sending_thread: ThreadInfo | undefined;

function $panel(): JQuery {
    return $("#ykphone-thread-panel");
}

export function is_open(): boolean {
    return current_thread !== undefined;
}

export function get_open_thread(): ThreadInfo | undefined {
    return current_thread;
}

function belongs_to_thread(message: Message, thread: ThreadInfo): boolean {
    return (
        message.type === "stream" &&
        message.stream_id === thread.stream_id &&
        message.topic.toLowerCase() === thread.topic_name.toLowerCase()
    );
}

function time_label(message: Message): string {
    const date = new Date(message.timestamp * 1000);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
        return timerender.get_localized_date_or_time_for_format(date, "time");
    }
    return timerender.get_localized_date_or_time_for_format(
        date,
        date.getFullYear() === now.getFullYear() ? "dayofyear_time" : "dayofyear_year_time",
    );
}

function message_row_context(
    message: Message,
    previous: Message | undefined,
    is_root: boolean,
): MessageRowContext {
    const include_sender =
        previous?.sender_id !== message.sender_id ||
        message.timestamp - previous.timestamp > SENDER_COLLAPSE_SECONDS;
    return {
        message_id: message.id,
        include_sender,
        is_root,
        sender_name: message.sender_full_name,
        avatar_url: people.small_avatar_url(message),
        time_label: time_label(message),
        gutter_time: timerender.get_localized_date_or_time_for_format(
            new Date(message.timestamp * 1000),
            "time",
        ),
        content: message.content,
    };
}

function body_is_near_bottom($body: JQuery): boolean {
    const scroll_top = Number($body.prop("scrollTop"));
    const client_height = Number($body.prop("clientHeight"));
    const scroll_height = Number($body.prop("scrollHeight"));
    return scroll_top + client_height >= scroll_height - 40;
}

function render_body(opts: {keep_scroll_position: boolean}): void {
    const $body = $panel().find(".ykphone-thread-panel-body");
    // Edits and new replies keep the reader's place unless they were
    // already following the end of the thread.
    const follow_end = !opts.keep_scroll_position || body_is_near_bottom($body);
    $body.html(
        render_ykphone_thread_panel_body({
            loading: status === "loading",
            error: status === "error" ? error_message : undefined,
            root: root === undefined ? undefined : message_row_context(root, undefined, true),
            has_replies: replies.length > 0,
            replies: replies.map((message, i) =>
                message_row_context(message, replies[i - 1], false),
            ),
            reply_label: $t(
                {defaultMessage: "{count, plural, one {# reply} other {# replies}}"},
                {count: replies.length},
            ),
        }),
    );
    if (status !== "ready") {
        return;
    }
    rendered_markdown.update_elements($body.find(".rendered_markdown"));
    if (follow_end) {
        $body.prop("scrollTop", Number($body.prop("scrollHeight")));
    }
}

function add_replies(messages: Message[]): Message[] {
    const known_ids = new Set(replies.map((message) => message.id));
    const added = messages.filter((message) => !known_ids.has(message.id));
    if (added.length > 0) {
        replies = [...replies, ...added].toSorted((a, b) => a.id - b.id);
    }
    return added;
}

function fetch_root_message(
    root_message_id: number,
    still_wanted: () => boolean,
    on_success: (message: Message) => void,
    on_error: (xhr: JQuery.jqXHR<unknown>) => void,
): void {
    void channel.get({
        url: `/json/messages/${root_message_id}`,
        // The root lives in the empty "general chat" topic, which
        // must come back as "" rather than as its display name.
        data: {apply_markdown: true, allow_empty_topic_name: true},
        success(raw_data) {
            if (!still_wanted()) {
                return;
            }
            const data = fetch_message_response_schema.parse(raw_data);
            on_success(message_helper.process_new_server_message(data.message));
        },
        error(xhr) {
            if (still_wanted()) {
                on_error(xhr);
            }
        },
    });
}

function fail_loading(xhr: JQuery.jqXHR<unknown>): void {
    // Drop the sibling request's response, if it is still in flight.
    load_generation += 1;
    status = "error";
    error_message = channel.xhr_error_message(
        $t({defaultMessage: "Could not load this thread."}),
        xhr,
    );
    render_body({keep_scroll_position: false});
}

function finish_request(): void {
    pending_requests -= 1;
    if (pending_requests > 0) {
        return;
    }
    assert(root !== undefined);
    status = "ready";
    render_body({keep_scroll_position: false});
    unread_ops.notify_server_messages_read([root, ...replies]);
}

function load(thread: ThreadInfo): void {
    load_generation += 1;
    const generation = load_generation;
    const still_wanted = (): boolean => generation === load_generation;
    pending_requests = 1;

    const cached_root = message_store.get(thread.root_message_id);
    if (cached_root === undefined) {
        pending_requests += 1;
        fetch_root_message(
            thread.root_message_id,
            still_wanted,
            (message) => {
                root = message;
                finish_request();
            },
            fail_loading,
        );
    } else {
        root = cached_root;
    }

    void channel.get({
        url: "/json/messages",
        data: {
            anchor: "newest",
            num_before: MAX_REPLIES_FETCHED,
            num_after: 0,
            narrow: JSON.stringify([
                {operator: "channel", operand: thread.stream_id},
                {operator: "topic", operand: thread.topic_name},
            ]),
            apply_markdown: true,
            client_gravatar: true,
            allow_empty_topic_name: true,
        },
        success(raw_data) {
            if (!still_wanted()) {
                return;
            }
            const fetched = fetch_messages_response_schema
                .parse(raw_data)
                .messages.map((raw_message) =>
                    message_helper.process_new_server_message(raw_message),
                );
            // Like message_fetch, register any unreads the initial
            // state did not include.
            message_util.do_unread_count_updates(fetched, true);
            add_replies(fetched);
            finish_request();
        },
        error(xhr) {
            if (still_wanted()) {
                fail_loading(xhr);
            }
        },
    });
}

export function open_thread(thread: ThreadInfo): void {
    if (current_thread?.root_message_id === thread.root_message_id) {
        // Already showing this thread: keep the draft and the scroll
        // position, just bring the composer back into focus.
        $panel().find(".ykphone-thread-panel-textarea").trigger("focus");
        return;
    }
    current_thread = thread;
    status = "loading";
    error_message = "";
    root = undefined;
    replies = [];
    sending_thread = undefined;

    $panel().html(
        render_ykphone_thread_panel({
            channel: stream_data.get_sub_by_id(thread.stream_id),
            full_view_url: hash_util.by_stream_topic_url(thread.stream_id, thread.topic_name),
        }),
    );
    $("body").addClass("ykphone-thread-open");
    render_body({keep_scroll_position: false});
    load(thread);
    $panel().find(".ykphone-thread-panel-textarea").trigger("focus");
}

// Returns whether a panel was open, so the Escape handler knows
// whether the key was consumed.
export function close(): boolean {
    if (current_thread === undefined) {
        return false;
    }
    const root_message_id = current_thread.root_message_id;
    current_thread = undefined;
    load_generation += 1;
    root = undefined;
    replies = [];
    $("body").removeClass("ykphone-thread-open");
    // Drop the content so a later open never flashes the old thread.
    $panel().html("");
    // Hand keyboard focus back to the control the thread was opened
    // from, when its row is still on screen.
    $(
        `.message_row[data-message-id="${root_message_id}"] .ykphone-thread-button .message-controls-icon`,
    ).trigger("focus");
    return true;
}

// Called by message_view once a narrow is active. In-app navigation
// updates the URL with pushState, so a hashchange listener would only
// see browser back/forward; this hook sees every narrow.
export function handle_narrow_activated(): void {
    close_if_narrowed_to_open_thread();
    update_full_view_root();
}

// The full view of the open thread replaces the panel, whichever way
// the user got there.
export function close_if_narrowed_to_open_thread(): void {
    if (current_thread === undefined) {
        return;
    }
    const topic = narrow_state.topic();
    if (
        narrow_state.stream_id() === current_thread.stream_id &&
        topic?.toLowerCase() === current_thread.topic_name.toLowerCase()
    ) {
        close();
    }
}

export function send_reply(): void {
    if (current_thread === undefined || sending_thread !== undefined) {
        return;
    }
    const $textarea = $panel().find(".ykphone-thread-panel-textarea");
    const raw_content = $textarea.val();
    assert(typeof raw_content === "string");
    const content = raw_content.trim();
    if (content === "") {
        return;
    }

    const thread = current_thread;
    const $send_button = $panel().find(".ykphone-thread-panel-send");
    // An empty error element is hidden by the theme.
    const $error = $panel().find(".ykphone-thread-panel-send-error");
    sending_thread = thread;
    $send_button.prop("disabled", true);

    // The reply itself shows up through the event system, which
    // appends it to the panel and bumps the root's reply count.
    void channel.post({
        url: "/json/messages",
        data: {
            type: "stream",
            to: JSON.stringify([thread.stream_id]),
            topic: thread.topic_name,
            content,
        },
        success() {
            if (sending_thread === thread) {
                sending_thread = undefined;
            }
            if (current_thread !== thread) {
                return;
            }
            $send_button.prop("disabled", false);
            $textarea.val("");
            $error.text("");
        },
        error(xhr) {
            if (sending_thread === thread) {
                sending_thread = undefined;
            }
            if (current_thread !== thread) {
                return;
            }
            $send_button.prop("disabled", false);
            $error.text(
                channel.xhr_error_message($t({defaultMessage: "Failed to send reply."}), xhr),
            );
        },
    });
}

// Hooks called from message_events.

export function on_new_messages(messages: Message[]): void {
    if (current_thread === undefined) {
        return;
    }
    const thread = current_thread;
    // Locally echoed messages get their final id later, through a
    // path this panel does not watch; they only come from the main
    // compose box anyway.
    // TODO: To show them, watch echo.reify_message_id (or the
    // message_events path that calls it) and add the reified message.
    const arrived = add_replies(
        messages.filter((message) => !message.locally_echoed && belongs_to_thread(message, thread)),
    );
    if (arrived.length === 0 || status !== "ready") {
        return;
    }
    render_body({keep_scroll_position: true});
    if (unread_ops.is_window_focused()) {
        unread_ops.notify_server_messages_read(arrived);
    }
}

export function on_messages_removed(message_ids: number[]): void {
    if (current_thread !== undefined) {
        if (message_ids.includes(current_thread.root_message_id)) {
            close();
        } else {
            const remaining = replies.filter((message) => !message_ids.includes(message.id));
            if (remaining.length !== replies.length) {
                replies = remaining;
                if (status === "ready") {
                    render_body({keep_scroll_position: true});
                }
            }
        }
    }
    if (full_view_root_affected(message_ids)) {
        update_full_view_root();
    }
}

export function on_messages_updated(message_ids: number[]): void {
    if (current_thread !== undefined) {
        const thread = current_thread;
        const affected = new Set(message_ids);
        // Edited messages are re-read from the message store, which
        // message_events has already updated.
        const remaining = replies.filter(
            (message) => !affected.has(message.id) || belongs_to_thread(message, thread),
        );
        if (remaining.length !== replies.length) {
            // Replies were moved to another topic. The server-side
            // thread link does not follow moves, so the panel cannot
            // learn the new name; closing beats sending later replies
            // into a stale topic.
            close();
        } else {
            const changed =
                (root !== undefined && affected.has(root.id)) ||
                remaining.some((message) => affected.has(message.id));
            if (changed && status === "ready") {
                render_body({keep_scroll_position: true});
            }
        }
    }
    if (full_view_root_affected(message_ids)) {
        update_full_view_root();
    }
}

// Full view: in a thread's topic narrow, the root message is shown
// above the feed so the conversation reads from its start there too.

// The root currently shown (or being fetched) for the narrow.
let full_view_root_id: number | undefined;
let full_view_fetching = false;

function full_view_root_affected(message_ids: number[]): boolean {
    return full_view_root_id !== undefined && message_ids.includes(full_view_root_id);
}

// The block is inserted after the narrow has positioned the selected
// message (hashchange fires afterwards, and the thread-list and root
// fetches land later still), so the feed is scrolled by the block's
// change in height to keep the reader's rows where they were.
// Recentering the selected message instead would move a feed the user
// may already have scrolled through.
function set_full_view_root_html(html: string): void {
    const $root = $("#ykphone-thread-root");
    const height_before = $root.outerHeight()!;
    $root.html(html);
    const delta = $root.outerHeight()! - height_before;
    const scroll_top = message_viewport.scrollTop();
    if (delta !== 0 && scroll_top > 0) {
        message_viewport.scrollTop(scroll_top + delta);
    }
}

export function update_full_view_root(): void {
    const filter = narrow_state.filter();
    const stream_id = narrow_state.stream_id(filter);
    const topic = narrow_state.topic(filter);
    // Only the plain conversation view of the topic is the thread's
    // own view; a search within it is not.
    const thread =
        filter === undefined ||
        !filter.is_conversation_view() ||
        stream_id === undefined ||
        topic === undefined
            ? undefined
            : ykphone_threads.get_thread_for_topic(stream_id, topic);
    if (thread === undefined) {
        full_view_root_id = undefined;
        full_view_fetching = false;
        set_full_view_root_html("");
        return;
    }

    const root_id = thread.root_message_id;
    const message = message_store.get(root_id);
    if (message === undefined) {
        if (full_view_fetching && full_view_root_id === root_id) {
            return;
        }
        full_view_root_id = root_id;
        full_view_fetching = true;
        fetch_root_message(
            root_id,
            () => full_view_fetching && full_view_root_id === root_id,
            () => {
                full_view_fetching = false;
                update_full_view_root();
            },
            () => {
                full_view_fetching = false;
            },
        );
        return;
    }

    full_view_root_id = root_id;
    full_view_fetching = false;
    set_full_view_root_html(
        render_ykphone_thread_root({message: message_row_context(message, undefined, true)}),
    );
    rendered_markdown.update_elements($("#ykphone-thread-root").find(".rendered_markdown"));
}

export function clear_for_testing(): void {
    current_thread = undefined;
    status = "loading";
    error_message = "";
    root = undefined;
    replies = [];
    pending_requests = 0;
    load_generation += 1;
    sending_thread = undefined;
    full_view_root_id = undefined;
    full_view_fetching = false;
}
