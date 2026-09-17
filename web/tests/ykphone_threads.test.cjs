"use strict";

const assert = require("node:assert/strict");

const {mock_esm, set_global, zrequire} = require("./lib/namespace.cjs");
const {noop, run_test} = require("./lib/test.cjs");
const {page_params} = require("./lib/zpage_params.cjs");

const me_id = 30;

const channel = mock_esm("../src/channel", {
    xhr_error_message: (message, xhr) => `${message} ${xhr.responseJSON.msg}`,
});
const feedback_widget = mock_esm("../src/feedback_widget");
const message_lists = mock_esm("../src/message_lists");
mock_esm("../src/people", {
    maybe_get_user_by_id: (user_id) => (user_id === 99 ? undefined : {user_id}),
    my_current_user_id: () => me_id,
    small_avatar_url_for_person: (person) => `/avatar/${person.user_id}`,
});
const stream_data = mock_esm("../src/stream_data", {
    is_empty_topic_only_channel: () => false,
});

const message_store = zrequire("message_store");
const ykphone_flags = zrequire("ykphone_flags");
const ykphone_threads = zrequire("ykphone_threads");

const verona_id = 3;

function stream_message(id, topic) {
    return {
        id,
        type: "stream",
        stream_id: verona_id,
        topic,
        timestamp: 1_700_000_000 + id,
        sender_id: 20 + id,
        mentioned: false,
        locally_echoed: false,
    };
}

const root = stream_message(10, "");
const reply = stream_message(11, "Shall we ship on Friday?");
const dm = {id: 12, type: "private", timestamp: 1_700_000_012};

function thread_dict(reply_count, last_reply_timestamp = null, participant_user_ids = []) {
    return {
        root_message_id: root.id,
        stream_id: verona_id,
        topic_name: "Shall we ship on Friday?",
        reply_count,
        last_reply_timestamp,
        participant_user_ids,
        user_participated: false,
    };
}

function reset() {
    ykphone_threads.clear_for_testing();
    message_store.clear_for_testing();
    message_store.update_message_cache({message: root});
}

run_test("flags", () => {
    assert.equal(ykphone_flags.channels_open_in_general_chat(), false);
    ykphone_flags.set_channels_open_in_general_chat(true);
    assert.equal(ykphone_flags.channels_open_in_general_chat(), true);
    ykphone_flags.set_channels_open_in_general_chat(false);
});

run_test("can_thread", ({override}) => {
    assert.equal(ykphone_threads.can_thread(root), true);
    assert.equal(ykphone_threads.can_thread(reply), false);
    assert.equal(ykphone_threads.can_thread(dm), false);
    assert.equal(ykphone_threads.can_thread({...root, locally_echoed: true}), false);
    override(stream_data, "is_empty_topic_only_channel", () => true);
    assert.equal(ykphone_threads.can_thread(root), false);

    // Spectators cannot use the thread endpoints at all.
    page_params.is_spectator = true;
    assert.equal(ykphone_threads.can_thread(root), false);
    page_params.is_spectator = false;
});

run_test("pill_context", () => {
    const with_reply = ykphone_threads.pill_context(thread_dict(1, root.timestamp));
    assert.equal(with_reply.topic_name, "Shall we ship on Friday?");
    assert.equal(with_reply.reply_label, "translated: 1 reply");
    assert.ok(with_reply.last_reply_label !== undefined);

    const several = ykphone_threads.pill_context(thread_dict(3));
    assert.equal(several.reply_label, "translated: 3 replies");
    assert.equal(several.last_reply_label, undefined);
    assert.deepEqual(several.avatar_urls, []);
    assert.equal(several.has_avatars, false);

    // The newest repliers' avatars, at most three, skipping people we
    // do not know.
    const with_people = ykphone_threads.pill_context(thread_dict(5, null, [7, 99, 8, 9]));
    assert.deepEqual(with_people.avatar_urls, ["/avatar/7", "/avatar/8"]);
    assert.equal(with_people.has_avatars, true);
});

