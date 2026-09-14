"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const $ = require("./lib/zjquery.cjs");

const compose_ui = mock_esm("../src/compose_ui");

const ykphone_compose = zrequire("ykphone_compose");

function fake_child(matches) {
    return {
        matches(selector) {
            assert.equal(selector, ".compose-control-buttons-container");
            return matches;
        },
    };
}

run_test("mount", ({mock_template}) => {
    window.localStorage.clear();
    $.clear_all_elements();

    let controls_html;
    mock_template("ykphone_compose_controls.hbs", true, (_data, html) => {
        controls_html = html;
        return html;
    });

    // The bar holds the insert tools directly and the formatting
    // buttons in two nested groups.
    const upload = fake_child(false);
    const group_1 = fake_child(true);
    const group_2 = fake_child(true);
    const emoji = fake_child(false);
    let bar_prepended;
    $.create("#compose .compose-scrollable-buttons", {
        elements: [
            {
                children: [upload, group_1, group_2, emoji],
                prepend(node) {
                    bar_prepended = node;
                },
            },
        ],
    });
    // The new row is created from literal markup; only its append is
    // observed.
    let row_children;
    const $row = $.create(
        '<div id="ykphone-compose-formatting-row" class="ykphone-compose-formatting-row"></div>',
        {
            elements: [
                {
                    append(...nodes) {
                        row_children = nodes;
                    },
                },
            ],
        },
    );
    let messagebox_prepended;
    $.create("#compose .messagebox", {
        elements: [
            {
                prepend(node) {
                    messagebox_prepended = node;
                },
            },
        ],
    });
    const $upload_button = $("#compose .compose_upload_file");
    $upload_button.addClass("zulip-icon-attachment");
    const $send_later_icon = $("#send_later .zulip-icon");
    $send_later_icon.addClass("zulip-icon-more-vertical");
    const $toggle = $("#compose .ykphone-compose-formatting-toggle");

    ykphone_compose.mount();

    // The formatting groups move into a row of their own at the top of
    // the message box; the insert tools stay in the bar.
    assert.deepEqual(row_children, [group_1, group_2]);
    assert.equal(messagebox_prepended, $row[0]);
    // The extra controls go to the front of the bar.
    assert.equal(bar_prepended, $(controls_html)[0]);
    assert.ok(controls_html.includes("ykphone-compose-formatting-toggle"));
    assert.ok(controls_html.includes("zulip-icon-at-sign"));
    // Slack's icons for attach and send options.
    assert.ok($upload_button.hasClass("zulip-icon-plus"));
    assert.ok(!$upload_button.hasClass("zulip-icon-attachment"));
    assert.ok($send_later_icon.hasClass("zulip-icon-chevron-down"));
    assert.ok(!$send_later_icon.hasClass("zulip-icon-more-vertical"));
    // The row starts visible for a fresh profile.
    assert.equal(ykphone_compose.is_formatting_row_hidden(), false);
    assert.ok(!$("#compose").hasClass("ykphone-compose-formatting-hidden"));
    assert.ok($toggle.hasClass("active"));
    assert.equal($toggle.attr("aria-pressed"), "true");
});

run_test("toggle_formatting_row", () => {
    window.localStorage.clear();
    $.clear_all_elements();
    const $compose = $("#compose");
    const $toggle = $("#compose .ykphone-compose-formatting-toggle");

    ykphone_compose.toggle_formatting_row();
    assert.equal(ykphone_compose.is_formatting_row_hidden(), true);
    assert.ok($compose.hasClass("ykphone-compose-formatting-hidden"));
    assert.ok(!$toggle.hasClass("active"));
    assert.equal($toggle.attr("aria-pressed"), "false");

    ykphone_compose.toggle_formatting_row();
    assert.equal(ykphone_compose.is_formatting_row_hidden(), false);
    assert.ok(!$compose.hasClass("ykphone-compose-formatting-hidden"));
    assert.ok($toggle.hasClass("active"));
    assert.equal($toggle.attr("aria-pressed"), "true");
});

run_test("insert_mention", ({override}) => {
    const inserted = [];
    override(compose_ui, "insert_syntax_and_focus", (syntax) => {
        inserted.push(syntax);
    });
    ykphone_compose.insert_mention();
    assert.deepEqual(inserted, ["@"]);
});
