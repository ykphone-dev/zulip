"use strict";

const assert = require("node:assert/strict");

const {make_stream} = require("./lib/example_stream.cjs");
const {make_user} = require("./lib/example_user.cjs");
const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const {page_params} = require("./lib/zpage_params.cjs");

const {localstorage} = zrequire("localstorage");
const people = zrequire("people");
const stream_data = zrequire("stream_data");
const {set_current_user} = zrequire("state_data");
const ykphone_flags = zrequire("ykphone_flags");
const ykphone_search_suggestions = zrequire("ykphone_search_suggestions");

const me = make_user({user_id: 5, full_name: "Me", email: "me@zulip.com"});
const othello = make_user({user_id: 7, full_name: "Othello", email: "othello@zulip.com"});
const zoe = make_user({user_id: 9, full_name: "Zoe", email: "zoe@zulip.com"});

const devel = make_stream({stream_id: 11, name: "devel"});
const secret = make_stream({stream_id: 12, name: "secret", invite_only: true});
const rome = make_stream({stream_id: 13, name: "Rome", is_web_public: true});

people.init();
people.add_active_user(me);
people.add_active_user(othello);
people.add_active_user(zoe);
set_current_user(me);
for (const sub of [devel, secret, rome]) {
    stream_data.add_sub_for_tests(sub);
}

function rows(suggestions, opts = {}) {
    return ykphone_search_suggestions.build_rows(suggestions, {
        query: opts.query ?? "",
        base_terms: opts.base_terms ?? [],
    });
}

function shape(list) {
    return list.map((row) => [row.section_label, row.section, row.search_string, row.label]);
}

run_test("the flag", () => {
    ykphone_flags.set_channels_open_in_general_chat(false);
    assert.ok(!ykphone_search_suggestions.enabled());
    ykphone_flags.set_channels_open_in_general_chat(true);
    assert.ok(ykphone_search_suggestions.enabled());
    // A spectator has no account to file recent searches under and no
    // results page to open, so they keep upstream's dropdown.
    page_params.is_spectator = true;
    assert.ok(!ykphone_search_suggestions.enabled());
    page_params.is_spectator = false;
    assert.ok(ykphone_search_suggestions.enabled());
});