run_test("load and pill on first look", ({override}) => {
    reset();
    const rerendered = [];
    override(message_lists, "all_rendered_message_lists", () => [
        {
            view: {
                rerender_messages(messages) {
                    rerendered.push(messages.map((message) => message.id));
                },
            },
        },
    ]);

    const requests = [];
    override(channel, "get", (opts) => {
        requests.push(opts);
    });

    // Direct messages never carry a pill and never trigger a fetch,
    // and neither does anything for a spectator.
    assert.equal(ykphone_threads.get_pill_context_for_message(dm), undefined);
    page_params.is_spectator = true;
    assert.equal(ykphone_threads.get_pill_context_for_message(root), undefined);
    page_params.is_spectator = false;
    assert.equal(requests.length, 0);

    // The first look at a channel fetches its threads once.
    assert.equal(ykphone_threads.get_pill_context_for_message(root), undefined);
    assert.equal(ykphone_threads.get_pill_context_for_message(root), undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/json/ykphone/threads");
    assert.deepEqual(requests[0].data, {stream_id: verona_id});

    // A failed fetch (an archived channel, say) is not retried by
    // rendering; only a forced load asks again.
    requests[0].error({status: 400});
    ykphone_threads.get_pill_context_for_message(root);
    ykphone_threads.load_stream_threads(verona_id);
    assert.equal(requests.length, 1);
    ykphone_threads.load_stream_threads(verona_id, true);
    assert.equal(requests.length, 2);

    requests[1].success({threads: [thread_dict(2, root.timestamp)], participated_topics: []});
    assert.deepEqual(rerendered, [[root.id]]);
    assert.equal(
        ykphone_threads.get_pill_context_for_message(root).reply_label,
        "translated: 2 replies",
    );
    assert.equal(requests.length, 2);

    // Nothing to re-render when the data has not changed.
    ykphone_threads.load_stream_threads(verona_id, true);
    requests[2].success({threads: [thread_dict(2, root.timestamp)], participated_topics: []});
    assert.deepEqual(rerendered, [[root.id]]);

    // New repliers re-render the pill; the same list does not.
    ykphone_threads.load_stream_threads(verona_id, true);
    requests[3].success({threads: [thread_dict(2, root.timestamp, [7])], participated_topics: []});
    assert.deepEqual(rerendered, [[root.id], [root.id]]);
    rerendered.length = 0;
    ykphone_threads.load_stream_threads(verona_id, true);
    requests[4].success({threads: [thread_dict(2, root.timestamp, [8])], participated_topics: []});
    ykphone_threads.load_stream_threads(verona_id, true);
    requests[5].success({threads: [thread_dict(2, root.timestamp, [8])], participated_topics: []});
    assert.deepEqual(rerendered, [[root.id]]);
    rerendered.length = 0;

    // Threads without replies do not get a pill.
    ykphone_threads.load_stream_threads(verona_id, true);
    requests[6].success({threads: [thread_dict(0)], participated_topics: []});
    assert.equal(ykphone_threads.get_pill_context_for_message(root), undefined);

    assert.deepEqual(ykphone_threads.get_thread(root.id), thread_dict(0));
    assert.deepEqual(
        ykphone_threads.get_thread_for_topic(verona_id, "shall we SHIP on friday?"),
        thread_dict(0),
    );
    assert.equal(ykphone_threads.get_thread_for_topic(verona_id, "other"), undefined);
});

run_test("create_thread", ({override}) => {
    reset();
    const posts = [];
    override(channel, "post", (opts) => {
        posts.push(opts);
    });

    const results = [];
    ykphone_threads.create_thread(root.id, (thread) => {
        results.push(thread);
    });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "/json/ykphone/threads");
    assert.deepEqual(posts[0].data, {message_id: root.id});
    posts[0].success(thread_dict(0));
    assert.deepEqual(results, [thread_dict(0)]);

    // A known thread is returned without a request.
    ykphone_threads.create_thread(root.id, (thread) => {
        results.push(thread);
    });
    assert.equal(posts.length, 1);
    assert.equal(results.length, 2);

    // A failure is reported rather than swallowed.
    const shown = [];
    override(feedback_widget, "show", (opts) => {
        const $container = {
            text(message) {
                shown.push({title: opts.title_text, message});
            },
        };
        opts.populate($container);
    });
    ykphone_threads.create_thread(reply.id, noop);
    posts[1].error({responseJSON: {msg: "Invalid message(s)"}});
    assert.deepEqual(shown, [
        {
            title: "translated: Thread",
            message: "translated: Could not open this thread. Invalid message(s)",
        },
    ]);
});

