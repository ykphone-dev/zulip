"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const {page_params} = require("./lib/zpage_params.cjs");

let subscribed = [];
let conversations = [];
let humans = [];
let sidebar_stream_ids = [];
let recent_places = [];
let split_thread_rows;
const users = new Map();

const channel = mock_esm("../src/channel");
mock_esm("../src/people", {
    is_valid_user_ids: (user_ids) => user_ids.every((user_id) => users.has(user_id)),
    get_users_from_ids: (user_ids) => user_ids.map((user_id) => users.get(user_id)),
    get_realm_active_human_users: () => humans,
});
mock_esm("../src/pm_conversations", {
    recent: {get: () => conversations},
});
mock_esm("../src/stream_data", {
    subscribed_subs: () => subscribed,
});
mock_esm("../src/stream_list_sort", {
    get_stream_ids: () => sidebar_stream_ids,
});

function key(place) {
    switch (place.kind) {
        case "channel":
            return `channel:${place.stream_id}`;
        case "dm":
            return `dm:${place.user_ids.join(",")}`;
        case "thread":
            return `thread:${place.stream_id}:${place.topic}`;
        default:
            return `page:${place.page}`;
    }
}

mock_esm("../src/ykphone_places", {
    channel_place: (stream_id) => ({kind: "channel", stream_id}),
    dm_place(user_ids) {
        const others = user_ids.filter((id) => id !== 5);
        return {kind: "dm", user_ids: others.length > 0 ? others : [5]};
    },
    page_place: (page) => ({kind: "page", page}),
    place_key: key,
    describe(place) {
        let title;
        switch (place.kind) {
            case "channel":
                title = subscribed.find((sub) => sub.stream_id === place.stream_id)?.name;
                break;
            case "dm":
                if (!place.user_ids.every((user_id) => users.has(user_id))) {
                    return undefined;
                }
                title = place.user_ids.map((user_id) => users.get(user_id).full_name).join(", ");
                break;
            case "thread":
                title = place.topic;
                break;
            default:
                // A page the user may not open.
                if (place.page === "admin") {
                    return undefined;
                }
                title = `page ${place.page}`;
        }
        if (title === undefined) {
            return undefined;
        }
        return {key: key(place), kind: place.kind, title, hash: `#${key(place)}`};
    },
});
mock_esm("../src/ykphone_recents", {
    recent_entries: () => recent_places.map((place) => ({place, visited_at: 0})),
});
mock_esm("../src/ykphone_split_view", {
    get_thread_rows: () => split_thread_rows,
    threads_response_schema: {parse: (data) => data},
});

const ykphone_quick_switcher = zrequire("ykphone_quick_switcher");

function reset() {
    page_params.is_spectator = false;
    ykphone_quick_switcher.clear_for_testing();
    users.clear();
    for (const [user_id, full_name] of [
        [5, "Me"],
        [7, "Hamlet"],
        [8, "Cordelia Lear"],
        [9, "Othello"],
    ]) {
        users.set(user_id, {user_id, full_name});
    }
    subscribed = [
        {stream_id: 3, name: "Verona", is_archived: false},
        {stream_id: 4, name: "devel", is_archived: false},
        {stream_id: 6, name: "old", is_archived: true},
    ];
    conversations = [{user_ids_string: "8,9"}, {user_ids_string: "7"}];
    humans = [users.get(5), users.get(7), users.get(8), users.get(9)];
    sidebar_stream_ids = [4, 3];
    recent_places = [];
    split_thread_rows = undefined;
}

// The candidates are cached; each of these steps changes the data
// behind them, which in the app is followed by invalidate() from the
// narrow, the split pages or the threads answering.
function results(query, current) {
    ykphone_quick_switcher.invalidate();
    return ykphone_quick_switcher.results(query, current);
}

function titles(items) {
    return items.map((item) => item.title);
}

