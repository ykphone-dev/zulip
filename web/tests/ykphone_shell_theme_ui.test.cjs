"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const $ = require("./lib/zjquery.cjs");

const channel = mock_esm("../src/channel");
const settings_ui = mock_esm("../src/settings_ui");

const ykphone_shell_theme = zrequire("ykphone_shell_theme");
const ykphone_shell_theme_ui = zrequire("ykphone_shell_theme_ui");

function swatch(id) {
    const $input = $.create(`swatch ${id}`);
    $input.val(id);
    const $subsection = $.create(`subsection for ${id}`);
    const $status = $.create(`status for ${id}`);
    $input.set_closest_results(".subsection-parent", $subsection);
    $subsection.set_find_results(".alert-notification", $status);
    return {$input, $status};
}

run_test("choosing a theme", ({override}) => {
    $.clear_all_elements();
    ykphone_shell_theme_ui.initialize();
    const handler = $("body").get_on_handler("change", "input.ykphone-theme-swatch-input");
    ykphone_shell_theme.apply_shell_theme("ykphone");

    const requests = [];
    let patched;
    override(channel, "patch", (opts) => {
        patched = opts;
    });
    override(settings_ui, "do_settings_change", (method, url, data, $status, opts) => {
        requests.push({url, data, $status, opts});
        // It is handed upstream's PATCH request.
        method({url, data});
    });

    // A click previews the theme at once and saves it.
    const navy = swatch("navy");
    handler.call(navy.$input);
    assert.equal($(":root").attr("data-yk-theme"), "navy");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/json/ykphone/preferences");
    assert.deepEqual(requests[0].data, {shell_theme: "navy"});
    assert.deepEqual(patched, {url: "/json/ykphone/preferences", data: {shell_theme: "navy"}});
    assert.equal(requests[0].$status[0], navy.$status[0]);

    // A failed save goes back to the theme that is still saved.
    requests[0].opts.error_continuation();
    assert.equal($(":root").attr("data-yk-theme"), "ykphone");
    assert.equal($("input.ykphone-theme-swatch-input[value='ykphone']").prop("checked"), true);

    // Unless the user has chosen another theme since.
    const sand = swatch("sand");
    handler.call(navy.$input);
    handler.call(sand.$input);
    assert.equal(requests.length, 3);
    requests[1].opts.error_continuation();
    assert.equal($(":root").attr("data-yk-theme"), "sand");

    // The current theme, or a value that is no theme, sends nothing.
    handler.call(sand.$input);
    handler.call(swatch("pink").$input);
    assert.equal(requests.length, 3);
    assert.equal($(":root").attr("data-yk-theme"), "sand");
});