run_test("what a term reads as", () => {
    const describe = (term) => ykphone_search_suggestions.describe_term(term);
    const line = (term) => {
        const view = describe(term);
        return view === undefined ? undefined : [view.section, view.label, view.description];
    };

    assert.deepEqual(line({operator: "search", operand: "예산"}), [
        "query",
        "예산",
        "translated: Search messages",
    ]);
    assert.deepEqual(line({operator: "channel", operand: "11"}), [
        "channel",
        "#devel",
        "translated: Search in this channel",
    ]);
    assert.deepEqual(line({operator: "channel", operand: ""}), [
        "filter",
        "translated: In channel",
        "translated: Pick a channel to search in",
    ]);
    assert.deepEqual(line({operator: "sender", operand: "7"}), [
        "person",
        "Othello",
        "translated: Messages this person sent",
    ]);
    assert.deepEqual(line({operator: "sender", operand: "-1"}), [
        "filter",
        "translated: From",
        "translated: Pick a person to search for",
    ]);
    assert.deepEqual(line({operator: "dm", operand: "7"}), [
        "person",
        "Othello",
        "translated: Direct messages with this person",
    ]);
    assert.deepEqual(line({operator: "dm", operand: ""}), [
        "filter",
        "translated: Direct messages with",
        "translated: Pick a person to search for",
    ]);
    assert.deepEqual(line({operator: "dm-including", operand: "7,9"}), [
        "person",
        "Othello, Zoe",
        "translated: Direct messages including this person",
    ]);
    assert.deepEqual(line({operator: "mentions", operand: "7"}), [
        "person",
        "Othello",
        "translated: Messages that mention this person",
    ]);
    assert.deepEqual(line({operator: "is", operand: "dm"})[1], "translated: Direct messages");
    assert.deepEqual(line({operator: "is", operand: "starred"})[1], "translated: Saved by me");
    assert.deepEqual(line({operator: "is", operand: "mentioned"})[1], "translated: Mentions me");
    assert.deepEqual(line({operator: "has", operand: "attachment"})[1], "translated: Has file");
    assert.deepEqual(line({operator: "has", operand: "link"})[1], "translated: Has link");
    assert.deepEqual(line({operator: "has", operand: "image"})[1], "translated: Has image");
    // Slack has an "in:" modifier, so the fork's dropdown offers it.
    assert.deepEqual(line({operator: "in", operand: "home"}), [
        "filter",
        "translated: Where to search",
        "in:home",
    ]);

    // The operators Slack has no modifier for are left out of the
    // dropdown together, and one flag brings all their rows back.
    for (const term of [
        {operator: "is", operand: "unread"},
        {operator: "has", operand: "reaction"},
        {operator: "channels", operand: "public"},
        {operator: "id", operand: "5"},
        {operator: "near", operand: "5"},
        {operator: "with", operand: "5"},
    ]) {
        assert.equal(describe(term), undefined, JSON.stringify(term));
    }

    // The icon says what kind of channel it is, and a person's row
    // carries their avatar when it is one person.
    assert.equal(describe({operator: "channel", operand: "11"}).icon, "hashtag");
    assert.equal(describe({operator: "channel", operand: "12"}).icon, "lock");
    assert.equal(describe({operator: "channel", operand: "13"}).icon, "globe");
    assert.equal(describe({operator: "channel", operand: "404"}).icon, "hashtag");
    assert.equal(describe({operator: "channel", operand: "404"}).label, "#404");
    assert.equal(describe({operator: "channel", operand: "zzz"}).label, "#zzz");
    assert.ok(describe({operator: "sender", operand: "7"}).avatar_url !== undefined);
    assert.equal(describe({operator: "sender", operand: "404"}).avatar_url, undefined);
    assert.equal(describe({operator: "sender", operand: "404"}).label, "404");
    assert.equal(describe({operator: "dm", operand: "7,9"}).avatar_url, undefined);
    assert.equal(describe({operator: "sender", operand: "zzz"}).label, "zzz");

    // What the fork leaves out: topics, the Zulip-only filters, and
    // the operators nobody types.
    // Only the topic operators are left out, which is what the fork
    // hides everywhere else too.
    for (const term of [
        {operator: "topic", operand: "Plans"},
        {operator: "is", operand: "followed"},
        {operator: "is", operand: "resolved"},
        {operator: "is", operand: "muted"},
        {operator: "is", operand: "alerted"},
        {operator: "is", operand: "unheard-of"},
        {operator: "has", operand: "unheard-of"},
        {operator: "dm-including", operand: ""},
        {operator: "mentions", operand: "-1"},
        {operator: "", operand: "x"},
    ]) {
        assert.equal(describe(term), undefined, JSON.stringify(term));
    }
});

run_test("what a term reads as without Slack's operators only", ({override_rewire}) => {
    const describe = (term) => ykphone_search_suggestions.describe_term(term);
    const line = (term) => {
        const view = describe(term);
        return view === undefined ? undefined : [view.section, view.label, view.description];
    };
    override_rewire(ykphone_flags, "SEARCH_DROPDOWN_SLACK_OPERATORS_ONLY", false);
    assert.deepEqual(line({operator: "is", operand: "unread"})[1], "translated: Unread");
    assert.deepEqual(line({operator: "has", operand: "reaction"})[1], "translated: Has reaction");
    assert.deepEqual(line({operator: "channels", operand: "public"}), [
        "filter",
        "translated: Channels to search",
        "channels:public",
    ]);
    assert.deepEqual(line({operator: "id", operand: "5"}), [
        "filter",
        "id:5",
        "translated: A message by its id",
    ]);
    assert.equal(line({operator: "near", operand: "5"})[1], "near:5");
    assert.equal(line({operator: "with", operand: "5"})[1], "with:5");
    // A topic operator stays hidden whichever way that flag is set.
    assert.equal(describe({operator: "topic", operand: "Plans"}), undefined);
});

run_test("a recent search reads as its own line", () => {
    assert.equal(
        ykphone_search_suggestions.search_label("channel:11 sender:7 예산"),
        "#devel translated: From Othello 예산",
    );
    assert.equal(
        ykphone_search_suggestions.search_label("-sender:7"),
        "translated: Not from Othello",
    );
    assert.equal(ykphone_search_suggestions.search_label("dm:7"), "Othello");
    assert.equal(ykphone_search_suggestions.search_label("-channel:11"), "-#devel");
    assert.equal(ykphone_search_suggestions.search_label("is:starred"), "is:starred");
});

