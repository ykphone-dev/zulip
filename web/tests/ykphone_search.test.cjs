"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const channel = mock_esm("../src/channel");
mock_esm("../src/timerender", {
    relative_time_string_from_date: (date) => `relative:${date.getTime() / 1000}`,
    get_localized_date_or_time_for_format: (date) => `date:${date.getTime() / 1000}`,
});

const users = new Map([
    [5, {user_id: 5, full_name: "Me", email: "me@zulip.com"}],
    [7, {user_id: 7, full_name: "Othello", email: "othello@zulip.com"}],
    [9, {user_id: 9, full_name: "Zoe", email: "zoe@zulip.com"}],
    // A deactivated account is in the store but is not offered.
    [12, {user_id: 12, full_name: "Gone", email: "gone@zulip.com"}],
]);

function sub(stream_id, name, opts = {}) {
    return {
        stream_id,
        name,
        description: "",
        invite_only: false,
        is_web_public: false,
        is_archived: false,
        subscribed: true,
        ...opts,
    };
}

const subs = [
    sub(11, "devel", {description: "For developing"}),
    sub(12, "secret", {invite_only: true}),
    sub(13, "Rome", {is_web_public: true}),
    sub(14, "old", {is_archived: true}),
    // A public channel the user has not joined is still a channel to
    // find; a private one they are not in is not.
    sub(15, "open-invite", {subscribed: false}),
    sub(16, "closed-room", {subscribed: false, invite_only: true}),
];

mock_esm("../src/people", {
    maybe_get_user_by_id: (user_id) => users.get(user_id),
    small_avatar_url_for_person: (person) => `/avatar/${person.user_id}/small`,
    sorted_other_user_ids: (user_ids) => user_ids.filter((user_id) => user_id !== 5),
    is_valid_user_id: (user_id) => users.has(Number(user_id)),
    is_valid_user_ids: (user_ids) => user_ids.every((user_id) => users.has(Number(user_id))),
    is_active_user: (user_id) => user_id !== 12,
    get_realm_active_human_users: () => [...users.values()].filter((user) => user.user_id !== 12),
    get_people_for_search_bar: (query) =>
        [...users.values()].filter((user) =>
            user.full_name.toLowerCase().includes(query.toLowerCase()),
        ),
});
mock_esm("../src/stream_data", {
    get_sub_by_id: (stream_id) => subs.find((candidate) => candidate.stream_id === stream_id),
    get_sub_by_id_string: (id_string) =>
        subs.find((candidate) => candidate.stream_id === Number(id_string)),
    get_unsorted_subs: () => subs,
    // Filter.parse looks a channel name up when it sees one.
    get_sub: (name) => subs.find((candidate) => candidate.name === name),
});

const ykphone_search = zrequire("ykphone_search");

function raw_message(id, opts = {}) {
    return {
        id,
        avatar_url: null,
        client: "website",
        content: `<p>message ${id}</p>`,
        content_type: "text/html",
        is_me_message: false,
        reactions: [],
        sender_email: "othello@zulip.com",
        sender_full_name: "Othello",
        sender_id: 7,
        submessages: [],
        timestamp: 1_700_000_000 + id,
        flags: [],
        type: "stream",
        stream_id: 11,
        display_recipient: "devel",
        subject: "",
        topic_links: [],
        ...opts,
    };
}

run_test("tabs", () => {
    assert.deepEqual(
        ykphone_search.SEARCH_TABS.map((tab) => ykphone_search.tab_label(tab)),
        ["translated: Messages", "translated: Files", "translated: Channels", "translated: People"],
    );
    assert.ok(ykphone_search.is_search_tab("files"));
    assert.ok(!ykphone_search.is_search_tab("nothing"));
    assert.ok(!ykphone_search.is_search_tab(undefined));
});

run_test("the query in the hash", () => {
    assert.equal(
        ykphone_search.encode_query("  예산 채널/보고  "),
        "%EC%98%88%EC%82%B0+%EC%B1%84%EB%84%90%2F%EB%B3%B4%EA%B3%A0",
    );
    assert.equal(
        ykphone_search.decode_query("%EC%98%88%EC%82%B0+%EC%B1%84%EB%84%90%2F%EB%B3%B4%EA%B3%A0"),
        "예산 채널/보고",
    );
    assert.equal(ykphone_search.encode_query(""), "");
    // A hash somebody edited by hand is taken as it stands rather than
    // throwing the page away.
    assert.equal(ykphone_search.decode_query("100%+off"), "100% off");
    // A lone surrogate cannot be percent-encoded at all; the page
    // opens on an empty query rather than throwing.
    assert.equal(ykphone_search.encode_query("\uD800"), "");
});

