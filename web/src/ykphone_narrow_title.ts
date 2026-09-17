// Window titles for the 옆커폰 fork. A channel reads as Slack names it,
// "devel (channel)", and a thread as the pane header names it,
// "Thread · #devel", rather than upstream's "#devel > topic"; the title
// ends with the organization's name, without Zulip's.

import type {Filter} from "./filter.ts";
import {$t} from "./i18n.ts";
import * as stream_data from "./stream_data.ts";
import * as ykphone_flags from "./ykphone_flags.ts";

// The Files view: both "has:attachment" narrows are Slack's file list
// in this fork (ykphone_files_ui), not a search, and a channel's own
// tab says which channel it is. undefined for every other narrow, so
// that a search inside a channel is still "Search results".
export function files_title(filter: Filter): string | undefined {
    if (!ykphone_flags.channels_open_in_general_chat()) {
        return undefined;
    }
    const terms = filter.sorted_term_types().join(" ");
    if (terms === "has-attachment") {
        return $t({defaultMessage: "Files"});
    }
    if (terms !== "channel has-attachment") {
        return undefined;
    }
    const sub = stream_data.get_sub_by_id_string(filter.terms_with_operator("channel")[0]!.operand);
    return sub === undefined
        ? undefined
        : $t({defaultMessage: "Files · {channel}"}, {channel: `#${sub.name}`});
}

// The title of a channel narrow: a thread when it names a topic, the
// channel otherwise (its general chat, the whole channel, its starred
// messages). undefined keeps upstream's title for channels the user
// cannot see; a narrow upstream could not name at all does not get
// here, so a search inside a channel keeps "Search results".
export function channel_title(filter: Filter): string | undefined {
    if (!ykphone_flags.channels_open_in_general_chat() || !filter.has_operator("channel")) {
        return undefined;
    }
    const sub = stream_data.get_sub_by_id_string(filter.terms_with_operator("channel")[0]!.operand);
    if (sub === undefined) {
        return undefined;
    }
    const topic = filter.terms_with_operator("topic")[0]?.operand ?? "";
    if (topic === "") {
        return $t({defaultMessage: "{channel} (channel)"}, {channel: sub.name});
    }
    return $t({defaultMessage: "Thread · {channel}"}, {channel: `#${sub.name}`});
}

// What follows the organization's name in the window title.
export function title_suffix(): string {
    return ykphone_flags.channels_open_in_general_chat() ? "" : " - Zulip";
}
