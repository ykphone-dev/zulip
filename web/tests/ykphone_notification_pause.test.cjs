"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const channel = mock_esm("../src/channel");
mock_esm("../src/people", {is_my_user_id: (user_id) => user_id === 1});
mock_esm("../src/timerender", {
    get_localized_date_or_time_for_format: (date, format) =>
        `${format}:${new Date(date).toISOString()}`,
});
const user_settings = {timezone: "UTC"};
mock_esm("../src/user_settings", {user_settings});

const pause = zrequire("ykphone_notification_pause");

const WEEKDAYS_9_TO_18 = {enabled: true, days: [0, 1, 2, 3, 4], start: "09:00", end: "18:00"};
// 2026-09-14 is a Monday.
const MONDAY_NOON = new Date("2026-09-14T12:00:00Z");

function seconds(date) {
    return Math.floor(date.getTime() / 1000);
}

function load_with(data) {
    let request;
    channel.get = (opts) => {
        request = opts;
    };
    pause.load();
    assert.equal(request.url, "/json/ykphone/notification_pause");
    if (data !== undefined) {
        request.success(data);
    }
    return request;
}

function reset() {
    pause.clear_for_testing();
    user_settings.timezone = "UTC";
}

run_test("schedule_allows", () => {
    const allows = (schedule, weekday, hour, minute = 0) =>
        pause.schedule_allows(schedule, weekday, hour * 60 + minute);
    assert.ok(allows(WEEKDAYS_9_TO_18, 0, 9));
    assert.ok(allows(WEEKDAYS_9_TO_18, 4, 17, 59));
    assert.ok(!allows(WEEKDAYS_9_TO_18, 0, 8, 59));
    assert.ok(!allows(WEEKDAYS_9_TO_18, 0, 18));
    assert.ok(!allows(WEEKDAYS_9_TO_18, 5, 12));

    // Overnight: Monday night into Tuesday morning.
    const nights = {enabled: true, days: [0], start: "22:00", end: "06:00"};
    assert.ok(allows(nights, 0, 22));
    assert.ok(allows(nights, 1, 5, 59));
    assert.ok(!allows(nights, 1, 6));
    assert.ok(!allows(nights, 0, 3));
    assert.ok(!allows(nights, 1, 22));
    // Sunday night runs into Monday.
    assert.ok(allows({...nights, days: [6]}, 0, 1));

    // Start == end: a whole day from the start.
    const whole_day = {enabled: true, days: [2], start: "00:00", end: "00:00"};
    assert.ok(allows(whole_day, 2, 0));
    assert.ok(allows(whole_day, 2, 23, 59));
    assert.ok(!allows(whole_day, 3, 0));

    // No days: nothing is allowed.
    assert.ok(!allows({...WEEKDAYS_9_TO_18, days: []}, 0, 12));
});

run_test("wall_clock", () => {
    assert.deepEqual(pause.wall_clock(MONDAY_NOON, "UTC"), {weekday: 0, minute: 12 * 60});
    // 12:00 UTC is 21:00 in Seoul.
    assert.deepEqual(pause.wall_clock(MONDAY_NOON, "Asia/Seoul"), {weekday: 0, minute: 21 * 60});
    // Sunday 20:00 UTC is Monday 05:00 in Seoul.
    assert.deepEqual(pause.wall_clock(new Date("2026-09-13T20:00:00Z"), "Asia/Seoul"), {
        weekday: 0,
        minute: 5 * 60,
    });
    // Unset or unknown zones have no wall clock, as on the server.
    assert.equal(pause.wall_clock(MONDAY_NOON, ""), undefined);
    assert.equal(pause.wall_clock(MONDAY_NOON, "Mars/Olympus"), undefined);
    // Daylight saving time: 13:00 UTC is 09:00 EDT on 2026-03-08, a Sunday.
    assert.deepEqual(pause.wall_clock(new Date("2026-03-08T13:00:00Z"), "America/New_York"), {
        weekday: 6,
        minute: 9 * 60,
    });
});

run_test("is_paused_at", () => {
    const off = {...WEEKDAYS_9_TO_18, enabled: false};
    assert.ok(!pause.is_paused_at({until: null, schedule: off}, MONDAY_NOON, "UTC"));
    const until = seconds(MONDAY_NOON) + 60;
    assert.ok(pause.is_paused_at({until, schedule: off}, MONDAY_NOON, "UTC"));
    assert.ok(
        !pause.is_paused_at({until: seconds(MONDAY_NOON), schedule: off}, MONDAY_NOON, "UTC"),
    );
    // Inside the hours in UTC, outside them in Seoul (21:00).
    assert.ok(!pause.is_paused_at({until: null, schedule: WEEKDAYS_9_TO_18}, MONDAY_NOON, "UTC"));
    assert.ok(
        pause.is_paused_at({until: null, schedule: WEEKDAYS_9_TO_18}, MONDAY_NOON, "Asia/Seoul"),
    );
    // Without a zone the schedule is not applied; a timed pause still is.
    assert.ok(!pause.is_paused_at({until: null, schedule: WEEKDAYS_9_TO_18}, MONDAY_NOON, ""));
    assert.ok(pause.is_paused_at({until, schedule: WEEKDAYS_9_TO_18}, MONDAY_NOON, ""));
});