run_test("the query as search terms", () => {
    assert.deepEqual(ykphone_search.query_terms("channel:11 예산"), [
        {operator: "channel", operand: "11", negated: false},
        {operator: "search", operand: "예산", negated: false},
    ]);
    assert.equal(ykphone_search.query_terms(""), undefined);
    // A term Zulip cannot read (a sender who is not a user id).
    assert.equal(ykphone_search.query_terms("sender:nobody"), undefined);

    assert.equal(
        ykphone_search.query_from_terms([
            {operator: "channel", operand: "11"},
            {operator: "search", operand: "예산"},
        ]),
        "channel:11 예산",
    );

    const terms = ykphone_search.query_terms("channel:11");
    assert.deepEqual(ykphone_search.files_terms(terms), [
        {operator: "channel", operand: "11", negated: false},
        {operator: "has", operand: "attachment"},
    ]);
    // A query that already asks for files is left alone.
    const with_files = ykphone_search.query_terms("has:attachment");
    assert.equal(ykphone_search.files_terms(with_files), with_files);

    assert.deepEqual(ykphone_search.search_words("channel:11 예산 보고"), ["예산", "보고"]);
    assert.deepEqual(ykphone_search.search_words("channel:11"), []);
});

run_test("the filter bar edits the query", () => {
    const with_operator = ykphone_search.query_with_operator;
    assert.equal(with_operator("예산", "sender", "7"), "sender:7 예산");
    assert.equal(with_operator("sender:9 예산", "sender", "7"), "sender:7 예산");
    assert.equal(with_operator("sender:9 예산", "sender", undefined), "예산");
    assert.equal(with_operator("channel:11", "sender", "7"), "channel:11 sender:7");

    assert.equal(ykphone_search.operand_for("channel:11 예산", "channel"), "11");
    assert.equal(ykphone_search.operand_for("예산", "channel"), undefined);
    assert.ok(ykphone_search.has_operand("has:attachment 예산", "has", "attachment"));
    assert.ok(!ykphone_search.has_operand("예산", "has", "attachment"));

    assert.equal(ykphone_search.query_with_has_attachment("예산", true), "has:attachment 예산");
    assert.equal(ykphone_search.query_with_has_attachment("has:attachment 예산", false), "예산");
});

run_test("highlighting what the search matched", () => {
    const mark = (inner) => `<span class="highlight">${inner}</span>`;
    const shape = (runs) => runs.map((run) => (run.matched ? `<${run.text}>` : run.text)).join("");

    // The server's marks survive the flattening to one line, and what
    // comes out is runs of plain text — never markup.
    assert.deepEqual(ykphone_search.highlighted_runs(`<p>a &amp; ${mark("예산")} &lt;b&gt;</p>`), [
        {text: "a & ", matched: false},
        {text: "예산", matched: true},
        {text: " <b>", matched: false},
    ]);
    // Nothing matched (a search by operator alone).
    assert.deepEqual(ykphone_search.highlighted_runs("<p>plain</p>"), [
        {text: "plain", matched: false},
    ]);
    assert.deepEqual(ykphone_search.highlighted_runs("<p>  </p>"), []);

    // The space between two paragraphs survives a mark on the
    // boundary, and is not doubled.
    assert.equal(
        shape(ykphone_search.highlighted_runs(`<p>one ${mark("two")}</p><p>three</p>`)),
        "one <two> three",
    );

    // A long message is cut around the first match, with an ellipsis
    // on the side that was cut — never inside a marked word.
    const long = "x".repeat(100) + mark("예산") + "y".repeat(100);
    const cut = ykphone_search.highlighted_runs(`<p>${long}</p>`, 60);
    assert.equal(cut.at(0).text, "…");
    assert.equal(cut.at(-1).text, "…");
    assert.ok(cut.some((run) => run.matched && run.text === "예산"));
    assert.ok(cut.every((run) => !run.text.includes("…") || run.text === "…"));

    // A cut that falls inside a match keeps only the part it kept.
    assert.equal(shape(ykphone_search.highlighted_runs(`<p>ab${mark("cdef")}</p>`, 4)), "…b<cde>…");

    // A message body cannot forge a mark or close one: the control
    // characters an older version used as markers are just text now.
    const forged = "a\u0001fake\u0002b";
    assert.deepEqual(ykphone_search.highlighted_runs(`<p>${forged}</p>`), [
        {text: forged, matched: false},
    ]);
    assert.deepEqual(ykphone_search.highlighted_runs(`<p>hello\u0002 world</p>`), [
        {text: "hello\u0002 world", matched: false},
    ]);
    assert.equal(
        shape(ykphone_search.highlighted_runs(`<p>\u0001x ${mark("y")}</p>`)),
        "\u0001x <y>",
    );
});