run_test("recent searches are kept per user", () => {
    window.localStorage.clear();
    assert.deepEqual(ykphone_search_suggestions.recent_searches(), []);

    ykphone_search_suggestions.note_search("예산");
    ykphone_search_suggestions.note_search("channel:11 예산");
    // Blank searches are not remembered, and running one again moves
    // it to the top rather than listing it twice.
    ykphone_search_suggestions.note_search("   ");
    ykphone_search_suggestions.note_search("예산");
    assert.deepEqual(ykphone_search_suggestions.recent_searches(), ["예산", "channel:11 예산"]);

    for (let index = 0; index < ykphone_search_suggestions.MAX_RECENT_SEARCHES + 3; index += 1) {
        ykphone_search_suggestions.note_search(`q${index}`);
    }
    assert.equal(
        ykphone_search_suggestions.recent_searches().length,
        ykphone_search_suggestions.MAX_RECENT_SEARCHES,
    );

    // Anything else under the key (an older version, a hand edit) is
    // skipped rather than breaking the dropdown.
    const key = `ykphone-recent-searches-${me.user_id}`;
    localstorage().set(key, "nope");
    assert.deepEqual(ykphone_search_suggestions.recent_searches(), []);
    localstorage().set(key, [1, "", "예산"]);
    assert.deepEqual(ykphone_search_suggestions.recent_searches(), ["예산"]);
    window.localStorage.clear();
});

run_test("which filters are offered", () => {
    const available = (chip, base) => ykphone_search_suggestions.chip_is_available(chip, base);

    assert.ok(available("has:attachment", []));
    // Already in the query.
    assert.ok(!available("has:attachment", [{operator: "has", operand: "attachment"}]));
    // "sender:" has no operand of its own, so any sender term takes it
    // out of the list.
    assert.ok(!available("sender:", [{operator: "sender", operand: "7"}]));
    // Zulip refuses a channel and a direct message filter in one search.
    assert.ok(!available("is:dm", [{operator: "channel", operand: "11"}]));
    assert.ok(!available("channel:", [{operator: "is", operand: "dm"}]));
    assert.ok(!available("channel:", [{operator: "dm", operand: "7"}]));
    assert.ok(available("channel:", [{operator: "has", operand: "link"}]));
    assert.ok(!available("", []));

    const matches = (chip, query) => ykphone_search_suggestions.chip_matches_query(chip, query);
    assert.ok(matches("has:attachment", ""));
    assert.ok(matches("has:attachment", "has:att"));
    assert.ok(matches("has:attachment", "att"));
    assert.ok(matches("has:attachment", "Has file"));
    assert.ok(matches("has:link", "with a link"));
    assert.ok(!matches("has:link", "zzz"));
    // Something the fork has no row for matches nothing, and neither
    // does an empty string.
    assert.ok(!matches("topic:Plans", "zzz"));
    assert.ok(!matches("", "x"));
});