run_test("load, own state and labels", () => {
    reset();
    assert.ok(!pause.is_loaded());
    assert.equal(pause.get_until(), null);
    assert.deepEqual(pause.get_schedule(), pause.DEFAULT_SCHEDULE);
    let changes = 0;
    pause.on_change(() => {
        changes += 1;
    });

    const until = seconds(MONDAY_NOON) + 30 * 60;
    load_with({until, schedule: WEEKDAYS_9_TO_18, mobile: null, paused_user_ids: [5, 6]});
    assert.ok(pause.is_loaded());
    assert.equal(changes, 1);
    assert.equal(pause.get_until(), until);
    assert.ok(pause.is_paused(MONDAY_NOON));
    assert.ok(pause.is_user_paused(1, MONDAY_NOON));
    assert.ok(pause.is_user_paused(5, MONDAY_NOON));
    assert.ok(!pause.is_user_paused(7, MONDAY_NOON));
    assert.equal(
        pause.own_status_label(MONDAY_NOON),
        "translated: Paused until time:2026-09-14T12:30:00.000Z",
    );
    assert.ok(pause.holds_back_notifications({type: "stream"}, MONDAY_NOON));
    assert.ok(!pause.holds_back_notifications({type: "test-notification"}, MONDAY_NOON));

    // After the pause, 20:00 is outside the schedule's hours.
    const evening = new Date("2026-09-14T20:00:00Z");
    assert.equal(
        pause.own_status_label(evening),
        "translated: Paused by your notification schedule",
    );
    // Inside the hours, after the pause: not paused.
    const afternoon = new Date("2026-09-14T15:00:00Z");
    assert.equal(pause.own_status_label(afternoon), undefined);
    assert.ok(!pause.is_user_paused(1, afternoon));
});

run_test("time_phrase", () => {
    const now = MONDAY_NOON;
    assert.equal(
        pause.time_phrase(now.getTime() + 60 * 60 * 1000, now),
        "time:2026-09-14T13:00:00.000Z",
    );
    assert.equal(
        pause.time_phrase(new Date("2026-09-15T09:00:00Z").getTime(), now),
        "translated: Tomorrow at time:2026-09-15T09:00:00.000Z",
    );
    assert.equal(
        pause.time_phrase(new Date("2026-09-20T09:00:00Z").getTime(), now),
        "dayofyear_time:2026-09-20T09:00:00.000Z",
    );
    assert.equal(
        pause.time_phrase(new Date("2027-01-02T09:00:00Z").getTime(), now),
        "dayofyear_year_time:2027-01-02T09:00:00.000Z",
    );
});

run_test("pause_presets and weekday_labels", () => {
    const presets = pause.pause_presets(MONDAY_NOON);
    assert.deepEqual(
        presets.map(({id, until}) => [id, until - seconds(MONDAY_NOON)]),
        [
            ["30m", 30 * 60],
            ["1h", 60 * 60],
            ["2h", 2 * 60 * 60],
            ["tomorrow", 21 * 60 * 60],
        ],
    );
    assert.equal(presets[3].text, "translated: Until tomorrow");
    const labels = pause.weekday_labels();
    assert.equal(labels.length, 7);
    assert.deepEqual(labels[0], {day: 0, label: "translated: Mon"});
    assert.deepEqual(labels[6], {day: 6, label: "translated: Sun"});
    assert.ok(pause.is_valid_time("09:00"));
    assert.ok(pause.is_valid_time("23:59"));
    assert.ok(!pause.is_valid_time("24:00"));
    assert.ok(!pause.is_valid_time("9:00"));
    assert.ok(!pause.is_valid_time(""));
});