run_test("date range and sort", () => {
    const now = 1_700_100_000_000;
    const messages = [
        raw_message(1, {timestamp: now / 1000 - 60}),
        raw_message(2, {timestamp: now / 1000 - 60 * 60 * 24 * 3}),
        raw_message(3, {timestamp: now / 1000 - 60 * 60 * 24 * 20}),
        raw_message(4, {timestamp: now / 1000 - 60 * 60 * 24 * 100}),
        raw_message(5, {timestamp: now / 1000 - 60 * 60 * 24 * 900}),
    ];
    const ids = (range) =>
        ykphone_search.filter_by_date(messages, range, now).map((message) => message.id);
    assert.deepEqual(ids("any"), [1, 2, 3, 4, 5]);
    assert.deepEqual(ids("today"), [1]);
    assert.deepEqual(ids("week"), [1, 2]);
    assert.deepEqual(ids("month"), [1, 2, 3]);
    assert.deepEqual(ids("year"), [1, 2, 3, 4]);
    // Without a clock of its own the filter reads the one on the wall.
    assert.deepEqual(ykphone_search.filter_by_date(messages, "any"), messages);

    const same = [raw_message(20, {timestamp: 100}), raw_message(21, {timestamp: 100})];
    assert.deepEqual(
        ykphone_search.sort_messages(same, "newest").map((message) => message.id),
        [21, 20],
    );
    assert.deepEqual(
        ykphone_search.sort_messages(same, "oldest").map((message) => message.id),
        [20, 21],
    );
    assert.deepEqual(
        ykphone_search.sort_messages(messages, "oldest").map((message) => message.id),
        [5, 4, 3, 2, 1],
    );
});

run_test("message rows", () => {
    const rows = ykphone_search.message_rows(
        [
            raw_message(30, {match_content: '<p>a <span class="highlight">예산</span></p>'}),
            raw_message(31, {sender_id: 404, sender_full_name: "Nobody"}),
        ],
        {selection: "30", hash_for: (selection) => `#result/${selection}`},
    );
    assert.deepEqual(
        rows.map((row) => [row.message_id, row.url, row.is_active, row.context_label]),
        [
            [30, "#result/30", true, "#devel"],
            [31, "#result/31", false, "#devel"],
        ],
    );
    assert.deepEqual(rows[0].snippet, [
        {text: "a ", matched: false},
        {text: "예산", matched: true},
    ]);
    // No server highlighting (a search by operator alone): the
    // message's own text is shown.
    assert.deepEqual(rows[1].snippet, [{text: "message 31", matched: false}]);
    assert.equal(rows[1].avatar_url, "/avatar/404");
    assert.equal(rows[0].time_label, `relative:${1_700_000_030}`);
});

run_test("what a selection stands for", () => {
    assert.deepEqual(ykphone_search.parse_selection("30"), {kind: "message", id: 30});
    assert.deepEqual(ykphone_search.parse_selection("c11"), {kind: "channel", id: 11});
    assert.deepEqual(ykphone_search.parse_selection("u7"), {kind: "person", id: 7});
    assert.equal(ykphone_search.parse_selection("x"), undefined);

    assert.equal(ykphone_search.message_selection(30), "30");
    assert.equal(ykphone_search.channel_selection(11), "c11");
    assert.equal(ykphone_search.person_selection(7), "u7");

    const messages = [raw_message(30)];
    assert.deepEqual(ykphone_search.selection_terms("c11", messages), [
        {operator: "channel", operand: "11"},
        {operator: "topic", operand: ""},
    ]);
    assert.deepEqual(ykphone_search.selection_terms("u7", messages), [
        {operator: "dm", operand: [7]},
    ]);
    assert.deepEqual(ykphone_search.selection_terms("30", messages), [
        {operator: "channel", operand: "11"},
        {operator: "topic", operand: ""},
        {operator: "near", operand: "30"},
    ]);
    // Selections that name nothing the page knows.
    assert.equal(ykphone_search.selection_terms("x", messages), undefined);
    assert.equal(ykphone_search.selection_terms("c404", messages), undefined);
    assert.equal(ykphone_search.selection_terms("u404", messages), undefined);
    assert.equal(ykphone_search.selection_terms("99", messages), undefined);
});

