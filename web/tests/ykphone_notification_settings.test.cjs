"use strict";

const assert = require("node:assert/strict");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const settings = zrequire("ykphone_notification_settings");

const ALL_OFF = Object.fromEntries(settings.NOTIFICATION_FLAG_NAMES.map((name) => [name, false]));

run_test("notify levels", () => {
    assert.deepEqual(
        settings.notify_level_options().map(({value}) => value),
        ["all", "mentions", "nothing"],
    );
    assert.ok(settings.is_notify_level("mentions"));
    assert.ok(!settings.is_notify_level("some"));
});

run_test("flags_for", () => {
    assert.deepEqual(settings.flags_for({level: "all", threads: true, mobile: true}), {
        enable_stream_desktop_notifications: true,
        enable_stream_audible_notifications: true,
        enable_stream_push_notifications: true,
        enable_desktop_notifications: true,
        enable_sounds: true,
        enable_offline_push_notifications: true,
        enable_followed_topic_desktop_notifications: true,
        enable_followed_topic_audible_notifications: true,
        enable_followed_topic_push_notifications: true,
        enable_followed_topic_email_notifications: true,
    });
    assert.deepEqual(settings.flags_for({level: "mentions", threads: false, mobile: true}), {
        ...ALL_OFF,
        enable_desktop_notifications: true,
        enable_sounds: true,
        enable_offline_push_notifications: true,
    });
    // Without mobile, no mobile column is on.
    assert.deepEqual(settings.flags_for({level: "all", threads: true, mobile: false}), {
        ...ALL_OFF,
        enable_stream_desktop_notifications: true,
        enable_stream_audible_notifications: true,
        enable_desktop_notifications: true,
        enable_sounds: true,
        enable_followed_topic_desktop_notifications: true,
        enable_followed_topic_audible_notifications: true,
        enable_followed_topic_email_notifications: true,
    });
    assert.deepEqual(settings.flags_for({level: "nothing", threads: false, mobile: true}), ALL_OFF);
    // Under Nothing, thread replies still notify on the desktop (their
    // own toggle) but send no email.
    assert.deepEqual(settings.flags_for({level: "nothing", threads: true, mobile: false}), {
        ...ALL_OFF,
        enable_followed_topic_desktop_notifications: true,
        enable_followed_topic_audible_notifications: true,
    });
});

run_test("simple_choices reads the matrix back", () => {
    for (const choices of [
        {level: "all", threads: true, mobile: true},
        {level: "mentions", threads: false, mobile: true},
        {level: "nothing", threads: true, mobile: true},
        {level: "all", threads: false, mobile: false},
    ]) {
        assert.deepEqual(settings.simple_choices(settings.flags_for(choices), null), choices);
    }
    // Zulip's defaults: DMs and mentions, followed topics, mobile.
    assert.deepEqual(
        settings.simple_choices(
            {
                ...ALL_OFF,
                enable_desktop_notifications: true,
                enable_sounds: true,
                enable_offline_push_notifications: true,
                enable_followed_topic_desktop_notifications: true,
                enable_followed_topic_push_notifications: true,
            },
            null,
        ),
        {level: "mentions", threads: true, mobile: true},
    );
    // The stored mobile choice wins over the push columns, which cannot
    // hold it under Nothing.
    assert.deepEqual(settings.simple_choices(ALL_OFF, true), {
        level: "nothing",
        threads: false,
        mobile: true,
    });
    assert.deepEqual(
        settings.simple_choices(
            settings.flags_for({level: "all", threads: true, mobile: true}),
            false,
        ).mobile,
        false,
    );
    // Only a mobile column on still reads as mobile.
    assert.deepEqual(
        settings.simple_choices({...ALL_OFF, enable_stream_push_notifications: true}, null),
        {level: "nothing", threads: false, mobile: true},
    );
});

run_test("changed_flags", () => {
    const current = settings.flags_for({level: "mentions", threads: true, mobile: true});
    assert.deepEqual(
        settings.changed_flags(current, {level: "mentions", threads: true, mobile: true}),
        {},
    );
    assert.deepEqual(settings.changed_flags(current, {level: "all", threads: true, mobile: true}), {
        enable_stream_desktop_notifications: true,
        enable_stream_audible_notifications: true,
        enable_stream_push_notifications: true,
    });
    assert.deepEqual(
        settings.changed_flags(current, {level: "mentions", threads: true, mobile: false}),
        {
            enable_offline_push_notifications: false,
            enable_followed_topic_push_notifications: false,
        },
    );
});

run_test("sounds", () => {
    assert.equal(settings.sound_label("zulip"), "translated: Default sound");
    assert.equal(settings.sound_label("deep tom"), "translated: Deep tom");
    assert.equal(settings.sound_label("new_sound"), "new_sound");
    // Not a key the list happens to inherit.
    assert.equal(settings.sound_label("toString"), "toString");
    assert.deepEqual(settings.sound_options(["ding", "zulip"], "zulip"), [
        {value: "none", text: "translated: None", selected: false},
        {value: "ding", text: "translated: Ding", selected: false},
        {value: "zulip", text: "translated: Default sound", selected: true},
    ]);
});

run_test("email_delay_options", () => {
    const values = [
        {value: 120, description: "2 minutes"},
        {value: 300, description: "5 minutes"},
        {value: "custom_period", description: "Custom"},
    ];
    assert.deepEqual(settings.email_delay_options(values, 300), [
        {value: 120, text: "2 minutes", selected: false},
        {value: 300, text: "5 minutes", selected: true},
    ]);
    // A custom delay set in the advanced settings is listed.
    assert.deepEqual(settings.email_delay_options(values, 7 * 60), [
        {value: 120, text: "2 minutes", selected: false},
        {value: 300, text: "5 minutes", selected: false},
        {value: 420, text: "translated: 7 minutes", selected: true},
    ]);
});
