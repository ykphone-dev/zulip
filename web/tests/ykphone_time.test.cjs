"use strict";

const assert = require("node:assert/strict");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const {initialize_user_settings} = zrequire("user_settings");

const user_settings = {default_language: "en-US", twenty_four_hour_time: false};
initialize_user_settings({user_settings});

const timerender = zrequire("timerender");
const ykphone_time = zrequire("ykphone_time");

run_test("hour_and_minute", () => {
    timerender.set_display_time_zone("UTC");
    ykphone_time.clear_for_testing();

    const morning = new Date("2026-03-04T10:12:00.000Z");
    const afternoon = new Date("2026-03-04T15:05:00.000Z");

    // Slack's gutter clock: no meridiem and no leading zero on the
    // hour. A timestamp in milliseconds works like a Date, and the
    // second call goes through the cached formatter.
    assert.equal(ykphone_time.hour_and_minute(morning), "10:12");
    assert.equal(ykphone_time.hour_and_minute(morning.getTime()), "10:12");
    assert.equal(ykphone_time.hour_and_minute(afternoon), "3:05");

    // A user on a 24-hour clock still sees their own hour.
    user_settings.twenty_four_hour_time = true;
    assert.equal(ykphone_time.hour_and_minute(afternoon), "15:05");

    // Korean writes the meridiem before the hour rather than after the
    // minute; it is dropped either way.
    user_settings.default_language = "ko";
    user_settings.twenty_four_hour_time = false;
    assert.equal(ykphone_time.hour_and_minute(afternoon), "3:05");

    // The time zone is the one the app displays in.
    timerender.set_display_time_zone("Asia/Seoul");
    ykphone_time.clear_for_testing();
    assert.equal(ykphone_time.hour_and_minute(morning), "7:12");
});