run_test("word_rank and query_rank", () => {
    assert.equal(ykphone_quick_switcher.word_rank("verona", "Verona"), 0);
    assert.equal(ykphone_quick_switcher.word_rank("ver", "Verona"), 1);
    assert.equal(ykphone_quick_switcher.word_rank("lear", "Cordelia Lear"), 2);
    assert.equal(ykphone_quick_switcher.word_rank("plan", "#devel·plans"), 2);
    assert.equal(ykphone_quick_switcher.word_rank("ron", "Verona"), 3);
    assert.equal(ykphone_quick_switcher.word_rank("vrn", "Verona"), 4);
    assert.equal(ykphone_quick_switcher.word_rank("스레", "내 스레드"), 2);
    assert.equal(ykphone_quick_switcher.word_rank("활드", "활동 스레드"), 4);
    assert.equal(ykphone_quick_switcher.word_rank("nov", "Verona"), undefined);
    // Letters in order only from the start of a word, so that a long
    // name does not match any three letters.
    assert.equal(ykphone_quick_switcher.word_rank("vna", "Big Verona"), 4);
    assert.equal(ykphone_quick_switcher.word_rank("oth", "b1 thread root mu5oztxh"), undefined);
    assert.equal(ykphone_quick_switcher.word_rank("vrn", "Verona", false), undefined);

    // Every word must match one of the names; ranks add up, and a
    // match in another name (a group member) is a step lower.
    assert.equal(ykphone_quick_switcher.query_rank("cor lear", "Cordelia Lear"), 3);
    assert.equal(ykphone_quick_switcher.query_rank("cor", "Hamlet", ["Othello", "Cordelia"]), 2);
    assert.equal(ykphone_quick_switcher.query_rank("cor xyz", "Cordelia"), undefined);
    assert.equal(ykphone_quick_switcher.query_rank("hml", "Group", ["Hamlet"]), undefined);
    assert.equal(ykphone_quick_switcher.query_rank("  ", "Cordelia"), 0);
});

run_test("results for a query", () => {
    reset();
    // Channels (not archived), direct message conversations, people
    // without one, pages; a group is found by any of its members.
    assert.deepEqual(titles(results("o", undefined)), [
        "Othello",
        "Cordelia Lear, Othello",
        "Cordelia Lear",
        "Verona",
    ]);

    // A person's own conversation before a group they are in.
    const [othello, group] = results("oth", undefined);
    assert.equal(othello.title, "Othello");
    assert.equal(othello.kind_label, "translated: Direct message");
    assert.equal(group.title, "Cordelia Lear, Othello");

    // Hamlet has a conversation already: listed once.
    assert.equal(results("hamlet", undefined).filter((item) => item.key === "dm:7").length, 1);

    const [verona] = results("verona", undefined);
    assert.deepEqual(verona, {
        key: "channel:3",
        kind: "channel",
        title: "Verona",
        hash: "#channel:3",
        kind_label: "translated: Channel",
        page: undefined,
    });
    const [page] = results("page thr", undefined);
    assert.deepEqual([page.title, page.kind_label], ["page threads", undefined]);
    // The admin page is not offered to this user.
    assert.ok(!titles(results("admin", undefined)).includes("page admin"));
    assert.deepEqual(results("nothing like it", undefined), []);

    // Equal matches: the most recently visited first, then by name.
    recent_places = [
        {kind: "channel", stream_id: 4},
        {kind: "channel", stream_id: 3},
    ];
    assert.deepEqual(titles(results("e", undefined)).slice(0, 3), [
        "devel",
        "Verona",
        "Cordelia Lear",
    ]);
    recent_places = [];
    assert.deepEqual(titles(results("e", undefined)).slice(0, 2), [
        "Cordelia Lear",
        "Cordelia Lear, Othello",
    ]);

    // A conversation with someone who is gone is not listed, nor are
    // their names.
    conversations = [{user_ids_string: "7,42"}];
    assert.deepEqual(results("hamlet", undefined).length, 1);

    // At most MAX_RESULTS.
    subscribed = Array.from({length: 30}, (_value, index) => ({
        stream_id: 100 + index,
        name: `team ${index}`,
        is_archived: false,
    }));
    assert.equal(results("team", undefined).length, ykphone_quick_switcher.MAX_RESULTS);
});

