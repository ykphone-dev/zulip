"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const $ = require("./lib/zjquery.cjs");

// A tiny model of the unread state: each unread message has a channel,
// a topic and whether it mentions the user.
let unread_messages = [];
let unread_dm_count = 0;
const unread_mentions_counter = new Set();

function unread_ids(stream_id, topic) {
    return unread_messages
        .filter(
            (message) =>
                message.stream_id === stream_id &&
                message.topic.toLowerCase() === topic.toLowerCase(),
        )
        .map((message) => message.id);
}

mock_esm("../src/unread", {
    num_unread_for_topic: (stream_id, topic) => unread_ids(stream_id, topic).length,
    get_msg_ids_for_topic: unread_ids,
    get_topics_with_unread_mentions: (stream_id) =>
        new Set(
            unread_messages
                .filter(
                    (message) =>
                        message.stream_id === stream_id && unread_mentions_counter.has(message.id),
                )
                .map((message) => message.topic.toLowerCase()),
        ),
    unread_mentions_counter,
    get_msg_ids_for_mentions: () => [...unread_mentions_counter],
    get_unread_topics() {
        // Like unread's FoldDict, a topic keeps its first spelling.
        const topic_counts = new Map();
        for (const message of unread_messages) {
            if (!topic_counts.has(message.stream_id)) {
                topic_counts.set(message.stream_id, new Map());
            }
            const topics = topic_counts.get(message.stream_id);
            if (![...topics.keys()].some((t) => t.toLowerCase() === message.topic.toLowerCase())) {
                topics.set(message.topic, {});
            }
        }
        return {topic_counts};
    },
    get_unread_pm: () => ({total_count: unread_dm_count}),
});

const subs = new Map();
mock_esm("../src/sub_store", {
    get: (stream_id) => subs.get(stream_id),
});

const muted_topics = new Set();
const followed_topics = new Set();
mock_esm("../src/user_topics", {
    is_topic_muted: (stream_id, topic) => muted_topics.has(`${stream_id}:${topic}`),
    is_topic_unmuted_or_followed: (stream_id, topic) =>
        followed_topics.has(`${stream_id}:${topic}`),
});

// Threads by lower-cased topic, as ykphone_threads matches them.
const threads = new Map();
const loaded_thread_lists = [];
const thread_load_listeners = [];
const threads_changed_listeners = [];
// Topics other than threads the user takes part in, by lower-cased key.
const participated_topics = new Set();
// Channels whose thread list has not been fetched, and messages that
// arrived after it was.
const unloaded_thread_lists = new Set();
const unclassified_message_ids = new Set();
mock_esm("../src/ykphone_threads", {
    is_message_classified: (stream_id, message_id) =>
        !unloaded_thread_lists.has(stream_id) && !unclassified_message_ids.has(message_id),
    get_thread_for_topic: (stream_id, topic) => threads.get(`${stream_id}:${topic.toLowerCase()}`),
    load_stream_threads(stream_id) {
        loaded_thread_lists.push(stream_id);
    },
    on_stream_threads_loaded(listener) {
        thread_load_listeners.push(listener);
    },
    user_takes_part_in_topic: (stream_id, topic) =>
        participated_topics.has(`${stream_id}:${topic.toLowerCase()}`),
    on_threads_changed(listener) {
        threads_changed_listeners.push(listener);
    },
});

const ykphone_unread_badges = zrequire("ykphone_unread_badges");

const verona = 3;
const denmark = 4;
const muted_channel = 5;
const social = 6;
const archived = 7;

let next_message_id = 100;

function add_unread(stream_id, topic, {mentioned = false} = {}) {
    next_message_id += 1;
    unread_messages.push({id: next_message_id, stream_id, topic});
    if (mentioned) {
        unread_mentions_counter.add(next_message_id);
    }
    return next_message_id;
}

function add_thread(stream_id, topic_name, user_participated) {
    threads.set(`${stream_id}:${topic_name.toLowerCase()}`, {
        stream_id,
        topic_name,
        user_participated,
    });
}

