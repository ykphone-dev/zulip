// Clicking a link must only place the cursor; the bubble is what offers
// to change it, and the form opens from the button or Ctrl+K.
/* global document -- page.evaluate callbacks run in the browser */
import {BASE, shot, sleep, start, state} from "./lib.mjs";

const {browser, page} = await start();
const kb = page.keyboard;
await page.goto(BASE + "/#narrow/channel/12-errors");
await sleep(3500);
await page.click(".ykphone-rich-content");
const clear = async () => {
    await kb.down("Control");
    await kb.press("a");
    await kb.up("Control");
    await kb.press("Backspace");
    await sleep(150);
};
const ui = () =>
    page.evaluate(() => ({
        form: Boolean(document.querySelector(".ykphone-rich-link-form")),
        bubble: document
            .querySelector(".ykphone-rich-link-bubble")
            ?.textContent.replaceAll(/\s+/g, " ")
            .trim(),
        focus: document.activeElement?.className?.toString().slice(0, 40),
        caret: (() => {
            const ta = document.querySelector("#compose-textarea");
            return [ta.selectionStart, ta.selectionEnd];
        })(),
    }));
const snap = async (label) =>
    console.log("==", label, JSON.stringify((await state(page)).md), JSON.stringify(await ui()));

await clear();
await kb.type("see [text](https://zulip.com) here");
await sleep(400);
// A click in the middle of the link text.
const box = await page.evaluate(() => {
    const a = document.querySelector(".ykphone-rich-content a");
    const r = a.getBoundingClientRect();
    return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
    };
});
await page.mouse.click(box.x, box.y);
await sleep(500);
await snap("clicked in the link");
// A click just after the link, then typing.
await page.mouse.click(box.right + 1, (box.top + box.bottom) / 2);
await sleep(400);
await snap("clicked after the link");
await kb.type("X");
await sleep(300);
await snap("typed after the link");
// Right arrow out of the link, then typing.
await clear();
await kb.type("a [b](https://zulip.com)");
await sleep(300);
await kb.press("ArrowLeft");
await sleep(200);
await snap("cursor inside the link");
await kb.press("ArrowRight");
await sleep(200);
await kb.type("Y");
await sleep(250);
await snap("typed after arrowing out");
// The form from Ctrl+K, and Escape back to the editor.
await clear();
await kb.type("plain text");
await sleep(200);
await kb.down("Control");
await kb.down("Shift");
await kb.press("l");
await kb.up("Shift");
await kb.up("Control");
await sleep(500);
await snap("ctrl+k");
await kb.press("Escape");
await sleep(400);
await kb.type("!");
await sleep(250);
await snap("escape then typing");
// The form from the toolbar button.
await page.click(`#ykphone-compose-formatting-row .formatting_button[data-format-type="link"]`);
await sleep(600);
await snap("toolbar link button");
await page.keyboard.press("Escape");
await sleep(300);
// The bubble's buttons: edit opens the form, remove unlinks.
await clear();
await kb.type("go [there](https://zulip.com) now");
await sleep(300);
await page.mouse.click(box.x, box.y);
await sleep(500);
await snap("bubble showing");
await page.click(".ykphone-rich-link-edit");
await sleep(600);
await snap("bubble edit");
await page.keyboard.press("Escape");
await sleep(400);
await page.mouse.click(box.x, box.y);
await sleep(500);
await page.click(".ykphone-rich-link-drop");
await sleep(500);
await snap("bubble remove");
await shot(page, "t26-link");
await browser.close();