run_test("on_new_messages", ({override}) => {
    reset();
    const rerendered = [];
    override(message_lists, "all_rendered_message_lists", () => [
        {
            view: {
                rerender_messages(messages) {
                    rerendered.push(messages.map((message) => message.id));
                },
            },
        },
    ]);
    const requests = [];
    override(channel, "get", (opts) => {
        requests.push(opts);
    });

    ykphone_threads.load_stream_threads(verona_id);
    requests[0].success({threads: [thread_dict(0)], participated_topics: []});
    // The initial load re-rendered the root once; start counting afresh.
    rerendered.length = 0;

    // A reply in a known thread bumps the count, puts its sender first
    // among the participants and re-renders the root.
    ykphone_threads.on_new_messages([dm, root, reply]);
    const thread = ykphone_threads.get_thread(root.id);
    assert.equal(thread.reply_count, 1);
    assert.equal(thread.last_reply_timestamp, reply.timestamp);
    assert.deepEqual(thread.participant_user_ids, [reply.sender_id]);
    assert.deepEqual(rerendered, [[root.id]]);
    ykphone_threads.on_new_messages([
        {...reply, id: 15, sender_id: 40},
        {...reply, id: 16, sender_id: 41},
        {...reply, id: 17, sender_id: 42},
        {...reply, id: 18, sender_id: 40},
    ]);
    assert.deepEqual(thread.participant_user_ids, [40, 42, 41]);
    assert.deepEqual(rerendered, [[root.id], [root.id]]);
    rerendered.length = 0;

    // Others' replies do not make the user a participant; their own
    // reply does, once.
    let participation_changes = 0;
    ykphone_threads.on_threads_changed(() => {
        participation_changes += 1;
    });
    assert.equal(thread.user_participated, false);
    assert.equal(participation_changes, 0);
    ykphone_threads.on_new_messages([{...reply, id: 19, sender_id: me_id}]);
    assert.equal(thread.user_participated, true);
    assert.equal(participation_changes, 1);
    assert.deepEqual(thread.participant_user_ids, [me_id, 40, 42]);
    ykphone_threads.on_new_messages([{...reply, id: 20, sender_id: me_id}]);
    assert.equal(participation_changes, 1);
    rerendered.length = 0;

    // A reply in an unknown topic of a loaded channel refreshes it.
    ykphone_threads.on_new_messages([stream_message(13, "someone else's thread")]);
    assert.equal(requests.length, 2);

    // Roots that are not in the message store are skipped quietly.
    message_store.clear_for_testing();
    ykphone_threads.on_new_messages([reply]);
    assert.deepEqual(rerendered, []);

    // Unknown topics in channels we never loaded are ignored.
    ykphone_threads.on_new_messages([{...reply, stream_id: 99}]);
    assert.equal(requests.length, 2);
});

run_test("message classification", ({override}) => {
    reset();
    override(message_lists, "all_rendered_message_lists", () => []);
    const requests = [];
    override(channel, "get", (opts) => {
        requests.push(opts);
    });

    // Nothing is known about a channel whose threads were never fetched.
    assert.equal(ykphone_threads.is_message_classified(verona_id, 5), false);
    ykphone_threads.load_stream_threads(verona_id);
    assert.equal(ykphone_threads.is_message_classified(verona_id, 5), false);
    requests[0].success({threads: [thread_dict(0)], participated_topics: []});
    assert.equal(ykphone_threads.is_message_classified(verona_id, 5), true);

    // A message in a topic the list did not know waits for the refresh
    // it triggers.
    ykphone_threads.on_new_messages([stream_message(50, "new topic")]);
    assert.equal(requests.length, 2);
    assert.equal(ykphone_threads.is_message_classified(verona_id, 50), false);
    assert.equal(ykphone_threads.is_message_classified(verona_id, 5), true);

    // One arriving while that refresh is in flight, which may predate
    // it, waits for another one, requested once the first lands.
    ykphone_threads.on_new_messages([stream_message(51, "another topic")]);
    assert.equal(requests.length, 2);
    requests[1].success({threads: [thread_dict(0)], participated_topics: []});
    assert.equal(ykphone_threads.is_message_classified(verona_id, 50), true);
    assert.equal(ykphone_threads.is_message_classified(verona_id, 51), false);
    assert.equal(requests.length, 3);

    // If that one fails, the topics count as what is known of them.
    ykphone_threads.on_new_messages([stream_message(52, "a third topic")]);
    requests[2].error({status: 403});
    assert.equal(ykphone_threads.is_message_classified(verona_id, 51), true);
    assert.equal(ykphone_threads.is_message_classified(verona_id, 52), true);
    assert.equal(requests.length, 3);
});

