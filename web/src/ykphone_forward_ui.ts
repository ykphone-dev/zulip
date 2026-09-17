// Starting a Slack-style forward in the 옆커폰 fork: build the card and
// the quote markdown for a message, open an empty compose box on it, and
// hand both to ykphone_forward, which owns them from then on.
//
// The split matters for imports: ykphone_forward is called from upstream
// files (compose, compose_actions, drafts, reload_setup), so it cannot
// reach compose_reply or compose_actions; everything that does lives
// here. This module is mounting and glue, so it is exempt from node
// coverage — the pieces worth testing (quote_markdown, card_context) are
// exported and covered.

import * as blueslip from "./blueslip.ts";
import * as compose_actions from "./compose_actions.ts";
import * as compose_paste from "./compose_paste.ts";
import * as compose_recipient from "./compose_recipient.ts";
import * as compose_reply from "./compose_reply.ts";
import * as compose_state from "./compose_state.ts";
import * as fenced_code from "./fenced_code.ts";
import * as hash_util from "./hash_util.ts";
import {$t} from "./i18n.ts";
import * as message_fetch_raw_content from "./message_fetch_raw_content.ts";
import type {Message} from "./message_store.ts";
import * as message_store from "./message_store.ts";
import * as people from "./people.ts";
import * as sub_store from "./sub_store.ts";
import * as timerender from "./timerender.ts";
import * as topic_link_util from "./topic_link_util.ts";
import type {ForwardCard} from "./ykphone_forward.ts";
import * as ykphone_forward from "./ykphone_forward.ts";

// Upstream waits this long for the raw markdown before falling back, so
// that a slow or offline server does not block quoting.
const RAW_CONTENT_TIMEOUT_MS = 1000;

export function card_context(message: Message): ForwardCard {
    return {
        message_id: message.id,
        sender_name: message.sender_full_name,
        avatar_url: people.small_avatar_url(message),
        // The same format ykphone_quote_card puts on the rendered
        // card, so the preview and the result agree. A forward often
        // carries a message from days ago, which a bare clock would
        // misdate.
        time_label: timerender.get_localized_date_or_time_for_format(
            new Date(message.timestamp * 1000),
            "dayofyear_time",
        ),
        content: message.content,
    };
}

// A channel's general chat is the empty topic, which upstream's quote
// header renders as a dangling "#channel > "; in the fork a channel *is*
// its general chat, so the header names the channel alone. Every other
// case goes through upstream's generator unchanged, so a forwarded
// message reads exactly as it does upstream.
function general_chat_quote(message: Message & {type: "stream"}, raw_markdown: string): string {
    const channel_name = sub_store.maybe_get_stream_name(message.stream_id);
    const header = $t(
        {defaultMessage: "{username} [said]({link_to_message}) in {channel_link}:"},
        {
            username: `@_**${message.sender_full_name}|${message.sender_id}**`,
            link_to_message: hash_util.by_conversation_and_time_url(message),
            channel_link:
                channel_name === undefined
                    ? ""
                    : topic_link_util.get_stream_link_syntax(channel_name),
        },
    );
    const fence = fenced_code.get_unused_fence(raw_markdown);
    return `${header}\n${fence}quote\n${raw_markdown}\n${fence}`;
}

export function quote_markdown(message: Message, raw_markdown: string): string {
    if (message.type === "stream" && message.topic === "") {
        return general_chat_quote(message, raw_markdown);
    }
    return compose_reply.generate_replace_content({
        quoted_message: message,
        raw_markdown,
        forward_message: true,
    });
}

// Upstream's own fallback when the raw markdown cannot be fetched.
export function fallback_markdown(message: Message): string {
    return message.raw_content ?? compose_paste.paste_handler_converter(message.content);
}

export function start(message_id: number): void {
    const message = message_store.get(message_id);
    if (message === undefined) {
        // Both entry points (the actions menu and the "<" hotkey) take
        // the message from a rendered row, so this cannot normally
        // happen.
        blueslip.warn("Tried to forward a message that is not in the store.", {message_id});
        return;
    }
    // A forward started while another was pending replaces it, and the
    // compose box below replaces the contents either way.
    ykphone_forward.clear();
    compose_state.set_is_processing_forward_message(true);
    // Like upstream's forward, the compose box opens on the forwarded
    // message's own conversation with the recipient picker open, so the
    // first thing the user does is choose where it goes; unlike
    // upstream's, the box itself stays empty for their note.
    compose_actions.start({
        message_type: message.type,
        topic: message.type === "stream" ? message.topic : "",
        stream_id: message.type === "stream" ? message.stream_id : undefined,
        private_message_recipient_ids: [],
        keep_composebox_empty: true,
        trigger: "ykphone forward",
    });
    if (!compose_state.composing()) {
        // start() declines to open the box for a spectator, during a
        // reload, and for a channel the user cannot post to. Arming a
        // forward that has no visible card would attach its quote to
        // the user's next message anywhere in the app.
        return;
    }
    compose_recipient.toggle_compose_recipient_dropdown();
    // The card goes up with a fallback quote so that a draft saved (or a
    // reload taken) before the fetch answers still carries the message;
    // the fetch below upgrades it to the sender's own markdown.
    ykphone_forward.arm({
        card: card_context(message),
        markdown: quote_markdown(message, fallback_markdown(message)),
    });
    message_fetch_raw_content.get_raw_content_for_single_message({
        message_id,
        timeout_ms: RAW_CONTENT_TIMEOUT_MS,
        on_success(raw_content) {
            ykphone_forward.set_markdown(message_id, quote_markdown(message, raw_content));
        },
        on_error() {
            // The card already carries the fallback.
        },
    });
}
