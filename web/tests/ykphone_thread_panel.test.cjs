"use strict";

const assert = require("node:assert/strict");

const {clock, mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const $ = require("./lib/zjquery.cjs");

const verona_id = 3;
const verona = {
    stream_id: verona_id,
    name: "Verona",
    color: "#c2726a",
    invite_only: false,
    is_web_public: false,
    is_archived: false,
};
const topic_name = "Shall we ship on Friday?";
const thread = {
    root_message_id: 10,
    stream_id: verona_id,
    topic_name,
    reply_count: 0,
    last_reply_timestamp: null,
};
const other_thread = {
    root_message_id: 20,
    stream_id: verona_id,
    topic_name: "Other thread",
    reply_count: 0,
    last_reply_timestamp: null,
};

const channel = mock_esm("../src/channel", {
    xhr_error_message: (message, xhr) => `${message} ${xhr.responseJSON.msg}`,
});
mock_esm("../src/hash_util", {
    by_stream_topic_url: (stream_id, topic) => `#narrow/channel/${stream_id}/topic/${topic}`,
});
const message_helper = mock_esm("../src/message_helper");
const message_util = mock_esm("../src/message_util");
const message_viewport = mock_esm("../src/message_viewport");
const narrow_state = mock_esm("../src/narrow_state");
mock_esm("../src/people", {small_avatar_url: (message) => `avatar-${message.sender_id}.png`});
const rendered_markdown = mock_esm("../src/rendered_markdown");
mock_esm("../src/stream_data", {
    get_sub_by_id: (stream_id) => (stream_id === verona_id ? verona : undefined),
});
mock_esm("../src/timerender", {
    get_localized_date_or_time_for_format: (date, format) => `${format} ${date.getTime()}`,
});
const unread_ops = mock_esm("../src/unread_ops");
const ykphone_threads = mock_esm("../src/ykphone_threads");
mock_esm("../src/ykphone_time", {
    hour_and_minute: (timestamp) => `gutter ${timestamp}`,
});

const message_store = zrequire("message_store");
const ykphone_thread_panel = zrequire("ykphone_thread_panel");

// The root was sent "today"; replies a day later are shown with a date.
const now = 1_700_000_000;
const yesterday = now - 24 * 60 * 60;
const last_year = now - 400 * 24 * 60 * 60;

function stored_message(id, opts = {}) {
    return {
        id,
        type: "stream",
        stream_id: verona_id,
        topic: topic_name,
        sender_id: 10,
        sender_full_name: "Hamlet",
        timestamp: now + id,
        content: `<p>message ${id}</p>`,
        locally_echoed: false,
        ...opts,
    };
}

function put_in_store(message) {
    message_store.update_message_cache({type: "server_message", message});
    return message;
}

function raw_message(id, opts = {}) {
    return {
        id,
        type: "stream",
        stream_id: verona_id,
        subject: topic_name,
        topic_links: [],
        avatar_url: null,
        client: "website",
        content: `<p>message ${id}</p>`,
        content_type: "text/html",
        display_recipient: "Verona",
        is_me_message: false,
        reactions: [],
        sender_email: "hamlet@zulip.com",
        sender_full_name: "Hamlet",
        sender_id: 10,
        submessages: [],
        timestamp: now + id,
        flags: [],
        ...opts,
    };
}

function make_dom() {
    $.clear_all_elements();
    const $panel = $("#ykphone-thread-panel");
    const $body = $.create("panel-body");
    const $textarea = $.create("panel-textarea");
    const $send = $.create("panel-send");
    const $error = $.create("panel-send-error");
    const $markdown = $.create("panel-markdown");
    $panel.set_find_results(".ykphone-thread-panel-body", $body);
    $panel.set_find_results(".ykphone-thread-panel-textarea", $textarea);
    $panel.set_find_results(".ykphone-thread-panel-send", $send);
    $panel.set_find_results(".ykphone-thread-panel-send-error", $error);
    $body.set_find_results(".rendered_markdown", $markdown);
    $body[0].scrollTop = 0;
    $body[0].clientHeight = 100;
    $body[0].scrollHeight = 100;
    const $root = $("#ykphone-thread-root");
    $root.set_find_results(".rendered_markdown", $.create("root-markdown"));
    // The block is as tall as its content, like in the browser.
    Object.defineProperty($root[0], "offsetHeight", {
        get() {
            return this.innerHTML === "" ? 0 : 80;
        },
    });
    return {$panel, $body, $textarea, $send, $error, $markdown, $root};
}

function setup({override}) {
    clock.setSystemTime((now - 5) * 1000);
    ykphone_thread_panel.clear_for_testing();
    message_store.clear_for_testing();
    const dom = make_dom();

    const gets = [];
    const posts = [];
    override(channel, "get", (opts) => {
        gets.push(opts);
    });
    override(
        channel,
        "post",
        (opts) => {
            posts.push(opts);
        },
        {unused: false},
    );
    override(
        message_helper,
        "process_new_server_message",
        (raw) => {
            const {subject, ...rest} = raw;
            return put_in_store({...rest, topic: subject});
        },
        {unused: false},
    );
    const unread_updates = [];
    override(
        message_util,
        "do_unread_count_updates",
        (messages, expect_no_new_unreads) => {
            unread_updates.push({
                ids: messages.map((message) => message.id),
                expect_no_new_unreads,
            });
        },
        {unused: false},
    );
    const marked_read = [];
    override(
        unread_ops,
        "notify_server_messages_read",
        (messages) => {
            marked_read.push(messages.map((message) => message.id));
        },
        {unused: false},
    );
    override(unread_ops, "is_window_focused", () => true, {unused: false});
    const markdown_updates = [];
    override(
        rendered_markdown,
        "update_elements",
        ($content) => {
            markdown_updates.push($content);
        },
        {unused: false},
    );
    const conversation_filter = {is_conversation_view: () => true};
    override(narrow_state, "filter", () => conversation_filter, {unused: false});
    override(narrow_state, "stream_id", () => undefined, {unused: false});
    override(narrow_state, "topic", () => undefined, {unused: false});
    let scroll_top = 0;
    override(
        message_viewport,
        "scrollTop",
        (value) => {
            if (value !== undefined) {
                scroll_top = value;
            }
            return scroll_top;
        },
        {unused: false},
    );
    const set_scroll_top = (value) => {
        scroll_top = value;
    };
    const get_scroll_top = () => scroll_top;
    override(ykphone_threads, "get_thread_for_topic", () => undefined, {unused: false});

    return {
        ...dom,
        gets,
        posts,
        unread_updates,
        marked_read,
        markdown_updates,
        conversation_filter,
        set_scroll_top,
        get_scroll_top,
    };
}

run_test("open with cached root", (helpers) => {
    const t = setup(helpers);
    put_in_store(stored_message(thread.root_message_id, {topic: ""}));

    assert.equal(ykphone_thread_panel.is_open(), false);
    ykphone_thread_panel.open_thread(thread);
    assert.equal(ykphone_thread_panel.is_open(), true);
    assert.equal(ykphone_thread_panel.get_open_thread(), thread);
    assert.ok($("body").hasClass("ykphone-thread-open"));
    assert.ok(t.$textarea.is_focused());

    const shell = t.$panel.html();
    assert.ok(shell.includes("translated: Thread"));
    assert.ok(shell.includes("Verona"));
    assert.ok(shell.includes("zulip-icon-hashtag"));
    assert.ok(shell.includes(`href="#narrow/channel/${verona_id}/topic/${topic_name}"`));
    assert.ok(t.$body.html().includes("translated: Loading…"));

    // Only the replies are fetched; the root came from the store.
    assert.equal(t.gets.length, 1);
    assert.equal(t.gets[0].url, "/json/messages");
    assert.deepEqual(t.gets[0].data, {
        anchor: "newest",
        num_before: 200,
        num_after: 0,
        narrow: JSON.stringify([
            {operator: "channel", operand: verona_id},
            {operator: "topic", operand: topic_name},
        ]),
        apply_markdown: true,
        client_gravatar: true,
        allow_empty_topic_name: true,
    });

    // A reply from last year, two from Hamlet in quick succession
    // yesterday, then one from Othello today.
    t.gets[0].success({
        messages: [
            raw_message(9, {timestamp: last_year}),
            raw_message(11, {timestamp: yesterday + 11}),
            raw_message(12, {timestamp: yesterday + 12}),
            raw_message(13, {sender_id: 11, sender_full_name: "Othello"}),
        ],
    });
    const body = t.$body.html();
    assert.ok(body.includes("translated: 4 replies"));
    assert.ok(body.includes("<p>message 10</p>"));
    assert.ok(body.includes("ykphone-thread-panel-root"));
    assert.ok(body.includes("Othello"));
    assert.ok(body.includes('src="avatar-11.png"'));
    // The root is from today, the next reply from another day and the
    // oldest one from another year.
    assert.ok(body.includes(`time ${(now + 10) * 1000}`));
    assert.ok(body.includes(`dayofyear_time ${(yesterday + 11) * 1000}`));
    assert.ok(body.includes(`dayofyear_year_time ${last_year * 1000}`));
    // Message 12 is grouped under message 11, so it shows the bare
    // clock in the gutter instead of a sender line.
    assert.ok(body.includes(`ykphone-thread-panel-gutter-time">gutter ${(yesterday + 12) * 1000}`));
    // Message 12 collapses under message 11's sender line.
    assert.equal(body.match(/ykphone-thread-panel-message-with-sender/g).length, 4);
    assert.ok(!body.includes("translated: Loading…"));

    assert.deepEqual(t.unread_updates, [{ids: [9, 11, 12, 13], expect_no_new_unreads: true}]);
    assert.deepEqual(t.marked_read, [[10, 9, 11, 12, 13]]);
    assert.equal(t.markdown_updates.length, 1);
    assert.deepEqual([...t.markdown_updates[0]], [...t.$markdown]);
    assert.equal(t.$body.prop("scrollTop"), 100);
});

run_test("open fetches a missing root and handles an unknown channel", (helpers) => {
    const t = setup(helpers);
    const unknown_channel_thread = {...thread, stream_id: 99};

    ykphone_thread_panel.open_thread(unknown_channel_thread);
    assert.ok(!t.$panel.html().includes("ykphone-thread-panel-channel"));

    assert.equal(t.gets.length, 2);
    assert.equal(t.gets[0].url, "/json/messages/10");
    assert.deepEqual(t.gets[0].data, {apply_markdown: true, allow_empty_topic_name: true});
    assert.equal(t.gets[1].url, "/json/messages");

    // The replies land first; the panel waits for the root.
    t.gets[1].success({messages: []});
    assert.ok(t.$body.html().includes("translated: Loading…"));
    t.gets[0].success({message: raw_message(10, {subject: ""})});
    const body = t.$body.html();
    assert.ok(body.includes("<p>message 10</p>"));
    assert.ok(body.includes("translated: No replies yet. Start the conversation."));
    assert.ok(!body.includes("ykphone-thread-panel-divider"));
    assert.deepEqual(t.marked_read, [[10]]);
    assert.equal(message_store.get(10).topic, "");
});

run_test("load errors", (helpers) => {
    const t = setup(helpers);
    const xhr = {responseJSON: {msg: "Invalid channel"}};

    ykphone_thread_panel.open_thread(thread);
    t.gets[1].error(xhr);
    assert.ok(t.$body.html().includes("translated: Could not load this thread. Invalid channel"));
    assert.ok(t.$body.html().includes("ykphone-thread-panel-error"));
    // The root request's late answers are ignored either way.
    t.gets[0].success({message: raw_message(10, {subject: ""})});
    t.gets[0].error(xhr);
    assert.ok(t.$body.html().includes("Invalid channel"));
    assert.deepEqual(t.marked_read, []);

    // A failing root fetch is reported the same way, and the panel
    // can still be closed.
    ykphone_thread_panel.close();
    ykphone_thread_panel.open_thread(thread);
    t.gets[2].error(xhr);
    assert.ok(t.$body.html().includes("Invalid channel"));
    t.gets[3].success({messages: []});
    t.gets[3].error(xhr);
    assert.equal(ykphone_thread_panel.close(), true);
    assert.equal(ykphone_thread_panel.close(), false);
});

run_test("swap and close", (helpers) => {
    const t = setup(helpers);
    put_in_store(stored_message(thread.root_message_id, {topic: ""}));
    put_in_store(stored_message(other_thread.root_message_id, {topic: ""}));

    ykphone_thread_panel.open_thread(thread);
    // Opening the same thread again only refocuses the composer.
    t.$textarea.trigger("blur");
    ykphone_thread_panel.open_thread({...thread});
    assert.ok(t.$textarea.is_focused());
    assert.equal(t.gets.length, 1);
    ykphone_thread_panel.open_thread(other_thread);
    assert.equal(ykphone_thread_panel.get_open_thread(), other_thread);
    // The first thread's replies arrive too late to matter.
    t.gets[0].success({messages: [raw_message(11)]});
    assert.ok(t.$body.html().includes("translated: Loading…"));
    t.gets[1].success({messages: [raw_message(21, {subject: other_thread.topic_name})]});
    assert.ok(t.$body.html().includes("<p>message 21</p>"));
    assert.ok(!t.$body.html().includes("<p>message 11</p>"));

    const $thread_button = $(
        `.message_row[data-message-id="${other_thread.root_message_id}"] .ykphone-thread-button .message-controls-icon`,
    );
    assert.equal(ykphone_thread_panel.close(), true);
    assert.equal(ykphone_thread_panel.is_open(), false);
    assert.ok(!$("body").hasClass("ykphone-thread-open"));
    assert.equal(t.$panel.html(), "");
    // Focus goes back to the control the thread was opened from.
    assert.ok($thread_button.is_focused());
    assert.equal(ykphone_thread_panel.close(), false);

    // A response for a closed panel is dropped.
    ykphone_thread_panel.open_thread(thread);
    ykphone_thread_panel.close();
    t.gets[2].success({messages: [raw_message(11)]});
    assert.equal(t.$panel.html(), "");
});

run_test("close when narrowed to the open thread", (helpers) => {
    const t = setup(helpers);
    put_in_store(stored_message(thread.root_message_id, {topic: ""}));

    ykphone_thread_panel.close_if_narrowed_to_open_thread();
    ykphone_thread_panel.open_thread(thread);
    t.gets[0].success({messages: []});

    helpers.override(narrow_state, "stream_id", () => verona_id);
    ykphone_thread_panel.close_if_narrowed_to_open_thread();
    assert.equal(ykphone_thread_panel.is_open(), true);

    helpers.override(narrow_state, "topic", () => "some other topic");
    ykphone_thread_panel.close_if_narrowed_to_open_thread();
    assert.equal(ykphone_thread_panel.is_open(), true);

    helpers.override(narrow_state, "stream_id", () => 4);
    helpers.override(narrow_state, "topic", () => topic_name);
    ykphone_thread_panel.close_if_narrowed_to_open_thread();
    assert.equal(ykphone_thread_panel.is_open(), true);

    // Through the narrow-activated hook, as message_view calls it.
    helpers.override(narrow_state, "stream_id", () => verona_id);
    helpers.override(narrow_state, "topic", () => topic_name.toUpperCase());
    ykphone_thread_panel.handle_narrow_activated();
    assert.equal(ykphone_thread_panel.is_open(), false);
});

run_test("send reply", (helpers) => {
    const t = setup(helpers);
    put_in_store(stored_message(thread.root_message_id, {topic: ""}));

    // Nothing is sent while the panel is closed or the box is blank.
    ykphone_thread_panel.send_reply();
    ykphone_thread_panel.open_thread(thread);
    t.gets[0].success({messages: []});
    ykphone_thread_panel.send_reply();
    t.$textarea.val("   ");
    ykphone_thread_panel.send_reply();
    assert.equal(t.posts.length, 0);

    t.$textarea.val("  Sounds good  ");
    ykphone_thread_panel.send_reply();
    assert.equal(t.posts.length, 1);
    assert.equal(t.posts[0].url, "/json/messages");
    assert.deepEqual(t.posts[0].data, {
        type: "stream",
        to: JSON.stringify([verona_id]),
        topic: topic_name,
        content: "Sounds good",
    });
    assert.equal(t.$send.prop("disabled"), true);
    // Only one request at a time.
    ykphone_thread_panel.send_reply();
    assert.equal(t.posts.length, 1);

    t.posts[0].error({responseJSON: {msg: "Channel is archived"}});
    assert.equal(t.$send.prop("disabled"), false);
    assert.equal(t.$error.text(), "translated: Failed to send reply. Channel is archived");
    assert.equal(t.$textarea.val(), "  Sounds good  ");

    ykphone_thread_panel.send_reply();
    t.posts[1].success({id: 11});
    assert.equal(t.$send.prop("disabled"), false);
    assert.equal(t.$error.text(), "");
    assert.equal(t.$textarea.val(), "");

    // Answers for a thread that was swapped out leave the new one
    // alone, and do not unblock a send that is in flight for it.
    t.$textarea.val("late");
    ykphone_thread_panel.send_reply();
    t.$send.prop("disabled", "untouched");
    ykphone_thread_panel.open_thread(other_thread);
    t.$textarea.val("for the other thread");
    ykphone_thread_panel.send_reply();
    assert.equal(t.posts.length, 4);
    t.$send.prop("disabled", "untouched");
    t.posts[2].success({id: 12});
    assert.equal(t.$send.prop("disabled"), "untouched");
    ykphone_thread_panel.send_reply();
    assert.equal(t.posts.length, 4);
    t.posts[3].success({id: 13});
    assert.equal(t.$send.prop("disabled"), false);
    assert.equal(t.$textarea.val(), "");

    // The same for a failure arriving after a swap.
    t.$textarea.val("late again");
    ykphone_thread_panel.send_reply();
    t.$send.prop("disabled", "untouched");
    ykphone_thread_panel.open_thread(thread);
    t.posts[4].error({responseJSON: {msg: "nope"}});
    assert.equal(t.$send.prop("disabled"), "untouched");
    assert.equal(t.$error.text(), "");
});

run_test("new messages", (helpers) => {
    const t = setup(helpers);
    put_in_store(stored_message(thread.root_message_id, {topic: ""}));

    // Closed: nothing happens.
    ykphone_thread_panel.on_new_messages([stored_message(11)]);

    ykphone_thread_panel.open_thread(thread);
    // A reply arriving while the fetch is in flight is kept.
    ykphone_thread_panel.on_new_messages([stored_message(12)]);
    assert.ok(t.$body.html().includes("translated: Loading…"));
    t.gets[0].success({messages: [raw_message(11), raw_message(12)]});
    assert.ok(t.$body.html().includes("translated: 2 replies"));
    assert.deepEqual(t.marked_read, [[10, 11, 12]]);

    // Other topics, direct messages, local echoes and duplicates are
    // ignored; a real reply is appended and marked read.
    ykphone_thread_panel.on_new_messages([
        stored_message(13, {topic: "elsewhere"}),
        stored_message(14, {stream_id: 4}),
        {...stored_message(15), type: "private"},
        stored_message(16, {locally_echoed: true}),
        stored_message(12),
    ]);
    assert.ok(t.$body.html().includes("translated: 2 replies"));
    assert.equal(t.marked_read.length, 1);

    // The reader is at the end of the thread, so the panel follows.
    t.$body[0].scrollTop = 60;
    t.$body[0].scrollHeight = 160;
    ykphone_thread_panel.on_new_messages([stored_message(17, {topic: topic_name.toUpperCase()})]);
    assert.ok(t.$body.html().includes("translated: 3 replies"));
    assert.deepEqual(t.marked_read, [[10, 11, 12], [17]]);
    assert.equal(t.$body.prop("scrollTop"), 160);

    // Scrolled up and the window unfocused: no jump, nothing marked.
    helpers.override(unread_ops, "is_window_focused", () => false);
    t.$body[0].scrollTop = 0;
    t.$body[0].scrollHeight = 500;
    ykphone_thread_panel.on_new_messages([stored_message(18)]);
    assert.ok(t.$body.html().includes("translated: 4 replies"));
    assert.equal(t.marked_read.length, 2);
    assert.equal(t.$body.prop("scrollTop"), 0);

    // A reply arriving while the panel shows a load error is kept for
    // a later successful load but not shown.
    ykphone_thread_panel.open_thread(other_thread);
    t.gets[1].error({responseJSON: {msg: "Gone"}});
    ykphone_thread_panel.on_new_messages([stored_message(21, {topic: other_thread.topic_name})]);
    assert.ok(t.$body.html().includes("Gone"));
    assert.ok(!t.$body.html().includes("<p>message 21</p>"));
    assert.equal(t.marked_read.length, 2);
});

run_test("removed messages", (helpers) => {
    const t = setup(helpers);
    put_in_store(stored_message(thread.root_message_id, {topic: ""}));

    // Closed: nothing happens.
    ykphone_thread_panel.on_messages_removed([11]);

    ykphone_thread_panel.open_thread(thread);
    // Not rendered until the fetch lands.
    ykphone_thread_panel.on_new_messages([stored_message(11), stored_message(12)]);
    ykphone_thread_panel.on_messages_removed([12]);
    t.gets[0].success({messages: [raw_message(11)]});
    assert.ok(t.$body.html().includes("translated: 1 reply"));

    ykphone_thread_panel.on_messages_removed([99]);
    assert.ok(t.$body.html().includes("translated: 1 reply"));
    ykphone_thread_panel.on_messages_removed([11]);
    assert.ok(t.$body.html().includes("translated: No replies yet."));

    // Deleting the root closes the thread.
    ykphone_thread_panel.on_messages_removed([thread.root_message_id]);
    assert.equal(ykphone_thread_panel.is_open(), false);
});

run_test("updated messages", (helpers) => {
    const t = setup(helpers);
    const root = put_in_store(stored_message(thread.root_message_id, {topic: ""}));

    ykphone_thread_panel.on_messages_updated([11]);

    ykphone_thread_panel.open_thread(thread);
    ykphone_thread_panel.on_messages_updated([thread.root_message_id]);
    t.gets[0].success({messages: [raw_message(11), raw_message(12)]});
    assert.equal(t.markdown_updates.length, 1);

    // Unrelated edits do not re-render.
    ykphone_thread_panel.on_messages_updated([99]);
    assert.equal(t.markdown_updates.length, 1);

    // Edited content is read back from the message store.
    message_store.get(11).content = "<p>edited</p>";
    ykphone_thread_panel.on_messages_updated([11]);
    assert.equal(t.markdown_updates.length, 2);
    assert.ok(t.$body.html().includes("<p>edited</p>"));

    root.content = "<p>root edited</p>";
    ykphone_thread_panel.on_messages_updated([root.id]);
    assert.ok(t.$body.html().includes("<p>root edited</p>"));

    // A reply moved to another topic means the thread topic may have
    // been moved; the panel closes rather than posting to a stale name.
    message_store.get(12).topic = "moved away";
    ykphone_thread_panel.on_messages_updated([12]);
    assert.equal(ykphone_thread_panel.is_open(), false);
});

run_test("root above the full view", (helpers) => {
    const t = setup(helpers);

    // Not a thread narrow: nothing shown.
    ykphone_thread_panel.update_full_view_root();
    assert.equal(t.$root.html(), "");
    helpers.override(narrow_state, "filter", () => undefined);
    ykphone_thread_panel.update_full_view_root();
    assert.equal(t.$root.html(), "");
    helpers.override(narrow_state, "filter", () => t.conversation_filter);
    helpers.override(narrow_state, "stream_id", () => verona_id);
    ykphone_thread_panel.update_full_view_root();
    assert.equal(t.$root.html(), "");
    helpers.override(narrow_state, "topic", () => topic_name);
    ykphone_thread_panel.update_full_view_root();
    assert.equal(t.$root.html(), "");

    helpers.override(ykphone_threads, "get_thread_for_topic", (stream_id, topic) =>
        stream_id === verona_id && topic === topic_name ? thread : undefined,
    );
    // A search within the topic is not the thread's own view.
    helpers.override(narrow_state, "filter", () => ({is_conversation_view: () => false}));
    ykphone_thread_panel.update_full_view_root();
    assert.equal(t.$root.html(), "");
    assert.equal(t.gets.length, 0);
    helpers.override(narrow_state, "filter", () => t.conversation_filter);

    // The root is fetched when it is not in the store, once.
    ykphone_thread_panel.update_full_view_root();
    ykphone_thread_panel.update_full_view_root();
    assert.equal(t.gets.length, 1);
    assert.equal(t.gets[0].url, "/json/messages/10");
    t.gets[0].error({});
    ykphone_thread_panel.update_full_view_root();
    assert.equal(t.gets.length, 2);
    // The reader has scrolled down; inserting the block above shifts
    // the feed by the block's height so their rows stay put.
    t.set_scroll_top(500);
    t.gets[1].success({message: raw_message(10, {subject: ""})});
    assert.ok(t.$root.html().includes("translated: Thread started from this message"));
    assert.ok(t.$root.html().includes("<p>message 10</p>"));
    assert.equal(t.markdown_updates.length, 1);
    assert.equal(t.get_scroll_top(), 580);

    // Edits and deletions of other messages leave the block alone.
    ykphone_thread_panel.on_messages_updated([11]);
    ykphone_thread_panel.on_messages_removed([11]);
    assert.equal(t.markdown_updates.length, 1);
    // An edit of the root re-renders it; the height is unchanged, so
    // the feed is not moved.
    message_store.get(10).content = "<p>root edited</p>";
    ykphone_thread_panel.on_messages_updated([10]);
    assert.ok(t.$root.html().includes("<p>root edited</p>"));
    assert.equal(t.markdown_updates.length, 2);
    assert.equal(t.get_scroll_top(), 580);
    // A delete event naming the root re-checks it too (the thread cache
    // still knows it here, so it is rendered again).
    ykphone_thread_panel.on_messages_removed([10]);
    assert.equal(t.markdown_updates.length, 3);

    // Leaving the narrow clears the block; a fetch that finishes
    // after leaving is dropped.
    message_store.clear_for_testing();
    ykphone_thread_panel.update_full_view_root();
    assert.equal(t.gets.length, 3);
    helpers.override(narrow_state, "topic", () => undefined);
    ykphone_thread_panel.update_full_view_root();
    assert.equal(t.$root.html(), "");
    // Removing the block shifts the feed back up; at the top of the
    // feed nothing is adjusted.
    assert.equal(t.get_scroll_top(), 500);
    t.gets[2].success({message: raw_message(10, {subject: ""})});
    t.gets[2].error({});
    assert.equal(t.$root.html(), "");
    t.set_scroll_top(0);
    helpers.override(narrow_state, "topic", () => topic_name);
    ykphone_thread_panel.update_full_view_root();
    assert.equal(t.gets.length, 4);
    t.gets[3].success({message: raw_message(10, {subject: ""})});
    assert.ok(t.$root.html().includes("<p>message 10</p>"));
    assert.equal(t.get_scroll_top(), 0);
});
