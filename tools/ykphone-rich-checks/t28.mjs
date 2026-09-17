// The link bubble in both themes and at both widths.
/* global document, getComputedStyle, window -- page.evaluate callbacks run in the browser */
import {BASE, shot, sleep, start, state} from "./lib.mjs";

const scheme = Number(process.argv[2] ?? 3);
const width = Number(process.argv[3] ?? 1280);
const {browser, page} = await start({width: Math.max(width, 1280), height: 900});
const kb = page.keyboard;
await page.evaluate(async (scheme) => {
    const csrf = document.querySelector('input[name="csrfmiddlewaretoken"]')?.value ?? "";
    await fetch("/json/settings", {
        method: "PATCH",
        headers: {"Content-Type": "application/x-www-form-urlencoded", "X-CSRFToken": csrf},
        body: `color_scheme=${scheme}`,
    });
}, scheme);
await page.goto(BASE + "/#narrow/channel/12-errors");
await sleep(4000);
const clickable = await page.evaluate(() => {
    const el = document.querySelector(".ykphone-rich-content");
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
});
if (!clickable) {
    await page.evaluate(() => {
        document.querySelector(".compose_mobile_button, #compose-content, #compose")?.click();
    });
    await sleep(800);
}
await page.evaluate(() => document.querySelector(".ykphone-rich-content")?.focus());
await sleep(300);
await kb.down("Control");
await kb.press("a");
await kb.up("Control");
await kb.press("Backspace");
await sleep(200);
await kb.type("문서는 [여기](https://zulip.com/help/) 를 보세요");
await sleep(600);
// The narrow layout is checked by shrinking the window with the
// composer already open, the way a window being resized does.
if (width < 600) {
    await page.setViewport({width, height: 800});
    await sleep(800);
}
console.log(
    "before click",
    JSON.stringify((await state(page)).md),
    await page.evaluate(() => ({
        editor: Boolean(document.querySelector(".ykphone-rich-content")),
        visible: document.querySelector(".ykphone-rich-content")?.getBoundingClientRect().height,
        links: document.querySelectorAll(".ykphone-rich-content a").length,
    })),
);
const box = await page.evaluate(() => {
    const a = document.querySelector(".ykphone-rich-content a");
    const r = a.getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
});
await page.mouse.click(box.x, box.y);
await sleep(600);
const name = `t28-bubble-${scheme === 2 ? "dark" : "light"}-${width}`;
await shot(page, name);
const geo = await page.evaluate(() => {
    const b = document.querySelector(".ykphone-rich-link-bubble");
    const a = document.querySelector(".ykphone-rich-content a");
    const rb = b?.getBoundingClientRect();
    const ra = a.getBoundingClientRect();
    return {
        bubble: rb && [
            Math.round(rb.left),
            Math.round(rb.top),
            Math.round(rb.width),
            Math.round(rb.height),
        ],
        link: [Math.round(ra.left), Math.round(ra.top), Math.round(ra.width)],
        fits: rb ? rb.left >= 0 && rb.right <= window.innerWidth && rb.top >= 0 : false,
        color: b && getComputedStyle(b.querySelector(".ykphone-rich-link-bubble-button")).color,
    };
});
console.log(name, JSON.stringify(geo), JSON.stringify((await state(page)).md));
await browser.close();