function reset() {
    unread_messages = [];
    unread_dm_count = 0;
    unread_mentions_counter.clear();
    subs.clear();
    subs.set(verona, {stream_id: verona, is_muted: false});
    subs.set(denmark, {stream_id: denmark, is_muted: false});
    subs.set(muted_channel, {stream_id: muted_channel, is_muted: true});
    muted_topics.clear();
    followed_topics.clear();
    threads.clear();
    loaded_thread_lists.length = 0;
    unloaded_thread_lists.clear();
    unclassified_message_ids.clear();
    participated_topics.clear();
    add_thread(verona, "Ship it", true);
    add_thread(verona, "Lunch", false);
    add_thread(muted_channel, "Muted thread", true);
    add_thread(muted_channel, "Followed thread", true);
}

run_test("badge_label", () => {
    assert.equal(ykphone_unread_badges.badge_label(1), "1");
    assert.equal(ykphone_unread_badges.badge_label(99), "99");
    assert.equal(ykphone_unread_badges.badge_label(100), "99+");
});

run_test("channel_has_unread_general_chat", () => {
    reset();
    // Unread replies in threads and in other topics leave the name
    // alone.
    add_unread(verona, "Ship it");
    add_unread(verona, "an old topic");
    assert.equal(ykphone_unread_badges.channel_has_unread_general_chat(verona), false);

    add_unread(verona, "");
    assert.equal(ykphone_unread_badges.channel_has_unread_general_chat(verona), true);

    // A muted general chat does not count, nor does a muted channel,
    // even with its general chat followed, nor a channel the user is
    // not subscribed to.
    muted_topics.add(`${verona}:`);
    assert.equal(ykphone_unread_badges.channel_has_unread_general_chat(verona), false);
    add_unread(muted_channel, "");
    followed_topics.add(`${muted_channel}:`);
    assert.equal(ykphone_unread_badges.channel_has_unread_general_chat(muted_channel), false);
    subs.delete(denmark);
    add_unread(denmark, "");
    assert.equal(ykphone_unread_badges.channel_has_unread_general_chat(denmark), false);
});

run_test("channel_mention_count", () => {
    reset();
    assert.equal(ykphone_unread_badges.channel_mention_count(verona), 0);
    add_unread(verona, "", {mentioned: true});
    add_unread(verona, "");
    // Thread mentions count on the channel, whatever the topic's case
    // and whether or not the user takes part in the thread.
    add_unread(verona, "Ship it", {mentioned: true});
    add_unread(verona, "LUNCH", {mentioned: true});
    add_unread(verona, "Ship it");
    // A topic that is not a thread is never shown, so its mention is
    // left out.
    add_unread(verona, "an old topic", {mentioned: true});
    add_unread(denmark, "", {mentioned: true});
    assert.equal(ykphone_unread_badges.channel_mention_count(verona), 3);
    assert.equal(ykphone_unread_badges.channel_mention_count(denmark), 1);
    // Muting does not hide a mention (upstream fades it instead).
    muted_topics.add(`${verona}:`);
    assert.equal(ykphone_unread_badges.channel_mention_count(verona), 3);
});

run_test("thread replies and activity", () => {
    reset();
    add_unread(verona, "");
    const mine = add_unread(verona, "Ship it");
    const mine_mentioned = add_unread(verona, "ship IT", {mentioned: true});
    // Not the user's thread, nor a thread at all.
    add_unread(verona, "Lunch");
    add_unread(denmark, "an old topic");
    const orphan_mention = add_unread(denmark, "an old topic", {mentioned: true});
    // In a muted channel only a followed or unmuted thread counts.
    add_unread(muted_channel, "Muted thread");
    const followed = add_unread(muted_channel, "Followed thread");
    followed_topics.add(`${muted_channel}:Followed thread`);
    // A channel with unread messages only in its general chat has no
    // topics to tell apart.
    add_unread(social, "");

    const topics = ykphone_unread_badges.unread_non_general_topics();
    assert.deepEqual(
        [...topics],
        [
            [verona, ["Ship it", "Lunch"]],
            [denmark, ["an old topic"]],
            [muted_channel, ["Muted thread", "Followed thread"]],
        ],
    );
    assert.deepEqual(ykphone_unread_badges.participated_thread_unread_ids(topics), [
        mine,
        mine_mentioned,
        followed,
    ]);

    // Topics that are neither the general chat nor a thread count only
    // for someone who takes part in them.
    const orphan = add_unread(denmark, "an old topic");
    assert.deepEqual(ykphone_unread_badges.unthreaded_topic_unread_ids(topics), []);
    participated_topics.add(`${denmark}:an old topic`);
    assert.deepEqual(ykphone_unread_badges.unthreaded_topic_unread_ids(topics), [
        orphan_mention - 1,
        orphan_mention,
        orphan,
    ]);

    // A muted thread in an unmuted channel is left out, as is a muted
    // topic of any other kind.
    muted_topics.add(`${verona}:Ship it`);
    assert.deepEqual(ykphone_unread_badges.participated_thread_unread_ids(topics), [followed]);
    muted_topics.add(`${denmark}:an old topic`);
    assert.deepEqual(ykphone_unread_badges.unthreaded_topic_unread_ids(topics), []);

    // Mentions anywhere (the Activity view lists them all) plus the
    // replies in the user's threads and topics, each message once.
    assert.equal(ykphone_unread_badges.activity_unread_count([mine, mine_mentioned, followed]), 4);
    assert.equal(ykphone_unread_badges.activity_unread_count([]), 2);
    assert.ok(unread_mentions_counter.has(orphan_mention));
});

