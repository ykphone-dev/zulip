"use strict";

const assert = require("node:assert/strict");

const {make_realm} = require("./lib/example_realm.cjs");
const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

mock_esm("../src/timerender", {
    get_localized_date_or_time_for_format(stamp, format) {
        const date = new Date(stamp);
        return format === "time"
            ? `${date.getHours()}:00`
            : `${date.getMonth() + 1}/${date.getDate()}`;
    },
});

const {set_realm} = zrequire("state_data");
const ykphone_schedule_presets = zrequire("ykphone_schedule_presets");

set_realm(make_realm({max_reminder_note_length: 1000}));

// Local times, so the expectations hold in any time zone. 2026-09-18 is
// a Friday.
const friday_afternoon = new Date(2026, 8, 18, 14, 30);
const sunday = new Date(2026, 8, 20, 10, 0);
const monday = new Date(2026, 8, 21, 8, 0);

function labels(group) {
    return Object.entries(group).map(([id, preset]) => [id, preset.text, preset.stamp]);
}

run_test("reminder presets", () => {
    const context = ykphone_schedule_presets.popover_context(friday_afternoon, true);
    const now = friday_afternoon.getTime();
    assert.deepEqual(labels(context.possible_send_later_today), [
        ["in_twenty_minutes", "translated: In 20 minutes", now + 20 * 60 * 1000],
        ["in_one_hour", "translated: In 1 hour", now + 60 * 60 * 1000],
        ["in_three_hours", "translated: In 3 hours", now + 3 * 60 * 60 * 1000],
    ]);
    assert.deepEqual(labels(context.send_later_tomorrow), [
        ["tomorrow_nine_am", "translated: Tomorrow at 9:00", new Date(2026, 8, 19, 9).getTime()],
    ]);
    assert.deepEqual(labels(context.possible_send_later_monday), [
        ["monday_nine_am", "translated: Monday (9/21) at 9:00", new Date(2026, 8, 21, 9).getTime()],
    ]);
    assert.equal(context.max_reminder_note_length, 1000);
});

run_test("message presets", () => {
    const context = ykphone_schedule_presets.popover_context(friday_afternoon, false);
    // A message is scheduled for tomorrow or Monday morning only.
    assert.equal(context.possible_send_later_today, false);
    assert.deepEqual(Object.keys(context.send_later_tomorrow), ["tomorrow_nine_am"]);
    assert.deepEqual(Object.keys(context.possible_send_later_monday), ["monday_nine_am"]);

    // On a Sunday the next Monday is tomorrow, offered once.
    assert.equal(
        ykphone_schedule_presets.popover_context(sunday, false).possible_send_later_monday,
        false,
    );
    // On a Monday it is a week ahead, and says so.
    assert.deepEqual(
        labels(ykphone_schedule_presets.popover_context(monday, false).possible_send_later_monday),
        [
            [
                "monday_nine_am",
                "translated: Next Monday (9/28) at 9:00",
                new Date(2026, 8, 28, 9).getTime(),
            ],
        ],
    );
});

run_test("relative_send_at_seconds", () => {
    // Counted from the click, in whole seconds.
    const later = new Date(2026, 8, 18, 23, 59, 30, 750);
    assert.equal(
        ykphone_schedule_presets.relative_send_at_seconds("in_twenty_minutes", later),
        new Date(2026, 8, 19, 0, 19, 30).getTime() / 1000,
    );
    // Tomorrow and Monday keep the time the menu showed: a menu drawn
    // on Friday says Saturday 9:00, and a click after midnight still
    // sends at the rendered stamp rather than working "tomorrow" out
    // again (which would be Sunday).
    const menu = ykphone_schedule_presets.popover_context(later, false);
    assert.equal(
        ykphone_schedule_presets.relative_send_at_seconds(
            "tomorrow_nine_am",
            new Date(2026, 8, 19, 0, 1),
        ),
        undefined,
    );
    assert.equal(
        menu.send_later_tomorrow.tomorrow_nine_am.stamp,
        new Date(2026, 8, 19, 9).getTime(),
    );
    assert.equal(
        ykphone_schedule_presets.relative_send_at_seconds("monday_nine_am", later),
        undefined,
    );
    assert.equal(
        ykphone_schedule_presets.relative_send_at_seconds("today_four_pm", later),
        undefined,
    );
});

run_test("day_changed_since_render", () => {
    ykphone_schedule_presets.popover_context(new Date(2026, 8, 18, 23, 58), true);
    assert.ok(!ykphone_schedule_presets.day_changed_since_render(new Date(2026, 8, 18, 23, 59)));
    // Past midnight the menu has to be drawn again.
    assert.ok(ykphone_schedule_presets.day_changed_since_render(new Date(2026, 8, 19, 0, 0)));
    ykphone_schedule_presets.popover_context(new Date(2026, 8, 19, 0, 0), true);
    assert.ok(!ykphone_schedule_presets.day_changed_since_render(new Date(2026, 8, 19, 0, 1)));
});