run_test("messages arriving during the first load", ({override}) => {
    reset();
    override(message_lists, "all_rendered_message_lists", () => []);
    const requests = [];
    override(channel, "get", (opts) => {
        requests.push(opts);
    });

    ykphone_threads.load_stream_threads(verona_id);
    // Someone opens a thread and replies while the first list is on its
    // way; the answer may predate it, so another one is fetched.
    ykphone_threads.on_new_messages([stream_message(60, "opened meanwhile")]);
    assert.equal(requests.length, 1);
    requests[0].success({threads: [], participated_topics: []});
    assert.equal(ykphone_threads.is_message_classified(verona_id, 60), false);
    assert.equal(requests.length, 2);
    requests[1].success({
        threads: [{...thread_dict(1), topic_name: "opened meanwhile"}],
        participated_topics: [],
    });
    assert.equal(ykphone_threads.is_message_classified(verona_id, 60), true);
    assert.equal(
        ykphone_threads.get_thread_for_topic(verona_id, "opened meanwhile").reply_count,
        1,
    );
});

run_test("retrying a failed load", ({override}) => {
    reset();
    const requests = [];
    override(channel, "get", (opts) => {
        requests.push(opts);
    });
    const timers = [];
    set_global("setTimeout", (f, delay) => {
        timers.push({f, delay});
    });

    ykphone_threads.load_stream_threads(verona_id);
    ykphone_threads.on_new_messages([stream_message(70, "while failing")]);
    // A transient failure waits and tries again; nothing else asks in
    // the meantime, and nothing counts as known yet.
    requests[0].error({status: 502});
    assert.deepEqual(
        timers.map((timer) => timer.delay),
        [2000],
    );
    ykphone_threads.load_stream_threads(verona_id);
    ykphone_threads.load_stream_threads(verona_id, true);
    assert.equal(requests.length, 1);
    assert.equal(ykphone_threads.is_message_classified(verona_id, 5), false);
    timers[0].f();
    assert.equal(requests.length, 2);
    // The rate limit is retried too, with a longer wait each time.
    requests[1].error({status: 429});
    timers[1].f();
    requests[2].error({status: 0});
    timers[2].f();
    assert.deepEqual(
        timers.map((timer) => timer.delay),
        [2000, 10_000, 30_000],
    );
    // Then it gives up quietly: the channel counts as what is known.
    requests[3].error({status: 504});
    assert.equal(timers.length, 3);
    assert.equal(ykphone_threads.is_message_classified(verona_id, 5), true);
    assert.equal(ykphone_threads.is_message_classified(verona_id, 70), true);
    ykphone_threads.load_stream_threads(verona_id);
    assert.equal(requests.length, 4);

    // A forced load starts over, and a success resets the attempts.
    ykphone_threads.load_stream_threads(verona_id, true);
    requests[4].error({status: 503});
    timers[3].f();
    requests[5].success({threads: [], participated_topics: []});
    ykphone_threads.load_stream_threads(verona_id, true);
    requests[6].error({status: 503});
    assert.equal(timers.at(-1).delay, 2000);
});

run_test("merging a thread list", ({override}) => {
    reset();
    override(message_lists, "all_rendered_message_lists", () => []);
    const requests = [];
    override(channel, "get", (opts) => {
        requests.push(opts);
    });
    const other = {...thread_dict(0), root_message_id: 40, topic_name: "Other"};

    ykphone_threads.load_stream_threads(verona_id);
    requests[0].success({threads: [thread_dict(1), other], participated_topics: []});
    // The user's own reply lands while a refresh is in flight whose
    // answer predates it; taking part is not revoked.
    ykphone_threads.load_stream_threads(verona_id, true);
    ykphone_threads.on_new_messages([{...reply, id: 41, sender_id: me_id}]);
    assert.equal(ykphone_threads.get_thread(root.id).user_participated, true);
    // A thread renamed on the server loses its old name, and one that
    // is no longer listed (deleted, or moved away) is forgotten.
    requests[1].success({
        threads: [{...thread_dict(1), topic_name: "✔ Shall we ship on Friday?"}],
        participated_topics: [],
    });
    assert.equal(ykphone_threads.get_thread(root.id).user_participated, true);
    assert.equal(
        ykphone_threads.get_thread_for_topic(verona_id, "Shall we ship on Friday?"),
        undefined,
    );
    assert.equal(
        ykphone_threads.get_thread_for_topic(verona_id, "✔ shall we ship on friday?")
            .root_message_id,
        root.id,
    );
    assert.equal(ykphone_threads.get_thread(40), undefined);
    assert.equal(ykphone_threads.get_thread_for_topic(verona_id, "Other"), undefined);

    // Two threads that swapped names keep each other's.
    const third = {...thread_dict(0), root_message_id: 42, topic_name: "Third"};
    ykphone_threads.load_stream_threads(verona_id, true);
    requests[2].success({
        threads: [{...thread_dict(1), topic_name: "✔ Shall we ship on Friday?"}, third],
        participated_topics: [],
    });
    ykphone_threads.load_stream_threads(verona_id, true);
    requests[3].success({
        threads: [
            {...third, topic_name: "✔ Shall we ship on Friday?"},
            {...thread_dict(1), topic_name: "Third"},
        ],
        participated_topics: [],
    });
    assert.equal(ykphone_threads.get_thread_for_topic(verona_id, "third").root_message_id, root.id);
    assert.equal(
        ykphone_threads.get_thread_for_topic(verona_id, "✔ Shall we ship on Friday?")
            .root_message_id,
        42,
    );
});