run_test("threads", ({override}) => {
    reset();
    assert.equal(ykphone_quick_switcher.known_threads(), undefined);
    split_thread_rows = [{stream_id: 4, topic_name: "release plans", root_snippet: "Let us ship"}];
    // Found by its topic, and by its first message.
    const [thread] = results("ship", undefined);
    assert.deepEqual([thread.title, thread.kind_label], ["release plans", "translated: Thread"]);

    let loaded = 0;
    override(channel, "get", (opts) => {
        assert.equal(opts.url, "/json/ykphone/threads/mine");
        opts.success({
            threads: [{stream_id: 3, topic_name: "lunch", root_snippet: "Pizza?"}],
        });
    });
    ykphone_quick_switcher.load_threads(() => {
        loaded += 1;
    });
    assert.equal(loaded, 1);
    // The switcher's own answer is newer than the threads page's.
    assert.deepEqual(titles(results("pizza", undefined)), ["lunch"]);
    assert.deepEqual(results("ship", undefined), []);
});

run_test("sigils, pages and caching", ({override}) => {
    reset();
    // Users type the sigils they see.
    assert.deepEqual(titles(results("#devel", undefined)), ["devel"]);
    assert.deepEqual(titles(results("@oth", undefined)).slice(0, 1), ["Othello"]);
    // A lone sigil is matched as itself.
    assert.deepEqual(results("#", undefined), []);

    // A page row carries its page, so that the switcher can record the
    // visit for the History dropdown.
    const [page] = results("page drafts", undefined);
    assert.deepEqual([page.kind, page.page], ["page", "drafts"]);
    const [verona_row] = results("verona", undefined);
    assert.equal(verona_row.page, undefined);

    // The candidates are built once and kept until something changes.
    ykphone_quick_switcher.invalidate();
    assert.deepEqual(titles(ykphone_quick_switcher.results("verona", undefined)), ["Verona"]);
    subscribed = [];
    assert.deepEqual(titles(ykphone_quick_switcher.results("verona", undefined)), ["Verona"]);
    ykphone_quick_switcher.invalidate();
    assert.deepEqual(ykphone_quick_switcher.results("verona", undefined), []);
    // And in any case not for longer than a minute.
    subscribed = [{stream_id: 3, name: "Verona", is_archived: false}];
    assert.deepEqual(ykphone_quick_switcher.results("verona", undefined, Date.now() + 61_000), [
        {
            key: "channel:3",
            kind: "channel",
            title: "Verona",
            hash: "#channel:3",
            kind_label: "translated: Channel",
            page: undefined,
        },
    ]);

    // The threads are asked for when the switcher opens, at most once
    // in half a minute, and never for a spectator.
    let requests = 0;
    override(channel, "get", (opts) => {
        requests += 1;
        opts.success({threads: []});
    });
    const now = Date.now();
    let loaded = 0;
    const note_loaded = () => {
        loaded += 1;
    };
    ykphone_quick_switcher.load_threads(note_loaded, now);
    ykphone_quick_switcher.load_threads(note_loaded, now + 1000);
    assert.deepEqual([requests, loaded], [1, 1]);
    ykphone_quick_switcher.load_threads(note_loaded, now + 31_000);
    assert.deepEqual([requests, loaded], [2, 2]);
    page_params.is_spectator = true;
    ykphone_quick_switcher.load_threads(note_loaded, now + 62_000);
    assert.equal(requests, 2);
    page_params.is_spectator = false;
});

run_test("results with nothing typed", () => {
    reset();
    // Nothing visited yet: the sidebar's channels.
    assert.deepEqual(titles(results("", undefined)), ["devel", "Verona"]);

    recent_places = [
        {kind: "channel", stream_id: 3},
        {kind: "dm", user_ids: [7]},
        {kind: "page", page: "activity"},
        {kind: "dm", user_ids: [42]},
        {kind: "channel", stream_id: 6},
    ];
    // The place on screen is left out, as are places that are gone
    // (or archived); the sidebar's channels follow, without repeats.
    assert.deepEqual(titles(results(" ", {kind: "dm", user_ids: [7]})), [
        "Verona",
        "page activity",
        "devel",
    ]);

    subscribed = Array.from({length: 12}, (_value, index) => ({
        stream_id: 100 + index,
        name: `team ${index}`,
        is_archived: false,
    }));
    recent_places = subscribed.map((sub) => ({kind: "channel", stream_id: sub.stream_id}));
    assert.equal(results("", undefined).length, ykphone_quick_switcher.MAX_RECENT_RESULTS);
});
