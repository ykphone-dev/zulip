"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const channel = mock_esm("../src/channel");
const paused = new Set();
mock_esm("../src/ykphone_notification_pause", {
    is_user_paused: (user_id) => paused.has(user_id),
    time_phrase: (stamp) => `at ${new Date(stamp).toISOString()}`,
});

const expiry = zrequire("ykphone_status_expiry");

// A Wednesday.
const NOW = new Date("2026-09-16T10:15:30Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function load_with(data) {
    let request;
    channel.get = (opts) => {
        request = opts;
    };
    expiry.load();
    assert.equal(request.url, "/json/ykphone/status_expiry");
    if (data !== undefined) {
        request.success(data);
    }
    return request;
}

run_test("clear_at_for", () => {
    assert.equal(expiry.clear_at_for("never", NOW), undefined);
    assert.equal(expiry.clear_at_for("custom", NOW), undefined);
    assert.equal(expiry.clear_at_for("30m", NOW), NOW_SECONDS + 30 * 60);
    assert.equal(expiry.clear_at_for("1h", NOW), NOW_SECONDS + 60 * 60);
    assert.equal(expiry.clear_at_for("4h", NOW), NOW_SECONDS + 4 * 60 * 60);
    const at = (iso) => Math.floor(new Date(iso).getTime() / 1000);
    assert.equal(expiry.clear_at_for("today", NOW), at("2026-09-16T23:59:59Z"));
    // The week ends on Sunday.
    assert.equal(expiry.clear_at_for("week", NOW), at("2026-09-20T23:59:59Z"));
    // On a Sunday, the week ends today.
    const sunday = new Date("2026-09-20T08:00:00Z");
    assert.equal(expiry.clear_at_for("week", sunday), at("2026-09-20T23:59:59Z"));
    // Never less than a minute away.
    const last_second = new Date("2026-09-16T23:59:59.500Z");
    assert.equal(
        expiry.clear_at_for("today", last_second),
        Math.floor(last_second.getTime() / 1000) + 60,
    );
    assert.equal(
        expiry.clear_at_for("week", new Date("2026-09-20T23:59:59.500Z")),
        at("2026-09-20T23:59:59Z") + 60,
    );
});

run_test("is_clear_after and default_clear_after", () => {
    assert.ok(expiry.is_clear_after("week"));
    assert.ok(!expiry.is_clear_after("month"));
    assert.equal(expiry.default_clear_after("translated: In a meeting"), "1h");
    assert.equal(expiry.default_clear_after("translated: Commuting"), "30m");
    assert.equal(expiry.default_clear_after("translated: Out sick"), "today");
    assert.equal(expiry.default_clear_after("translated: Vacationing"), "week");
    assert.equal(expiry.default_clear_after("translated: Working remotely"), "today");
    assert.equal(expiry.default_clear_after("translated: Busy"), undefined);
    assert.equal(expiry.default_clear_after("Lunch"), undefined);
});

run_test("load, events and labels", () => {
    expiry.clear_for_testing();
    let changes = 0;
    expiry.on_change(() => {
        changes += 1;
    });
    // Before any fetch: dropped.
    expiry.handle_event({type: "ykphone_status_expiry", user_id: 5, clear_at: NOW_SECONDS + 60});
    assert.equal(expiry.get_clear_at(5), undefined);

    const request = load_with();
    expiry.handle_event({type: "ykphone_status_expiry", user_id: 5, clear_at: NOW_SECONDS + 60});
    expiry.handle_event({type: "ykphone_status_expiry", user_id: 6, clear_at: null});
    request.success({expiries: {6: NOW_SECONDS + 600, 7: NOW_SECONDS - 5}});
    assert.equal(changes, 1);
    assert.equal(expiry.get_clear_at(5), NOW_SECONDS + 60);
    assert.equal(expiry.get_clear_at(6), undefined);

    assert.equal(expiry.until_label(5, NOW), "translated: Until at 2026-09-16T10:16:30.000Z");
    // Past its time (the cron job clears it within a minute): no label.
    assert.equal(expiry.until_label(7, NOW), undefined);
    assert.equal(expiry.until_label(8, NOW), undefined);

    expiry.handle_event({type: "ykphone_status_expiry", user_id: 5, clear_at: null});
    assert.equal(expiry.get_clear_at(5), undefined);
    assert.equal(changes, 2);

    paused.add(9);
    expiry.handle_event({type: "ykphone_status_expiry", user_id: 9, clear_at: NOW_SECONDS + 60});
    assert.deepEqual(expiry.card_availability(9, NOW), {
        notifications_paused: true,
        status_until: "translated: Until at 2026-09-16T10:16:30.000Z",
    });
    assert.deepEqual(expiry.card_availability(10, NOW), {
        notifications_paused: false,
        status_until: undefined,
    });

    // A second fetch answering after the first finds nothing queued.
    const first = load_with();
    const second = load_with();
    first.success({expiries: {}});
    second.success({expiries: {5: NOW_SECONDS + 60}});
    assert.equal(expiry.get_clear_at(5), NOW_SECONDS + 60);

    // A failed fetch drops what was queued.
    expiry.clear_for_testing();
    const failed = load_with();
    expiry.handle_event({type: "ykphone_status_expiry", user_id: 5, clear_at: NOW_SECONDS + 60});
    failed.error();
    assert.equal(expiry.get_clear_at(5), undefined);
});

run_test("save", () => {
    const requests = [];
    channel.put = (opts) => {
        requests.push(opts);
    };
    let errors = 0;
    expiry.save(1234, () => {
        errors += 1;
    });
    expiry.save(null, () => {
        errors += 1;
    });
    assert.deepEqual(
        requests.map(({url, data}) => [url, data]),
        [
            ["/json/ykphone/status_expiry", {clear_at: "1234"}],
            ["/json/ykphone/status_expiry", {clear_at: "null"}],
        ],
    );
    requests[0].error();
    assert.equal(errors, 1);
});