run_test("topics the user takes part in", ({override}) => {
    reset();
    const requests = [];
    override(channel, "get", (opts) => {
        requests.push(opts);
    });
    let changes = 0;
    ykphone_threads.on_threads_changed(() => {
        changes += 1;
    });

    assert.equal(ykphone_threads.user_takes_part_in_topic(verona_id, "Mobile topic"), false);
    ykphone_threads.load_stream_threads(verona_id);
    requests[0].success({threads: [], participated_topics: ["Mobile topic"]});
    assert.equal(ykphone_threads.user_takes_part_in_topic(verona_id, "MOBILE topic"), true);
    assert.equal(changes, 0);

    // Someone else's message changes nothing; the user's own message or
    // a mention of them makes the topic theirs.
    ykphone_threads.on_new_messages([stream_message(80, "Elsewhere")]);
    assert.equal(ykphone_threads.user_takes_part_in_topic(verona_id, "Elsewhere"), false);
    ykphone_threads.on_new_messages([{...stream_message(81, "Elsewhere"), sender_id: me_id}]);
    assert.equal(ykphone_threads.user_takes_part_in_topic(verona_id, "Elsewhere"), true);
    ykphone_threads.on_new_messages([{...stream_message(82, "Asked"), mentioned: true}]);
    assert.equal(ykphone_threads.user_takes_part_in_topic(verona_id, "Asked"), true);
    assert.equal(changes, 2);
    ykphone_threads.on_new_messages([{...stream_message(83, "Asked"), mentioned: true}]);
    assert.equal(changes, 2);

    // A later answer that does not list a topic yet keeps it.
    requests.at(-1).success({threads: [], participated_topics: []});
    assert.equal(ykphone_threads.user_takes_part_in_topic(verona_id, "Asked"), true);
});