run_test("the dropdown", () => {
    window.localStorage.clear();
    ykphone_search_suggestions.note_search("예산");

    // With nothing typed: the recent search, then the one channel row
    // upstream offers for the conversation on screen, then the filters.
    assert.deepEqual(shape(rows(["channel:11", "channel:12", "channel:13"])), [
        ["translated: Recent searches", "recent", "예산", "예산"],
        ["translated: Channels", "channel", "channel:11", "#devel"],
        ["translated: Search filters", "filter", "sender:", "translated: From"],
        [undefined, "filter", "channel:", "translated: In channel"],
        [undefined, "filter", "has:attachment", "translated: Has file"],
        [undefined, "filter", "has:link", "translated: Has link"],
        [undefined, "filter", "has:image", "translated: Has image"],
        [undefined, "filter", "is:starred", "translated: Saved by me"],
        [undefined, "filter", "is:mentioned", "translated: Mentions me"],
        [undefined, "filter", "is:dm", "translated: Direct messages"],
    ]);

    // Typing: the words themselves first, then what upstream matched,
    // then the filters that match what was typed. A topic row is not
    // offered at all.
    const typed = rows(["dev", "channel:11", "channel:11 topic:Plans", "sender:7", "is:followed"], {
        query: "dev",
    });
    assert.deepEqual(shape(typed), [
        [undefined, "query", "dev", "dev"],
        ["translated: Channels", "channel", "channel:11", "#devel"],
        ["translated: People", "person", "sender:7", "Othello"],
    ]);

    // The filters read in Slack's order whatever order upstream
    // offered them in, and one Slack has no chip for goes last.
    assert.deepEqual(
        shape(rows(["is:dm", "dm:", "has:link"], {query: "메시지"})).map((row) => row[2]),
        ["has:link", "is:dm", "dm:"],
    );

    // A suggestion the fork cannot read at all is skipped, and one
    // upstream lists twice is listed once.
    assert.deepEqual(rows([""]), rows([]));
    assert.deepEqual(shape(rows(["channel:11", "channel:11"], {query: "devel"})), [
        ["translated: Channels", "channel", "channel:11", "#devel"],
    ]);

    // With pills in the box the filters are added to them, so
    // selecting one keeps what is already there.
    const with_base = rows(["is:starred"], {
        base_terms: [{operator: "channel", operand: "11"}],
    });
    assert.ok(
        with_base.some((row) => row.search_string === "channel:11 has:attachment"),
        "a filter is offered on top of the pills",
    );
    // A recent search would replace the pills, so none is offered.
    assert.ok(!with_base.some((row) => row.section === "recent"));

    // Recent searches are filtered by what is typed, and a negated
    // row says so.
    assert.deepEqual(
        shape(rows([], {query: "예"})).filter((row) => row[1] === "recent"),
        [["translated: Recent searches", "recent", "예산", "예산"]],
    );
    assert.deepEqual(shape(rows(["-has:link"], {query: "-has:link"})), [
        [
            "translated: Search filters",
            "filter",
            "-has:link",
            "translated: translated: Has link (excluded)",
        ],
    ]);
    window.localStorage.clear();
});

run_test("the rows for what is in the search bar", () => {
    window.localStorage.clear();
    // The pills already in the box are what a filter is added to, and
    // the last thing typed is what a filter is matched against.
    const rows_for = ykphone_search_suggestions.rows_for_search_bar(["channel:11"], "has:att", [
        {operator: "is", operand: "starred"},
    ]);
    assert.ok(
        rows_for.some((row) => row.search_string === "is:starred has:attachment"),
        JSON.stringify(rows_for.map((row) => row.search_string)),
    );
    // No recent search is offered on top of pills: selecting one would
    // replace them.
    ykphone_search_suggestions.note_search("예산");
    assert.ok(
        !ykphone_search_suggestions
            .rows_for_search_bar([], "", [{operator: "is", operand: "starred"}])
            .some((row) => row.section === "recent"),
    );
    assert.ok(
        ykphone_search_suggestions
            .rows_for_search_bar([], "", [])
            .some((row) => row.section === "recent"),
    );
    window.localStorage.clear();
});

run_test("every section is capped", () => {
    window.localStorage.clear();
    const many = [];
    for (let index = 0; index < 40; index += 1) {
        const sub = make_stream({stream_id: 100 + index, name: `c${index}`});
        stream_data.add_sub_for_tests(sub);
        many.push(`channel:${100 + index}`);
    }
    // Typing: at most five channels, so the filters below them are
    // still on the list.
    const typed = rows(many, {query: "c"});
    assert.equal(typed.filter((row) => row.section === "channel").length, 5);
    assert.ok(typed.some((row) => row.section === "filter"));

    // Nothing typed: one channel row (the conversation on screen) and
    // no people.
    const empty = rows([...many, "sender:7"]);
    assert.equal(empty.filter((row) => row.section === "channel").length, 1);
    assert.equal(empty.filter((row) => row.section === "person").length, 0);

    // More people than fit.
    const people_rows = [];
    for (const user_id of [5, 7, 9]) {
        people_rows.push(`sender:${user_id}`, `dm:${user_id}`);
    }
    assert.equal(
        rows(people_rows, {query: "o"}).filter((row) => row.section === "person").length,
        5,
    );
    ykphone_flags.set_channels_open_in_general_chat(false);
});
