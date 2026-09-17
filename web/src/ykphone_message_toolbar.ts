// The hover toolbar's data for the 옆커폰 fork (message_controls.hbs):
// Slack's one-click reactions. The toolbar reads, left to right: up to
// three reactions the user gives most, the emoji picker, reply in
// thread (channels), forward, save and the ⋮ menu. Until the user has
// reacted with anything, the reactions are Slack's defaults.
//
// The list is worked out once and kept: message_list_view asks for it
// once per message container, hundreds of times per narrow change, and
// every message in the feed must show the same three. It is dropped
// when the emoji the user reaches for change — upstream recomputes its
// own frequently used list at the same moments
// (emoji_frequency.update_frequently_used_emojis_list) — and after a
// reaction of the user's own (ykphone_threads_ui).

import * as emoji from "./emoji.ts";
import * as emoji_frequency_data from "./emoji_frequency_data.ts";
import {$t} from "./i18n.ts";
import {user_settings} from "./user_settings.ts";

export const MAX_QUICK_REACTIONS = 3;
// ✅ 👀 🙌
export const DEFAULT_QUICK_REACTIONS = ["check", "eyes", "raised_hands"];

export type QuickReaction = {
    emoji_name: string;
    emoji_code: string;
    is_realm_emoji: boolean;
    url: string | undefined;
    label: string;
    // With the "text" emoji set, the emoji is written out as :name:.
    emoji_alt_code: boolean;
};

function emoji_name_for(info: {emoji_type: string; emoji_code: string}): string | undefined {
    if (info.emoji_type === "unicode_emoji") {
        return emoji.get_emoji_name(info.emoji_code);
    }
    const name = emoji.all_realm_emojis.get(info.emoji_code)?.emoji_name;
    // A custom emoji an administrator has since deactivated cannot be
    // added any more.
    return name !== undefined && emoji.active_realm_emojis.has(name) ? name : undefined;
}

// The emoji the user has reacted with, most used first; reactions by
// other people, which upstream's frequently used list also weighs, do
// not count here.
function own_frequent_emoji_names(): string[] {
    return emoji_frequency_data
        .show_reaction_data()
        .filter((usage) => usage.my_count > 0)
        .toSorted((a, b) => b.my_count - a.my_count || b.score - a.score)
        .map((usage) => emoji_name_for(usage))
        .filter((name) => name !== undefined);
}

let cached: QuickReaction[] | undefined;

export function clear_cache(): void {
    cached = undefined;
}

export function quick_reactions(): QuickReaction[] {
    cached ??= compute_quick_reactions();
    return cached;
}

function compute_quick_reactions(): QuickReaction[] {
    const names = [...new Set([...own_frequent_emoji_names(), ...DEFAULT_QUICK_REACTIONS])];
    return names.slice(0, MAX_QUICK_REACTIONS).map((emoji_name) => {
        const details = emoji.get_emoji_details_by_name(emoji_name);
        return {
            emoji_name,
            emoji_code: details.emoji_code,
            is_realm_emoji: details.reaction_type !== "unicode_emoji",
            url: details.url,
            label: $t({defaultMessage: "React with {emoji}"}, {emoji: `:${emoji_name}:`}),
            emoji_alt_code: user_settings.emojiset === "text",
        };
    });
}
