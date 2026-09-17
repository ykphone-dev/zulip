"use strict";

const assert = require("node:assert/strict");

const {make_stream} = require("./lib/example_stream.cjs");
const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const {Filter} = zrequire("filter");
const stream_data = zrequire("stream_data");
const ykphone_flags = zrequire("ykphone_flags");
const ykphone_narrow_title = zrequire("ykphone_narrow_title");

const devel = make_stream({stream_id: 11, name: "devel"});
stream_data.add_sub_for_tests(devel);

function title(terms) {
    return ykphone_narrow_title.channel_title(new Filter(terms));
}

run_test("channel_title", () => {
    const general_chat = [
        {operator: "channel", operand: "11"},
        {operator: "topic", operand: ""},
    ];
    const thread = [
        {operator: "channel", operand: "11"},
        {operator: "topic", operand: "Plans"},
    ];

    // Upstream's titles without the fork's flag.
    ykphone_flags.set_channels_open_in_general_chat(false);
    assert.equal(title(general_chat), undefined);

    ykphone_flags.set_channels_open_in_general_chat(true);
    assert.equal(title(general_chat), "translated: devel (channel)");
    assert.equal(title([{operator: "channel", operand: "11"}]), "translated: devel (channel)");
    assert.equal(title(thread), "translated: Thread · #devel");
    assert.equal(
        title([...thread, {operator: "near", operand: "5"}]),
        "translated: Thread · #devel",
    );

    // Other narrows of the channel are named the same way.
    assert.equal(
        title([
            {operator: "channel", operand: "11"},
            {operator: "is", operand: "starred"},
        ]),
        "translated: devel (channel)",
    );
    // Other narrows and unknown channels keep upstream's title.
    assert.equal(title([{operator: "is", operand: "starred"}]), undefined);
    assert.equal(title([{operator: "channel", operand: "99"}]), undefined);
    ykphone_flags.set_channels_open_in_general_chat(false);
});

run_test("title_suffix", () => {
    ykphone_flags.set_channels_open_in_general_chat(false);
    assert.equal(ykphone_narrow_title.title_suffix(), " - Zulip");
    ykphone_flags.set_channels_open_in_general_chat(true);
    assert.equal(ykphone_narrow_title.title_suffix(), "");
    ykphone_flags.set_channels_open_in_general_chat(false);
});
