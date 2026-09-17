"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

let usage = [];
const codepoint_names = new Map([
    ["2705", "check"],
    ["1f440", "eyes"],
    ["1f64c", "raised_hands"],
    ["1f44d", "+1"],
    ["1f389", "tada"],
]);

mock_esm("../src/emoji", {
    get_emoji_name: (code) => codepoint_names.get(code),
    all_realm_emojis: new Map([
        ["101", {emoji_name: "party_parrot"}],
        ["102", {emoji_name: "retired"}],
    ]),
    active_realm_emojis: new Map([["party_parrot", {id: "101"}]]),
    get_emoji_details_by_name(emoji_name) {
        if (emoji_name === "party_parrot") {
            return {
                emoji_name,
                emoji_code: "101",
                reaction_type: "realm_emoji",
                url: "/user_avatars/2/emoji/parrot.gif",
            };
        }
        const code = [...codepoint_names].find(([, name]) => name === emoji_name)[0];
        return {emoji_name, emoji_code: code, reaction_type: "unicode_emoji"};
    },
});
mock_esm("../src/emoji_frequency_data", {
    show_reaction_data: () => usage,
});
const {user_settings} = mock_esm("../src/user_settings", {
    user_settings: {emojiset: "google"},
});

const ykphone_message_toolbar = zrequire("ykphone_message_toolbar");

function names() {
    // The list is cached; the app drops it through
    // emoji_frequency.update_frequently_used_emojis_list and after a
    // reaction of the user's own.
    ykphone_message_toolbar.clear_cache();
    return ykphone_message_toolbar.quick_reactions().map((reaction) => reaction.emoji_name);
}

run_test("defaults", () => {
    usage = [];
    ykphone_message_toolbar.clear_cache();
    assert.deepEqual(ykphone_message_toolbar.quick_reactions(), [
        {
            emoji_name: "check",
            emoji_code: "2705",
            is_realm_emoji: false,
            url: undefined,
            label: "translated: React with :check:",
            emoji_alt_code: false,
        },
        {
            emoji_name: "eyes",
            emoji_code: "1f440",
            is_realm_emoji: false,
            url: undefined,
            label: "translated: React with :eyes:",
            emoji_alt_code: false,
        },
        {
            emoji_name: "raised_hands",
            emoji_code: "1f64c",
            is_realm_emoji: false,
            url: undefined,
            label: "translated: React with :raised_hands:",
            emoji_alt_code: false,
        },
    ]);
});

run_test("the user's own most used emoji", () => {
    usage = [
        // Popular with others, never used by this user.
        {emoji_type: "unicode_emoji", emoji_code: "1f389", score: 9, my_count: 0},
        {emoji_type: "unicode_emoji", emoji_code: "1f44d", score: 3, my_count: 2},
        {emoji_type: "realm_emoji", emoji_code: "101", score: 5, my_count: 2},
        // A custom emoji since deactivated, and emoji this client does not
        // know.
        {emoji_type: "realm_emoji", emoji_code: "102", score: 8, my_count: 5},
        {emoji_type: "unicode_emoji", emoji_code: "ffff", score: 1, my_count: 1},
        {emoji_type: "realm_emoji", emoji_code: "999", score: 1, my_count: 1},
    ];
    // Most used first (ties by score), then the defaults fill the rest.
    assert.deepEqual(names(), ["party_parrot", "+1", "check"]);
    const [parrot] = ykphone_message_toolbar.quick_reactions();
    assert.equal(parrot.is_realm_emoji, true);
    assert.equal(parrot.url, "/user_avatars/2/emoji/parrot.gif");

    // A default already among the user's own is not repeated.
    usage = [{emoji_type: "unicode_emoji", emoji_code: "1f440", score: 1, my_count: 1}];
    assert.deepEqual(names(), ["eyes", "check", "raised_hands"]);
});

run_test("one list per render pass", () => {
    // message_list_view asks once per message container, hundreds of
    // times per narrow change, and every message in the feed has to
    // show the same three emoji.
    usage = [];
    ykphone_message_toolbar.clear_cache();
    const first_message = ykphone_message_toolbar.quick_reactions();
    usage = [{emoji_type: "unicode_emoji", emoji_code: "1f44d", score: 9, my_count: 9}];
    const second_message = ykphone_message_toolbar.quick_reactions();
    assert.equal(second_message, first_message);
    assert.deepEqual(
        second_message.map((reaction) => reaction.emoji_name),
        ["check", "eyes", "raised_hands"],
    );
    // Until the emoji the user reaches for change.
    ykphone_message_toolbar.clear_cache();
    assert.deepEqual(
        ykphone_message_toolbar.quick_reactions().map((reaction) => reaction.emoji_name),
        ["+1", "check", "eyes"],
    );
});

run_test("text emoji set", ({override}) => {
    usage = [];
    ykphone_message_toolbar.clear_cache();
    override(user_settings, "emojiset", "text");
    assert.ok(
        ykphone_message_toolbar.quick_reactions().every((reaction) => reaction.emoji_alt_code),
    );
});