run_test("channel and people rows", () => {
    const hash_for = (selection) => `#result/${selection}`;
    const channels = (words, selection) =>
        ykphone_search.channel_rows(words, {selection, hash_for});

    // Channels whose name or description matches, including a public
    // one the user has not joined; an archived channel and a private
    // one they are not in are not offered.
    assert.deepEqual(
        channels(["o"], undefined).map((row) => [row.selection, row.icon]),
        [
            ["c11", "hashtag"],
            ["c15", "hashtag"],
            ["c13", "globe"],
        ],
    );
    assert.deepEqual(
        channels(["devel"], "c11").map((row) => [row.label, row.is_active]),
        [
            [
                [
                    {text: "#", matched: false},
                    {text: "devel", matched: true},
                ],
                true,
            ],
        ],
    );
    assert.deepEqual(
        channels(["developing"], undefined).map((row) => row.selection),
        ["c11"],
    );
    assert.deepEqual(channels(["zzz"], undefined), []);
    assert.deepEqual(
        channels(["secret"], undefined).map((row) => row.icon),
        ["lock"],
    );
    // With nothing to match, the tab is not a channel directory.
    assert.deepEqual(channels([], undefined), []);

    const listed = (words, selection) =>
        ykphone_search.people_rows(words, {selection, hash_for}).map((row) => row.selection);
    // The same list however much is typed: this organization's people,
    // no bots, no deactivated accounts.
    assert.deepEqual(listed(["o"], undefined), ["u7", "u9"]);
    assert.deepEqual(listed(["othello"], "u7"), ["u7"]);
    assert.equal(
        ykphone_search.people_rows(["othello"], {selection: "u7", hash_for})[0].is_active,
        true,
    );
    assert.deepEqual(
        ykphone_search.people_rows(["othello"], {selection: undefined, hash_for})[0].description,
        "",
    );
    assert.deepEqual(listed(["zzz"], undefined), []);
    assert.deepEqual(listed([], undefined), []);
});

run_test("counts", () => {
    // A search that read the whole history counts exactly; one that
    // stopped at a page says so, whatever a date range then left of it.
    assert.equal(ykphone_search.count_label(3, true), "3");
    assert.equal(ykphone_search.count_label(12, false), "12+");
    assert.equal(ykphone_search.count_label(ykphone_search.MAX_RESULTS, false), "100+");
});

run_test("what the search bar's contents mean", () => {
    const action = (opts) => ykphone_search.search_bar_action(opts);
    // Without the fork's dropdown the search bar is upstream's.
    assert.equal(action({enabled: false, finished: true, query: "예산"}), "upstream");
    // A finished query opens the results page; one still being built
    // only sits in the bar.
    assert.equal(action({enabled: true, finished: true, query: "예산"}), "open");
    assert.equal(action({enabled: true, finished: false, query: "channel:11"}), "hold");
    assert.equal(action({enabled: true, finished: true, query: ""}), "hold");
});

