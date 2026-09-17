// Enter in the link form applies the link and gives the editor back the
// cursor; no click in editor text opens a dialog of any kind.
/* global document -- page.evaluate callbacks run in the browser */
import {BASE, sleep, start, state} from "./lib.mjs";

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
        bubble: Boolean(document.querySelector(".ykphone-rich-link-bubble")),
        dialog: [
            ...document.querySelectorAll(
                ".micromodal.modal--open, .popover-menu-instance, .user-card-popover, [data-tippy-root]",
            ),
        ].filter((e) => e.offsetParent !== null && !e.querySelector(".ykphone-rich-link-bubble"))
            .length,
        focus: document.activeElement?.className?.toString().slice(0, 30),
        messages: document.querySelectorAll(".message_row").length,
    }));
const snap = async (label) =>
    console.log("==", label, JSON.stringify((await state(page)).md), JSON.stringify(await ui()));
await clear();
const before = (await ui()).messages;
await kb.type("zulip");
await sleep(250);
await kb.down("Shift");
for (let i = 0; i < 5; i += 1) {
    await kb.press("ArrowLeft");
    await sleep(80);
}
await kb.up("Shift");
await sleep(200);
console.log("selection before the form", JSON.stringify((await state(page)).sel));
await kb.down("Control");
await kb.press("k");
await kb.up("Control");
await sleep(500);
await snap("form open over a selection");
await kb.type("https://zulip.com");
await kb.press("Enter");
await sleep(600);
await snap("enter in the form");
console.log("messages before/after", before, (await ui()).messages);
await kb.type(" and more");
await sleep(250);
await snap("typing after the form closed");
// Clicks in other kinds of content open nothing.
await clear();
await kb.type("```python");
await kb.down("Shift");
await kb.press("Enter");
await kb.up("Shift");
await sleep(300);
await kb.type("x = 1");
await sleep(250);
await page.click(".ykphone-rich-code-block code");
await sleep(400);
await snap("clicked in a code block");
await page.click(".ykphone-rich-code-label");
await sleep(400);
await snap("clicked the code label");
await clear();
await kb.type("hi @iag");
await sleep(500);
await kb.press("Enter");
await sleep(400);
await page.click(".ykphone-rich-content .ykphone-rich-mention");
await sleep(400);
await snap("clicked a mention chip");
await clear();
await page.click(`#ykphone-compose-formatting-row .formatting_button[data-format-type="spoiler"]`);
await sleep(400);
await page.click(".ykphone-rich-spoiler-header");
await sleep(400);
await snap("clicked a spoiler header");
await clear();
await browser.close();
