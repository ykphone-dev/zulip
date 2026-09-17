// Window titles for the 옆커폰 fork. A channel reads as Slack names it,
// "devel (channel)", and a thread as the pane header names it,
// "Thread · #devel", rather than upstream's "#devel > topic"; the title
// ends with the organization's name, without Zulip's.

import type {Filter} from "./filter.ts";
import {$t} from "./i18n.ts";
import * as stream_data from "./stream_data.ts";
import * as ykphone_flags from "./ykphone_flags.ts";

// The title of a channel narrow: a thread when it names a topic, the
// channel otherwise (its general chat, the whole channel, its starred
// messages). undefined keeps upstream's title for channels the user
// cannot see; searches inside a channel (its Files tab) never get here,
// as upstream titles them "Search results" first.
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
