"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {noop, run_test} = require("./lib/test.cjs");
const {page_params} = require("./lib/zpage_params.cjs");

const channel = mock_esm("../src/channel", {
    xhr_error_message: (message, xhr) => `${message} ${xhr.responseJSON.msg}`,
});
const feedback_widget = mock_esm("../src/feedback_widget");
const message_lists = mock_esm("../src/message_lists");
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
        locally_echoed: false,
    };
}

const root = stream_message(10, "");
const reply = stream_message(11, "Shall we ship on Friday?");
const dm = {id: 12, type: "private", timestamp: 1_700_000_012};

function thread_dict(reply_count, last_reply_timestamp = null) {
    return {
        root_message_id: root.id,
        stream_id: verona_id,
        topic_name: "Shall we ship on Friday?",
        reply_count,
        last_reply_timestamp,
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
    requests[0].error();
    ykphone_threads.get_pill_context_for_message(root);
    ykphone_threads.load_stream_threads(verona_id);
    assert.equal(requests.length, 1);
    ykphone_threads.load_stream_threads(verona_id, true);
    assert.equal(requests.length, 2);

    requests[1].success({threads: [thread_dict(2, root.timestamp)]});
    assert.deepEqual(rerendered, [[root.id]]);
    assert.equal(
        ykphone_threads.get_pill_context_for_message(root).reply_label,
        "translated: 2 replies",
    );
    assert.equal(requests.length, 2);

    // Nothing to re-render when the data has not changed.
    ykphone_threads.load_stream_threads(verona_id, true);
    requests[2].success({threads: [thread_dict(2, root.timestamp)]});
    assert.deepEqual(rerendered, [[root.id]]);

    // Threads without replies do not get a pill.
    ykphone_threads.load_stream_threads(verona_id, true);
    requests[3].success({threads: [thread_dict(0)]});
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
    requests[0].success({threads: [thread_dict(0)]});
    // The initial load re-rendered the root once; start counting afresh.
    rerendered.length = 0;

    // A reply in a known thread bumps the count and re-renders the root.
    ykphone_threads.on_new_messages([dm, root, reply]);
    const thread = ykphone_threads.get_thread(root.id);
    assert.equal(thread.reply_count, 1);
    assert.equal(thread.last_reply_timestamp, reply.timestamp);
    assert.deepEqual(rerendered, [[root.id]]);

    // A reply in an unknown topic of a loaded channel refreshes it.
    ykphone_threads.on_new_messages([stream_message(13, "someone else's thread")]);
    assert.equal(requests.length, 2);

    // Roots that are not in the message store are skipped quietly.
    message_store.clear_for_testing();
    ykphone_threads.on_new_messages([reply]);
    assert.deepEqual(rerendered, [[root.id]]);

    // Unknown topics in channels we never loaded are ignored.
    ykphone_threads.on_new_messages([{...reply, stream_id: 99}]);
    assert.equal(requests.length, 2);
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
    requests[0].success({threads: [thread_dict(2, reply.timestamp)]});
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
    // one of its replies.
    ykphone_threads.on_messages_removed([reply.id, root.id]);
    assert.equal(ykphone_threads.get_thread(root.id), undefined);
    assert.equal(
        ykphone_threads.get_thread_for_topic(verona_id, "Shall we ship on Friday?"),
        undefined,
    );
    assert.deepEqual(rerendered, [[root.id], [root.id]]);
});