run_test("the filter bar's choices", () => {
    const messages = [
        raw_message(40),
        raw_message(41, {sender_id: 9, sender_full_name: "Zoe", stream_id: 13}),
        raw_message(42, {
            type: "private",
            display_recipient: [
                {id: 5, email: "me@zulip.com", full_name: "Me"},
                {id: 7, email: "othello@zulip.com", full_name: "Othello"},
            ],
        }),
        raw_message(43, {stream_id: 404, display_recipient: "Gone"}),
    ];
    assert.deepEqual(ykphone_search.message_sender_options(messages, "sender:9"), [
        {value: "", label: "translated: Anyone", selected: false},
        {value: "7", label: "Othello", selected: false},
        {value: "9", label: "Zoe", selected: true},
    ]);
    assert.deepEqual(ykphone_search.message_channel_options(messages, ""), [
        {value: "", label: "translated: All channels", selected: true},
        {value: "404", label: "#404", selected: false},
        {value: "11", label: "#devel", selected: false},
        {value: "13", label: "#Rome", selected: false},
    ]);

    assert.deepEqual(
        ykphone_search.date_options("week").map((option) => [option.value, option.selected]),
        [
            ["any", false],
            ["today", false],
            ["week", true],
            ["month", false],
            ["year", false],
        ],
    );
    assert.equal(ykphone_search.date_range_label("any"), "translated: Any date");
    assert.equal(ykphone_search.date_range_label("today"), "translated: Past 24 hours");
    assert.equal(ykphone_search.date_range_label("month"), "translated: Past 30 days");
    assert.equal(ykphone_search.date_range_label("year"), "translated: Past year");
    assert.ok(ykphone_search.is_date_range("week"));
    assert.ok(!ykphone_search.is_date_range("fortnight"));

    assert.deepEqual(ykphone_search.sort_options("oldest"), [
        {value: "newest", label: "translated: Newest first", selected: false},
        {value: "oldest", label: "translated: Oldest first", selected: true},
    ]);
});

run_test("the page's own state", () => {
    ykphone_search.clear_for_testing();
    assert.equal(ykphone_search.get_results(), undefined);
    assert.ok(!ykphone_search.is_loading());
    assert.ok(!ykphone_search.has_failed());
    assert.ok(!ykphone_search.is_query_invalid());

    // The file facets name one result set, so a new query starts them
    // over; the sort and the date range are in the route, not here.
    ykphone_search.set_file_filters({kind: "image", sender_id: 7, stream_id: 11});
    assert.deepEqual(ykphone_search.get_file_filters(), {
        kind: "image",
        sender_id: 7,
        stream_id: 11,
    });
    ykphone_search.reset_facets();
    assert.deepEqual(ykphone_search.get_file_filters(), {
        kind: "any",
        sender_id: undefined,
        stream_id: undefined,
    });
});

run_test("the query the filter bar's choices are taken from", () => {
    assert.equal(ykphone_search.base_query("sender:7 channel:11 예산"), "예산");
    assert.equal(ykphone_search.base_query("has:attachment 예산"), "has:attachment 예산");
});

function capture_requests({override}) {
    const requests = [];
    override(channel, "get", (opts) => {
        requests.push(opts);
    });
    return requests;
}

const NEWEST = {sort: "newest", range: "any"};

run_test("loading a search", (helpers) => {
    ykphone_search.clear_for_testing();
    const requests = capture_requests(helpers);
    let changes = 0;
    const on_change = () => {
        changes += 1;
    };

    ykphone_search.load("channel:11 예산", NEWEST, on_change);
    assert.ok(ykphone_search.is_loading());
    assert.equal(requests.length, 2);
    const [messages_request, files_request] = requests;
    // The channel goes out as a number: the API reads a string
    // operand as a channel name.
    assert.equal(
        messages_request.data.narrow,
        JSON.stringify([
            {operator: "channel", operand: 11, negated: false},
            {operator: "search", operand: "예산", negated: false},
        ]),
    );
    assert.equal(messages_request.data.anchor, "newest");
    assert.equal(messages_request.data.num_before, 100);
    assert.equal(messages_request.data.num_after, 0);
    assert.ok(files_request.data.narrow.includes('{"operator":"has","operand":"attachment"}'));

    // The page waits for both answers.
    messages_request.success({messages: [raw_message(50)], found_oldest: true});
    assert.equal(changes, 0);
    files_request.success({messages: [], found_oldest: false});
    assert.equal(changes, 1);
    assert.ok(!ykphone_search.is_loading());
    const results = ykphone_search.get_results();
    assert.equal(results.query, "channel:11 예산");
    assert.deepEqual(
        results.messages.map((message) => message.id),
        [50],
    );
    assert.ok(results.messages_complete);
    assert.ok(!results.files_complete);

    // Oldest first asks the other end of the history, and a response
    // without the "found" flags is not taken for a whole count.
    ykphone_search.load("예산", {sort: "oldest", range: "any"}, on_change);
    const [oldest_request] = requests.slice(2);
    assert.equal(oldest_request.data.anchor, "oldest");
    assert.equal(oldest_request.data.num_before, 0);
    assert.equal(oldest_request.data.num_after, 100);
    oldest_request.success({messages: []});
    requests[3].success({messages: []});
    assert.ok(!ykphone_search.get_results().messages_complete);

    // A date range always reads the newest end, whichever way the
    // results are then ordered: the hundred *oldest* matches would
    // hardly ever hold one from this week.
    ykphone_search.load("예산", {sort: "oldest", range: "week"}, on_change);
    assert.equal(requests[4].data.anchor, "newest");
    assert.equal(requests[5].data.anchor, "newest");
});

