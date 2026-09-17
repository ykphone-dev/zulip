// What the 옆커폰 composers leave out of upstream's typeahead while the
// fork hides topics (ykphone_flags.channels_open_in_general_chat): the
// @topic wildcard, which notifies the participants of a topic, @stream,
// the old name of @channel, and links to a channel's topics
// (#channel>topic). @all, @everyone and @channel stay, as do links to
// channels.

import type {TypeaheadSuggestion} from "./composebox_typeahead.ts";
import * as ykphone_flags from "./ykphone_flags.ts";

const TOPIC_WILDCARD_MENTIONS = new Set(["topic", "stream"]);

export function offers_suggestion(item: TypeaheadSuggestion): boolean {
    if (!ykphone_flags.channels_open_in_general_chat()) {
        return true;
    }
    if (item.type === "broadcast") {
        return !TOPIC_WILDCARD_MENTIONS.has(item.user.special_item_text);
    }
    if (item.type === "topic_list") {
        return item.is_channel_link;
    }
    return true;
}

// Whether ">" after a channel starts choosing one of its topics.
export function offers_topic_links(): boolean {
    return !ykphone_flags.channels_open_in_general_chat();
}
