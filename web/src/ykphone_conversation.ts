// Conversation-level UI for the 옆커폰 fork: the body class that turns
// the recipient bars into Slack's date pills while one conversation is
// on screen, the intro block at the top of a conversation's history
// (in place of upstream's logo) and the empty states of the Files
// views. Rendering is driven by upstream's narrow and
// top-of-narrow hooks; the mount point is added by ykphone_threads_ui.

import $ from "jquery";

import render_ykphone_conversation_intro from "../templates/ykphone_conversation_intro.hbs";

import type {Filter} from "./filter.ts";
import * as hash_util from "./hash_util.ts";
import {$t} from "./i18n.ts";
import type {MessageList} from "./message_list.ts";
import * as message_store from "./message_store.ts";
import type {NarrowBannerData} from "./narrow_error.ts";
import * as narrow_state from "./narrow_state.ts";
import * as people from "./people.ts";
import * as rendered_markdown from "./rendered_markdown.ts";
import * as stream_data from "./stream_data.ts";
import * as timerender from "./timerender.ts";

export type IntroContext =
    | {
          channel: {
              name: string;
              invite_only: boolean;
              is_web_public: boolean;
              is_archived: boolean;
              description_html: string;
              created_label: string | undefined;
              settings_url: string;
          };
          dm?: undefined;
      }
    | {
          channel?: undefined;
          dm: {
              avatar_urls: string[];
              names: string;
              is_self: boolean;
          };
      };

// One channel or direct message conversation: the narrows Slack
// shows as a single room, with date pills instead of recipient bars.
export function is_conversation(filter: Filter | undefined): boolean {
    return filter?.is_conversation_view() ?? false;
}

// The Files tab of a channel is a search for its messages with
// attachments.
export function is_channel_files_narrow(filter: Filter): boolean {
    return filter.sorted_term_types().join(" ") === "channel has-attachment";
}

// The rail's Files view: every message with an attachment.
export function is_files_narrow(filter: Filter): boolean {
    return filter.sorted_term_types().join(" ") === "has-attachment";
}

export function empty_narrow_banner(filter: Filter): NarrowBannerData | undefined {
    if (is_channel_files_narrow(filter)) {
        return {title: $t({defaultMessage: "No files have been shared in this channel yet."})};
    }
    if (is_files_narrow(filter)) {
        return {title: $t({defaultMessage: "No files have been shared yet."})};
    }
    return undefined;
}

export function update_body_class(): void {
    $("body").toggleClass("ykphone-conversation", is_conversation(narrow_state.filter()));
}

function created_label(date_created: number, creator_id: number | null): string | undefined {
    const date = timerender.get_localized_date_or_time_for_format(
        new Date(date_created * 1000),
        "dayofyear_year",
    );
    const creator = creator_id === null ? undefined : people.maybe_get_user_by_id(creator_id, true);
    if (creator === undefined) {
        return $t({defaultMessage: "Created on {date}."}, {date});
    }
    return $t({defaultMessage: "Created by {name} on {date}."}, {name: creator.full_name, date});
}

// The intro belongs to a channel's general chat and to direct message
// conversations; a thread's full view (a topic narrow) has none.
export function intro_context(filter: Filter | undefined): IntroContext | undefined {
    if (!is_conversation(filter)) {
        return undefined;
    }
    const stream_id = narrow_state.stream_id(filter, true);
    if (stream_id !== undefined) {
        if (narrow_state.topic(filter) !== "") {
            return undefined;
        }
        const sub = stream_data.get_sub_by_id(stream_id);
        if (sub === undefined) {
            return undefined;
        }
        return {
            channel: {
                name: sub.name,
                invite_only: sub.invite_only,
                is_web_public: sub.is_web_public,
                is_archived: sub.is_archived,
                description_html: sub.rendered_description,
                created_label: created_label(sub.date_created, sub.creator_id),
                settings_url: hash_util.channels_settings_edit_url(sub, "general"),
            },
        };
    }
    const user_ids = [...narrow_state.pm_ids_set(filter)];
    if (user_ids.length === 0) {
        return undefined;
    }
    const other_user_ids = people.sorted_other_user_ids(user_ids);
    const shown_user_ids = other_user_ids.length === 0 ? user_ids : other_user_ids;
    return {
        dm: {
            avatar_urls: shown_user_ids.map((user_id) =>
                people.medium_avatar_url_for_person(people.get_by_user_id(user_id)),
            ),
            names: message_store.get_pm_full_names(user_ids),
            is_self: other_user_ids.length === 0,
        },
    };
}

export function hide_intro(): void {
    $("#ykphone-conversation-intro").hide();
}

// Called from message_feed_top_notices once upstream knows whether
// the list reached the start of the conversation's history.
export function update_intro(msg_list: MessageList): void {
    const context = intro_context(narrow_state.filter());
    const fetch_status = msg_list.data.fetch_status;
    if (
        context === undefined ||
        !fetch_status.has_found_oldest() ||
        fetch_status.history_limited()
    ) {
        hide_intro();
        return;
    }
    const $intro = $("#ykphone-conversation-intro");
    $intro.html(render_ykphone_conversation_intro(context));
    if (context.channel !== undefined) {
        // Channel names, emoji and mentions in the description.
        rendered_markdown.update_elements($intro.find(".rendered_markdown"));
    }
    $intro.show();
}

export function handle_narrow_activated(): void {
    update_body_class();
}
