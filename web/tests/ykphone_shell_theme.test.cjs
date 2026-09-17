"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const $ = require("./lib/zjquery.cjs");

const ykphone_shell_theme = zrequire("ykphone_shell_theme");

const theme_ids = [
    "ykphone",
    "navy",
    "graphite",
    "forest",
    "burgundy",
    "ocean",
    "sand",
    "midnight",
];

function swatch_input(id) {
    return $(`input.ykphone-theme-swatch-input[value='${id}']`);
}

run_test("registry", () => {
    const themes = ykphone_shell_theme.get_shell_themes();
    assert.deepEqual(
        themes.map((theme) => theme.id),
        theme_ids,
    );
    assert.equal(themes[0].id, ykphone_shell_theme.DEFAULT_SHELL_THEME);
    assert.deepEqual(themes[0], {id: "ykphone", name: "translated: Yeopkerphone"});
    assert.equal(themes[6].name, "translated: Sand");
    assert.ok(ykphone_shell_theme.is_shell_theme("midnight"));
    assert.ok(!ykphone_shell_theme.is_shell_theme("pink"));
});

run_test("current and apply", () => {
    $.clear_all_elements();
    // Without the attribute (or with one this code does not know) the
    // shell is in the default theme.
    assert.equal(ykphone_shell_theme.current_shell_theme(), "ykphone");
    $(":root").attr("data-yk-theme", "retired");
    assert.equal(ykphone_shell_theme.current_shell_theme(), "ykphone");

    ykphone_shell_theme.apply_shell_theme("ocean");
    assert.equal($(":root").attr("data-yk-theme"), "ocean");
    assert.equal(ykphone_shell_theme.current_shell_theme(), "ocean");
    assert.equal(swatch_input("ocean").prop("checked"), true);
});

run_test("picker_context", () => {
    $.clear_all_elements();
    ykphone_shell_theme.apply_shell_theme("sand");
    const {themes} = ykphone_shell_theme.picker_context();
    assert.equal(themes.length, theme_ids.length);
    assert.deepEqual(themes[6], {id: "sand", name: "translated: Sand", is_active: true});
    assert.deepEqual(
        themes.filter((theme) => theme.is_active).map((theme) => theme.id),
        ["sand"],
    );
});

run_test("handle_event", () => {
    $.clear_all_elements();
    ykphone_shell_theme.handle_event({
        type: "ykphone_preference",
        property: "shell_theme",
        value: "burgundy",
    });
    assert.equal(ykphone_shell_theme.current_shell_theme(), "burgundy");
    assert.equal(swatch_input("burgundy").prop("checked"), true);

    // A theme from a newer server shows as the default.
    ykphone_shell_theme.handle_event({
        type: "ykphone_preference",
        property: "shell_theme",
        value: "aurora",
    });
    assert.equal($(":root").attr("data-yk-theme"), "ykphone");

    assert.throws(() => {
        ykphone_shell_theme.handle_event({type: "ykphone_preference", property: "font"});
    });
});

// The contrast table: every theme's colours, read from the stylesheet
// itself, checked against WCAG AA in both the light and the dark mode.

const stylesheet = fs.readFileSync(path.resolve(__dirname, "../styles/ykphone_theme.css"), "utf8");
// Whitespace-normalised, for matching declarations prettier may wrap.
const flat_stylesheet = stylesheet.replaceAll(/\s+/g, " ");

const theme_tokens = [
    "--yk-frame-bg",
    "--yk-navbar-bg",
    "--yk-card-bg",
    "--yk-shell-text",
    "--yk-shell-text-strong",
    "--yk-shell-text-muted",
    "--yk-shell-row-active",
    "--yk-shell-row-active-text",
    "--yk-shell-row-active-focus",
    "--yk-shell-mention",
    "--yk-shell-mention-text",
    "--yk-shell-presence",
    "--yk-shell-presence-idle",
    "--yk-shell-presence-offline",
    "--yk-shell-focus",
];

