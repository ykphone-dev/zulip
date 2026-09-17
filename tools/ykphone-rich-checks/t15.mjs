/* global document, window -- page.evaluate callbacks run in the browser */
import {BASE, shot, sleep, start, state} from "./lib.mjs";

const {browser, page} = await start();
const kb = page.keyboard;
await page.goto(BASE + "/#narrow/channel/12-errors/topic/general.20chat");
await sleep(3500);
await page.click(".ykphone-rich-content");
await kb.type("keep **this** draft with :smile: and a list");
await sleep(200);
console.log("keys", await page.evaluate(() => Object.keys(localStorage)));
// Save as draft the way upstream does when the window loses focus.
await page.evaluate(() => window.dispatchEvent(new Event("blur")));
await sleep(500);
console.log(
    "drafts",
    await page.evaluate(() => {
        const k = Object.keys(localStorage).find((k) => k.includes("drafts"));
        return k ? Object.values(JSON.parse(localStorage.getItem(k))).map((d) => d.content) : null;
    }),
);
// Clear box via upstream (like after a send): compose_actions.cancel through the close button
await page.evaluate(() => document.querySelector("#compose_close")?.click());
await sleep(800);
console.log("after close", JSON.stringify((await state(page)).md));
await page.evaluate(() => {
    window.location.hash = "#drafts";
});
await sleep(2500);
await shot(page, "t15-drafts");
console.log(
    "overlay rows",
    await page.$$eval(".draft-row, .draft-message-row, [data-draft-id]", (els) =>
        els.slice(0, 3).map((e) => e.textContent.trim().replaceAll(/\s+/g, " ").slice(0, 60)),
    ),
);
const row = await page.$(
    "[data-draft-id] .restore-overlay-message.message_content, [data-draft-id] .messagebox",
);
if (row) {
    await row.click();
    await sleep(2000);
}
const s = await state(page);
console.log("restored", JSON.stringify(s.md), s.html?.slice(0, 300));
await browser.close();