run_test("events before, during and after the first load", () => {
    reset();
    let changes = 0;
    pause.on_change(() => {
        changes += 1;
    });
    const until = seconds(MONDAY_NOON) + 600;
    // Before any fetch: dropped (the fetch will say it).
    pause.handle_pause_event({
        type: "ykphone_notification_pause",
        until,
        schedule: WEEKDAYS_9_TO_18,
        mobile: true,
    });
    pause.handle_paused_users_event({type: "ykphone_paused_users", user_id: 5, paused: true});
    assert.equal(pause.get_until(), null);
    assert.equal(changes, 0);

    // While the fetch is on the way: applied after it.
    const request = load_with();
    pause.handle_paused_users_event({type: "ykphone_paused_users", user_id: 5, paused: true});
    pause.handle_paused_users_event({type: "ykphone_paused_users", user_id: 6, paused: false});
    pause.handle_pause_event({
        type: "ykphone_notification_pause",
        until,
        schedule: WEEKDAYS_9_TO_18,
        mobile: true,
    });
    request.success({
        until: null,
        schedule: pause.DEFAULT_SCHEDULE,
        mobile: null,
        paused_user_ids: [6],
    });
    assert.equal(changes, 1);
    assert.equal(pause.get_until(), until);
    assert.ok(pause.is_user_paused(5, MONDAY_NOON));
    assert.ok(!pause.is_user_paused(6, MONDAY_NOON));

    // After it: applied at once.
    pause.handle_paused_users_event({type: "ykphone_paused_users", user_id: 5, paused: false});
    assert.ok(!pause.is_user_paused(5, MONDAY_NOON));
    assert.equal(changes, 2);

    // A second fetch answering after the first finds nothing queued.
    const first = load_with();
    const second = load_with();
    first.success({
        until: null,
        schedule: pause.DEFAULT_SCHEDULE,
        mobile: null,
        paused_user_ids: [],
    });
    second.success({
        until: null,
        schedule: pause.DEFAULT_SCHEDULE,
        mobile: null,
        paused_user_ids: [5],
    });
    assert.ok(pause.is_user_paused(5, MONDAY_NOON));

    // A failed fetch drops what was queued.
    reset();
    const failed = load_with();
    pause.handle_pause_event({
        type: "ykphone_notification_pause",
        until,
        schedule: WEEKDAYS_9_TO_18,
        mobile: true,
    });
    failed.error();
    pause.handle_pause_event({
        type: "ykphone_notification_pause",
        until,
        schedule: WEEKDAYS_9_TO_18,
        mobile: true,
    });
    assert.equal(pause.get_until(), null);
    assert.ok(!pause.is_loaded());
});

run_test("requests", () => {
    reset();
    let changes = 0;
    pause.on_change(() => {
        changes += 1;
    });
    const requests = [];
    channel.patch = (opts) => {
        requests.push(opts);
    };
    let errors = 0;
    const on_error = () => {
        errors += 1;
    };
    pause.pause_until(1234, on_error);
    pause.resume(on_error);
    pause.set_schedule(WEEKDAYS_9_TO_18, on_error);
    pause.set_mobile_preference(true, on_error);
    assert.deepEqual(
        requests.map(({url, data}) => [url, data]),
        [
            ["/json/ykphone/notification_pause", {until: "1234"}],
            ["/json/ykphone/notification_pause", {clear_until: "true"}],
            ["/json/ykphone/notification_pause", {schedule: JSON.stringify(WEEKDAYS_9_TO_18)}],
            ["/json/ykphone/notification_pause", {mobile: "true"}],
        ],
    );
    requests[0].success({until: 1234, schedule: WEEKDAYS_9_TO_18, mobile: false});
    assert.equal(pause.get_mobile_preference(), false);
    assert.equal(pause.get_until(), 1234);
    assert.deepEqual(pause.get_schedule(), WEEKDAYS_9_TO_18);
    assert.equal(changes, 1);
    requests[1].error();
    assert.equal(errors, 1);
});

run_test("loading, DM rows, zone labels and schedule errors", () => {
    reset();
    // While the first fetch is on the way, nothing sounds.
    const request = load_with();
    assert.ok(pause.is_loading());
    assert.ok(pause.holds_back_notifications({type: "stream"}, MONDAY_NOON));
    request.success({
        until: null,
        schedule: pause.DEFAULT_SCHEDULE,
        mobile: true,
        paused_user_ids: [5],
    });
    assert.ok(!pause.is_loading());
    assert.ok(!pause.holds_back_notifications({type: "stream"}, MONDAY_NOON));
    assert.equal(pause.get_mobile_preference(), true);
    // A failed fetch ends the wait.
    reset();
    load_with().error();
    assert.ok(!pause.holds_back_notifications({type: "stream"}, MONDAY_NOON));

    reset();
    load_with({
        until: seconds(MONDAY_NOON) + 60,
        schedule: pause.DEFAULT_SCHEDULE,
        mobile: null,
        paused_user_ids: [5],
    });
    assert.ok(pause.dm_row_paused("5", MONDAY_NOON));
    assert.ok(!pause.dm_row_paused("6", MONDAY_NOON));
    assert.ok(!pause.dm_row_paused("5,6", MONDAY_NOON));
    // One's own conversation carries no badge (the rail does).
    assert.ok(pause.is_user_paused(1, MONDAY_NOON));
    assert.ok(!pause.dm_row_paused("1", MONDAY_NOON));

    assert.equal(pause.zone_label("Asia/Seoul", "ko", MONDAY_NOON), "한국 표준시");
    assert.equal(pause.zone_label("Mars/Olympus", "ko", MONDAY_NOON), "Mars/Olympus");

    assert.equal(
        pause.schedule_error({...WEEKDAYS_9_TO_18, days: []}),
        "translated: Choose at least one day.",
    );
    assert.equal(pause.schedule_error({...WEEKDAYS_9_TO_18, enabled: false, days: []}), undefined);
    assert.equal(pause.schedule_error(WEEKDAYS_9_TO_18), undefined);
});