run_test("on_messages_moved", ({override}) => {
    reset();
    const rerendered = [];
    override(message_lists, "all_rendered_message_lists", () => [
        {
            view: {
                rerender_messages(messages) {
                    rerendered.push(messages.map((message) => message.id));
                },
            },
        },
    ]);
    const requests = [];
    override(channel, "get", (opts) => {
        requests.push(opts);
    });
    let changes = 0;
    ykphone_threads.on_threads_changed(() => {
        changes += 1;
    });
    const topic = "Shall we ship on Friday?";
    const denmark_id = 4;

    ykphone_threads.load_stream_threads(verona_id);
    requests[0].success({threads: [thread_dict(1)], participated_topics: ["Mobile topic"]});
    rerendered.length = 0;

    // Content edits and events without a channel are not moves.
    ykphone_threads.on_messages_moved([
        {message_ids: [11], rendering_only: false},
        {message_ids: [11], stream_id: verona_id, rendering_only: false},
    ]);
    assert.equal(changes, 0);
    assert.equal(requests.length, 1);

    // Resolving the whole topic moves the thread at once, and the list
    // is fetched again to confirm; the moved messages wait for it.
    ykphone_threads.on_messages_moved([
        {
            message_ids: [11],
            stream_id: verona_id,
            orig_subject: topic,
            subject: `✔ ${topic}`,
            propagate_mode: "change_all",
        },
    ]);
    assert.equal(
        ykphone_threads.get_thread_for_topic(verona_id, `✔ ${topic}`).root_message_id,
        root.id,
    );
    assert.equal(ykphone_threads.get_thread_for_topic(verona_id, topic), undefined);
    assert.deepEqual(rerendered, [[root.id]]);
    assert.equal(ykphone_threads.is_message_classified(verona_id, 11), false);
    assert.equal(requests.length, 2);
    assert.equal(changes, 1);

    // Moving part of a topic to a channel whose list was never fetched
    // leaves the cache to the refresh.
    ykphone_threads.on_messages_moved([
        {
            message_ids: [11],
            stream_id: verona_id,
            new_stream_id: denmark_id,
            orig_subject: `✔ ${topic}`,
            propagate_mode: "change_one",
        },
    ]);
    assert.equal(
        ykphone_threads.get_thread_for_topic(verona_id, `✔ ${topic}`).stream_id,
        verona_id,
    );
    assert.equal(requests.length, 2);

    // A whole topic moved into another thread's topic joins that thread.
    requests[1].success({
        threads: [
            {...thread_dict(1), topic_name: `✔ ${topic}`},
            {...thread_dict(0), root_message_id: 40, topic_name: "Other"},
        ],
        participated_topics: [],
    });
    ykphone_threads.on_messages_moved([
        {
            message_ids: [11],
            stream_id: verona_id,
            orig_subject: `✔ ${topic}`,
            subject: "Other",
            propagate_mode: "change_all",
        },
    ]);
    assert.equal(ykphone_threads.get_thread(root.id), undefined);
    assert.equal(ykphone_threads.get_thread_for_topic(verona_id, "other").root_message_id, 40);

    // Taking part in a plain topic follows it to another channel.
    ykphone_threads.on_messages_moved([
        {
            message_ids: [12],
            stream_id: verona_id,
            new_stream_id: denmark_id,
            orig_subject: "Mobile topic",
            propagate_mode: "change_all",
        },
    ]);
    assert.equal(ykphone_threads.user_takes_part_in_topic(denmark_id, "Mobile topic"), true);
});

run_test("on_messages_removed", ({override}) => {
    reset();
    const rerendered = [];
    override(message_lists, "all_rendered_message_lists", () => [
        {
            view: {
                rerender_messages(messages) {
                    rerendered.push(messages.map((message) => message.id));
                },
            },
        },
    ]);
    const requests = [];
    override(channel, "get", (opts) => {
        requests.push(opts);
    });
    const loaded_streams = [];
    ykphone_threads.on_stream_threads_loaded((stream_id) => {
        loaded_streams.push(stream_id);
    });

    ykphone_threads.load_stream_threads(verona_id);
    requests[0].success({threads: [thread_dict(2, reply.timestamp)], participated_topics: []});
    assert.deepEqual(loaded_streams, [verona_id]);
    rerendered.length = 0;

    // Deleting a reply lowers the count while its topic is still known.
    message_store.update_message_cache({message: reply});
    ykphone_threads.on_messages_removed([reply.id]);
    assert.equal(ykphone_threads.get_thread(root.id).reply_count, 1);
    assert.equal(ykphone_threads.get_thread(root.id).last_reply_timestamp, reply.timestamp);
    assert.deepEqual(rerendered, [[root.id]]);

    // Messages we never had, direct messages, general chat messages
    // and replies in topics that are not threads change nothing.
    message_store.update_message_cache({message: dm});
    message_store.update_message_cache({message: stream_message(14, "not a thread")});
    ykphone_threads.on_messages_removed([99, dm.id, root.id + 100, 14]);
    assert.equal(ykphone_threads.get_thread(root.id).reply_count, 1);
    assert.deepEqual(rerendered, [[root.id]]);

    // The count never goes below zero, and an empty thread loses its
    // last-reply time.
    ykphone_threads.on_messages_removed([reply.id, reply.id]);
    assert.equal(ykphone_threads.get_thread(root.id).reply_count, 0);
    assert.equal(ykphone_threads.get_thread(root.id).last_reply_timestamp, null);

    // Deleting the root forgets the thread, even in the same batch as
    // one of its replies, and says so.
    let changes = 0;
    ykphone_threads.on_threads_changed(() => {
        changes += 1;
    });
    assert.equal(changes, 0);
    ykphone_threads.on_messages_removed([reply.id, root.id]);
    assert.equal(changes, 1);
    assert.equal(ykphone_threads.get_thread(root.id), undefined);
    assert.equal(
        ykphone_threads.get_thread_for_topic(verona_id, "Shall we ship on Friday?"),
        undefined,
    );
    assert.deepEqual(rerendered, [[root.id], [root.id]]);
});