run_test("unthreaded topics wait for the thread list", () => {
    reset();
    participated_topics.add(`${denmark}:an old topic`);
    participated_topics.add(`${denmark}:just opened`);
    const old_message = add_unread(denmark, "an old topic");
    const topics = () => ykphone_unread_badges.unread_non_general_topics();

    // Until the channel's thread list is fetched, any topic may be a
    // thread.
    unloaded_thread_lists.add(denmark);
    assert.deepEqual(ykphone_unread_badges.unthreaded_topic_unread_ids(topics()), []);
    unloaded_thread_lists.delete(denmark);
    assert.deepEqual(ykphone_unread_badges.unthreaded_topic_unread_ids(topics()), [old_message]);

    // A new message in a topic the list already classified counts at
    // once, together with the older ones.
    const newer = add_unread(denmark, "an old topic");
    unclassified_message_ids.add(newer);
    assert.deepEqual(ykphone_unread_badges.unthreaded_topic_unread_ids(topics()), [
        old_message,
        newer,
    ]);

    // A topic whose messages all arrived since may be a thread someone
    // just opened, so it waits for the refresh.
    const first_reply = add_unread(denmark, "just opened");
    unclassified_message_ids.add(first_reply);
    assert.deepEqual(ykphone_unread_badges.unthreaded_topic_unread_ids(topics()), [
        old_message,
        newer,
    ]);
});

function make_channel_row(stream_id) {
    const $li = $(`#stream_filters .narrow-filter[data-stream-id="${stream_id}"]`);
    $li.attr("data-stream-id", stream_id.toString());
    const $subscription_block = $.create(`subscription-block-${stream_id}`);
    const $mention_info = $.create(`mention-info-${stream_id}`);
    $li.set_find_results(".subscription_block", $subscription_block);
    $subscription_block.set_find_results(".unread_mention_info", $mention_info);
    return {$li, $subscription_block, $mention_info};
}

function make_threads_row() {
    const $row = $("#left-sidebar-navigation-list .top_left_row.top_left_recent_view");
    const $count = $.create("threads-row-count");
    $row.set_find_results(".unread_count", $count);
    return {$row, $count};
}

function rail_item(item_id) {
    return $(`#ykphone-rail .ykphone-rail-item[data-rail-item="${item_id}"]`);
}

function rail_badge(item_id) {
    return $(`#ykphone-rail .ykphone-rail-item[data-rail-item="${item_id}"] .ykphone-rail-badge`);
}

run_test("update_channel_row", () => {
    reset();
    const {$li, $subscription_block, $mention_info} = make_channel_row(verona);
    add_unread(verona, "", {mentioned: true});
    add_unread(verona, "Ship it", {mentioned: true});
    ykphone_unread_badges.update_channel_row($li);
    assert.ok($subscription_block.hasClass("ykphone-unread"));
    assert.equal($mention_info.text(), "2");
    assert.ok(!$mention_info.hasClass("no-display"));

    // Reading the general chat keeps the thread mention's pill.
    unread_messages = unread_messages.filter((message) => message.topic !== "");
    ykphone_unread_badges.update_channel_row($li);
    assert.ok(!$subscription_block.hasClass("ykphone-unread"));
    assert.equal($mention_info.text(), "1");

    unread_messages = [];
    ykphone_unread_badges.update_channel_row($li);
    assert.equal($mention_info.text(), "");
    assert.ok($mention_info.hasClass("no-display"));
});