run_test("the filter bar's choices outlive a filtered search", (helpers) => {
    ykphone_search.clear_for_testing();
    const requests = capture_requests(helpers);
    const answer = (from, messages) => {
        requests[from].success({messages, found_oldest: true});
        requests[from + 1].success({messages: [], found_oldest: true});
    };

    // A search with no filter of the bar's own: its senders are the
    // ones to offer.
    ykphone_search.load("예산", NEWEST, () => {});
    answer(0, [raw_message(60), raw_message(61, {sender_id: 9, sender_full_name: "Zoe"})]);
    assert.deepEqual(
        ykphone_search.facet_messages("예산").map((message) => message.sender_id),
        [7, 9],
    );

    // Picking one re-runs the search; the other choice is still there.
    ykphone_search.load("sender:9 예산", NEWEST, () => {});
    answer(2, [raw_message(61, {sender_id: 9, sender_full_name: "Zoe"})]);
    assert.deepEqual(
        ykphone_search.message_sender_options(
            ykphone_search.facet_messages("sender:9 예산"),
            "sender:9 예산",
        ),
        [
            {value: "", label: "translated: Anyone", selected: false},
            {value: "7", label: "Othello", selected: false},
            {value: "9", label: "Zoe", selected: true},
        ],
    );

    // A filtered query the page was opened on directly has no
    // unfiltered results to take the choices from, so they are the
    // ones its own results hold.
    ykphone_search.clear_for_testing();
    ykphone_search.load("sender:9 보고", NEWEST, () => {});
    answer(4, [raw_message(62, {sender_id: 9, sender_full_name: "Zoe"})]);
    assert.deepEqual(
        ykphone_search.facet_messages("sender:9 보고").map((message) => message.sender_id),
        [9],
    );
    // A query that is not the one on screen has no choices at all.
    assert.deepEqual(ykphone_search.facet_messages("무관한 검색어"), []);
});

run_test("a search that cannot run, one that fails, and one that is replaced", (helpers) => {
    ykphone_search.clear_for_testing();
    const requests = capture_requests(helpers);
    let changes = 0;
    const on_change = () => {
        changes += 1;
    };

    // Nothing to search for: no request, and nothing to say.
    ykphone_search.load("", NEWEST, on_change);
    assert.equal(requests.length, 0);
    assert.equal(changes, 1);
    assert.equal(ykphone_search.get_results(), undefined);
    assert.ok(!ykphone_search.is_query_invalid());

    // A query Zulip cannot read (a channel nobody has, or an email
    // where a user id belongs, as a hand-edited or shared URL would
    // carry): the page says so rather than reporting a confident
    // "no results".
    ykphone_search.load("channel:nosuchchannel 예산", NEWEST, on_change);
    assert.equal(requests.length, 0);
    assert.ok(ykphone_search.is_query_invalid());
    assert.equal(ykphone_search.get_results(), undefined);
    assert.ok(!ykphone_search.is_loading());

    ykphone_search.load("예산", NEWEST, on_change);
    assert.ok(!ykphone_search.is_query_invalid());
    requests[0].error();
    assert.ok(ykphone_search.has_failed());
    assert.ok(!ykphone_search.is_loading());
    // The second request of the same search fails too; the page says
    // so once.
    const said = changes;
    requests[1].error();
    assert.equal(changes, said);

    // A newer search is on the way: the older one's answers are
    // dropped, including its failure.
    ykphone_search.load("보고", NEWEST, on_change);
    requests[0].success({messages: [raw_message(60)]});
    requests[1].success({messages: [raw_message(60)]});
    requests[1].error();
    assert.equal(ykphone_search.get_results(), undefined);
    requests[2].success({messages: [raw_message(61)], found_oldest: true});
    requests[3].success({messages: [], found_oldest: true});
    assert.deepEqual(
        ykphone_search.get_results().messages.map((message) => message.id),
        [61],
    );
    ykphone_search.clear_for_testing();
});
