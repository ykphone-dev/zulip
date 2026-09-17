"use strict";

const assert = require("node:assert/strict");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const ykphone_flags = zrequire("ykphone_flags");
const ykphone_typeahead_filter = zrequire("ykphone_typeahead_filter");

function broadcast(mention) {
    return {type: "broadcast", user: {special_item_text: mention}};
}

const topic = {type: "topic_list", is_channel_link: false};
const channel_link = {type: "topic_list", is_channel_link: true};
const person = {type: "user", user: {user_id: 7}};

function offered(items) {
    return items.filter((item) => ykphone_typeahead_filter.offers_suggestion(item));
}

run_test("offers_suggestion", () => {
    const wildcards = ["all", "everyone", "stream", "channel", "topic"].map((mention) =>
        broadcast(mention),
    );

    // Upstream's suggestions without the fork's flag.
    ykphone_flags.set_channels_open_in_general_chat(false);
    assert.equal(offered([...wildcards, topic, channel_link, person]).length, 8);
    assert.ok(ykphone_typeahead_filter.offers_topic_links());

    ykphone_flags.set_channels_open_in_general_chat(true);
    assert.deepEqual(
        offered(wildcards).map((item) => item.user.special_item_text),
        ["all", "everyone", "channel"],
    );
    assert.deepEqual(offered([topic, channel_link, person]), [channel_link, person]);
    // Only the wildcards go: a person or a group that happens to be
    // called "topic" or "stream" is still offered.
    const person_named_topic = {type: "user", user: {user_id: 8, full_name: "topic"}};
    const group_named_stream = {type: "user_group", name: "stream"};
    assert.deepEqual(offered([person_named_topic, group_named_stream]), [
        person_named_topic,
        group_named_stream,
    ]);
    assert.ok(!ykphone_typeahead_filter.offers_topic_links());
    ykphone_flags.set_channels_open_in_general_chat(false);
});