run_test("update_navigation", () => {
    reset();
    const {$row, $count} = make_threads_row();
    for (let i = 0; i < 100; i += 1) {
        add_unread(verona, "Ship it");
    }
    add_unread(verona, "Lunch");
    add_unread(denmark, "an old topic", {mentioned: true});
    add_unread(denmark, "an old topic");
    participated_topics.add(`${denmark}:an old topic`);
    // Someone else's topic counts nowhere, and an archived channel is
    // left out altogether.
    add_unread(denmark, "someone else's");
    subs.set(archived, {stream_id: archived, is_muted: false, is_archived: true});
    add_unread(archived, "Ship it");
    unread_dm_count = 3;
    $('#ykphone-rail .ykphone-rail-item[data-rail-item="dm"] .ykphone-rail-label').text("DM");
    // Listeners (the split pages' rows) run after every refresh.
    let notified = 0;
    ykphone_unread_badges.on_counts_updated(() => {
        notified += 1;
    });

    ykphone_unread_badges.update_navigation();
    assert.equal(notified, 1);
    // Every channel with unread topics other than the general chat has
    // its thread list requested.
    assert.deepEqual(loaded_thread_lists, [verona, denmark]);
    assert.ok($row.hasClass("ykphone-unread"));
    assert.equal($count.text(), "99+");
    assert.ok(!$count.hasClass("hide"));
    assert.equal(rail_badge("dm").text(), "3");
    assert.equal(rail_badge("activity").text(), "99+");
    // The item is named in words for screen readers.
    assert.equal(rail_item("dm").attr("aria-label"), "translated: DM, 3 unread");

    // Under 99: the Threads row and the Activity badge both count the
    // replies in the user's threads and topics; the Activity badge also
    // counts mentions, which here are all among those.
    unread_messages = unread_messages.filter(
        (message) =>
            message.stream_id === archived || message.topic !== "Ship it" || message.id % 10 !== 0,
    );
    ykphone_unread_badges.update_navigation();
    assert.equal($count.text(), "92");
    assert.equal(rail_badge("activity").text(), "92");

    unread_messages = [];
    unread_mentions_counter.clear();
    unread_dm_count = 0;
    ykphone_unread_badges.update_navigation();
    assert.ok(!$row.hasClass("ykphone-unread"));
    assert.equal($count.text(), "");
    assert.ok($count.hasClass("hide"));
    assert.equal(rail_badge("dm").text(), "");
    assert.equal(rail_badge("activity").text(), "");
    assert.equal(rail_item("dm").attr("aria-label"), undefined);
});

run_test("initialize and refresh_all", () => {
    reset();
    const {$subscription_block, $mention_info} = make_channel_row(denmark);
    make_threads_row();
    add_unread(denmark, "");
    add_unread(denmark, "a thread to be", {mentioned: true});
    unloaded_thread_lists.add(denmark);

    ykphone_unread_badges.initialize();
    assert.ok($subscription_block.hasClass("ykphone-unread"));
    assert.equal($mention_info.text(), "");
    assert.equal(rail_badge("activity").text(), "1");
    // Not yet known to be a thread, nor known not to be one.
    assert.equal(
        $("#left-sidebar-navigation-list .top_left_row.top_left_recent_view")
            .find(".unread_count")
            .text(),
        "",
    );
    assert.equal(thread_load_listeners.length, 1);
    assert.equal(threads_changed_listeners.length, 1);

    // The channel's thread list arrives: the topic is a thread the user
    // takes part in.
    add_thread(denmark, "a thread to be", true);
    unloaded_thread_lists.delete(denmark);
    thread_load_listeners[0](denmark);
    assert.equal($mention_info.text(), "1");
    assert.equal(
        $("#left-sidebar-navigation-list .top_left_row.top_left_recent_view")
            .find(".unread_count")
            .text(),
        "1",
    );

    // Joining a thread refreshes the counts.
    make_channel_row(verona);
    add_unread(verona, "Lunch");
    add_thread(verona, "Lunch", true);
    threads_changed_listeners[0]();
    assert.equal(rail_badge("activity").text(), "2");
});
