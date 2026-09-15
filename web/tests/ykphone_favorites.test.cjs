"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const stream_data = mock_esm("../src/stream_data");
const stream_settings_api = mock_esm("../src/stream_settings_api");

const ykphone_favorites = zrequire("ykphone_favorites");

run_test("pin_value_for_drop", () => {
    const favorites = ykphone_favorites.FAVORITES_SECTION_ID;
    // Into the favourites section: pin, unless already pinned.
    assert.equal(ykphone_favorites.pin_value_for_drop(favorites, false), true);
    assert.equal(ykphone_favorites.pin_value_for_drop(favorites, true), undefined);
    // Onto any other section (channels, a folder): unpin, unless
    // already unpinned.
    assert.equal(ykphone_favorites.pin_value_for_drop("normal-streams", true), false);
    assert.equal(ykphone_favorites.pin_value_for_drop("12", true), false);
    assert.equal(ykphone_favorites.pin_value_for_drop("normal-streams", false), undefined);
});

run_test("handle_drop", ({override}) => {
    const verona = {stream_id: 3, name: "Verona", pin_to_top: false};
    override(stream_data, "get_sub_by_id", (stream_id) =>
        stream_id === verona.stream_id ? verona : undefined,
    );
    const calls = [];
    override(stream_settings_api, "set_stream_property", (sub, data) => {
        calls.push([sub.stream_id, data]);
    });

    // The drop targets light up only where a drop changes something.
    assert.equal(ykphone_favorites.can_drop(3, "pinned-streams"), true);
    assert.equal(ykphone_favorites.can_drop(3, "normal-streams"), false);
    assert.equal(ykphone_favorites.can_drop(3, "12"), false);

    assert.equal(ykphone_favorites.handle_drop(3, "pinned-streams"), true);
    assert.deepEqual(calls, [[3, {property: "pin_to_top", value: true}]]);

    // Dropping where the channel already is changes nothing.
    assert.equal(ykphone_favorites.handle_drop(3, "normal-streams"), false);
    verona.pin_to_top = true;
    assert.equal(ykphone_favorites.can_drop(3, "pinned-streams"), false);
    assert.equal(ykphone_favorites.can_drop(3, "12"), true);
    assert.equal(ykphone_favorites.handle_drop(3, "normal-streams"), true);
    assert.deepEqual(calls[1], [3, {property: "pin_to_top", value: false}]);

    // An unknown channel (unsubscribed meanwhile) is ignored.
    assert.equal(ykphone_favorites.can_drop(9, "pinned-streams"), false);
    assert.equal(ykphone_favorites.handle_drop(9, "pinned-streams"), false);
    assert.equal(calls.length, 2);
});