// CSS Color 4's hsl() to sRGB, channels in 0..1.
function hsl_to_rgb(hue, saturation, lightness) {
    const s = saturation / 100;
    const l = lightness / 100;
    const channel = (n) => {
        const k = (n + hue / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [channel(0), channel(8), channel(4)];
}

const hsl_pattern = String.raw`hsl\((\d+)deg (\d+)% (\d+)%\)`;

function parse_hsl(match, offset) {
    return hsl_to_rgb(Number(match[offset]), Number(match[offset + 1]), Number(match[offset + 2]));
}

function parse_hex(hex) {
    return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
}

function read_themes() {
    const themes = new Map();
    const block_pattern = /\[data-yk-theme="([a-z]+)"] {([^}]*)}/g;
    const declaration_pattern = new RegExp(
        String.raw`(--[a-z-]+): light-dark\( ?${hsl_pattern}, ${hsl_pattern} ?\);`,
        "g",
    );
    for (const block of stylesheet.matchAll(block_pattern)) {
        const light = new Map();
        const dark = new Map();
        const body = block[2].replaceAll(/\s+/g, " ");
        for (const declaration of body.matchAll(declaration_pattern)) {
            light.set(declaration[1], parse_hsl(declaration, 2));
            dark.set(declaration[1], parse_hsl(declaration, 5));
        }
        themes.set(block[1], {light, dark});
    }
    return themes;
}

// A number the stylesheet declares for a token: "10%" → 0.1, "0.7" → 0.7.
function read_amount(token) {
    const match = new RegExp(String.raw`${token}: ([\d.]+)(%?);`).exec(stylesheet);
    assert.ok(match, `${token} is not declared as a plain number`);
    return match[2] === "%" ? Number(match[1]) / 100 : Number(match[1]);
}

function relative_luminance(rgb) {
    const [r, g, b] = rgb.map((c) => (c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
    const [lighter, darker] = [relative_luminance(a), relative_luminance(b)].sort((x, y) => y - x);
    return (lighter + 0.05) / (darker + 0.05);
}

// color-mix(in srgb, color p%, transparent), or an element at opacity
// p, painted over a background.
function over(color, alpha, background) {
    return color.map((c, i) => c * alpha + background[i] * (1 - alpha));
}

function pane_backgrounds() {
    const dark_pane = new RegExp(String.raw`--yk-dark-pane: ${hsl_pattern};`).exec(stylesheet);
    assert.ok(dark_pane);
    return {light: [1, 1, 1], dark: parse_hsl(dark_pane, 1)};
}

// The rail logo (static/images/logo/zulip-org-logo.svg) is a white
// bubble with a dark outline; its shape reads on the rail when either
// stands out from the rail.
function logo_colors() {
    const svg = fs.readFileSync(
        path.resolve(__dirname, "../../static/images/logo/zulip-org-logo.svg"),
        "utf8",
    );
    const fills = [...svg.matchAll(/fill="(#[\dA-Fa-f]{6}|white)"/g)].map((match) =>
        match[1] === "white" ? [1, 1, 1] : parse_hex(match[1]),
    );
    assert.ok(fills.length > 0);
    const by_luminance = fills.toSorted((a, b) => relative_luminance(a) - relative_luminance(b));
    return {outline: by_luminance[0], bubble: by_luminance.at(-1)};
}

// How the stylesheet derives the shell's tinted surfaces; the test
// reads the strengths from these tokens, so the consumers must use them.
const tint_consumers = [
    "--yk-shell-row-hover: color-mix( in srgb, var(--yk-shell-text-strong) var(--yk-shell-tint-hover), transparent );",
    "--yk-shell-input-focus-bg: color-mix( in srgb, var(--yk-shell-text-strong) var(--yk-shell-tint-input-focus), transparent );",
    "--yk-shell-search-bg: color-mix( in srgb, var(--yk-shell-text-strong) var(--yk-shell-tint-search), transparent );",
    "--yk-shell-active-tile-bg: color-mix( in srgb, var(--yk-shell-text-strong) var(--yk-shell-tint-active-tile), transparent );",
    "--yk-shell-count-bg: color-mix( in srgb, var(--yk-shell-text-strong) var(--yk-shell-tint-count), transparent );",
    "--color-background-input: var(--yk-shell-row-hover);",
    "--color-background-input-focus: var(--yk-shell-input-focus-bg);",
    "--color-background-search: var(--yk-shell-search-bg);",
    "--color-background-unread-counter-normal: var(--yk-shell-count-bg);",
    "background-color: var(--yk-shell-active-tile-bg);",
    "opacity: var(--yk-rail-item-rest-opacity);",
    "--color-outline-focus: var(--yk-shell-row-active-focus);",
    "--color-left-sidebar-navigation-icon: var(--yk-shell-row-active-text);",
    "--color-user-circle-idle: var(--yk-shell-presence-idle);",
    "--color-user-circle-offline: var(--yk-shell-presence-offline);",
];

// [what, foreground, background, minimum]. Text needs 4.5:1; pills,
// dots, icons, focus rings and the logo's shape are non-text and need
// 3:1.
function contrast_pairs(colors, pane, amounts, logo) {
    const get = (token) => colors.get(token);
    const card = get("--yk-card-bg");
    const frame = get("--yk-frame-bg");
    const navbar = get("--yk-navbar-bg");
    const strong = get("--yk-shell-text-strong");
    const text = get("--yk-shell-text");
    const muted = get("--yk-shell-text-muted");
    const active = get("--yk-shell-row-active");
    const active_text = get("--yk-shell-row-active-text");
    const tint = (name, surface) => over(strong, amounts[name], surface);
    return [
        ["sidebar text", text, card, 4.5],
        ["bold (unread) text", strong, card, 4.5],
        ["muted text", muted, card, 4.5],
        ["text on a hovered row", text, tint("hover", card), 4.5],
        ["muted text on a hovered row", muted, tint("hover", card), 4.5],
        ["navbar text", text, navbar, 4.5],
        ["navbar strong text", strong, navbar, 4.5],
        ["rail label", over(text, amounts.rail_rest, frame), frame, 4.5],
        ["active rail tile", strong, tint("active_tile", frame), 4.5],
        ["selected row text and icons", active_text, active, 4.5],
        ["mention pill text", get("--yk-shell-mention-text"), get("--yk-shell-mention"), 4.5],
        ["sidebar count pill text", card, tint("count", card), 4.5],
        ["navbar count pill text", navbar, tint("count", navbar), 4.5],
        ["search placeholder", muted, tint("search", navbar), 4.5],
        ["filter placeholder", muted, tint("hover", card), 4.5],
        ["focused filter placeholder", muted, tint("input_focus", card), 4.5],
        ["sidebar icons", muted, card, 3],
        ["mention pill on the card", get("--yk-shell-mention"), card, 3],
        ["mention pill on the pane", get("--yk-shell-mention"), pane, 3],
        ["active presence dot", get("--yk-shell-presence"), card, 3],
        ["away presence dot", get("--yk-shell-presence-idle"), card, 3],
        ["offline presence dot", get("--yk-shell-presence-offline"), card, 3],
        ["focus ring on the card", get("--yk-shell-focus"), card, 3],
        ["focus ring on the navbar", get("--yk-shell-focus"), navbar, 3],
        ["focus ring on the selected row", get("--yk-shell-row-active-focus"), active, 3],
        ["selected row's focus ring on the card", get("--yk-shell-row-active-focus"), card, 3],
        [
            "rail logo's shape",
            contrast(logo.bubble, frame) >= contrast(logo.outline, frame)
                ? logo.bubble
                : logo.outline,
            frame,
            3,
        ],
    ];
}

run_test("stylesheet themes", () => {
    const themes = read_themes();
    // Every theme of the registry, and nothing else, has a block with
    // every token.
    assert.deepEqual([...themes.keys()].toSorted(), theme_ids.toSorted());
    for (const [id, {light, dark}] of themes) {
        assert.deepEqual([...light.keys()], theme_tokens, id);
        assert.deepEqual([...dark.keys()], theme_tokens, id);
    }
    // The default theme is also the one without an attribute.
    assert.match(stylesheet, /:root,\s*\[data-yk-theme="ykphone"] {/);
    for (const declaration of tint_consumers) {
        assert.ok(flat_stylesheet.includes(declaration), declaration);
    }
});

run_test("contrast", () => {
    const panes = pane_backgrounds();
    const amounts = {
        hover: read_amount("--yk-shell-tint-hover"),
        input_focus: read_amount("--yk-shell-tint-input-focus"),
        search: read_amount("--yk-shell-tint-search"),
        active_tile: read_amount("--yk-shell-tint-active-tile"),
        count: read_amount("--yk-shell-tint-count"),
        rail_rest: read_amount("--yk-rail-item-rest-opacity"),
    };
    assert.equal(amounts.hover, 0.1);
    assert.equal(amounts.rail_rest, 0.7);
    const logo = logo_colors();
    for (const [id, modes] of read_themes()) {
        for (const mode of ["light", "dark"]) {
            for (const [what, foreground, background, minimum] of contrast_pairs(
                modes[mode],
                panes[mode],
                amounts,
                logo,
            )) {
                const ratio = contrast(foreground, background);
                assert.ok(
                    ratio >= minimum,
                    `${id} (${mode}): ${what} is ${ratio.toFixed(2)}:1, below ${minimum}:1`,
                );
            }
        }
    }
    // The arithmetic itself: black on white is 21:1, a colour on itself 1:1.
    assert.equal(contrast([0, 0, 0], [1, 1, 1]), 21);
    assert.equal(contrast(hsl_to_rgb(206, 81, 35), hsl_to_rgb(206, 81, 35)), 1);
});
