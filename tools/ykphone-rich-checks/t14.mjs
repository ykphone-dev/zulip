import {start, state, shot, sleep, BASE} from "./lib.mjs";
const {browser, page} = await start();
const kb = page.keyboard;
await page.goto(BASE + "/#narrow/channel/12-errors/topic/general.20chat");
await sleep(3500);
let s = await state(page);
console.log("start", JSON.stringify(s.md));
// Clear the box, then restore from drafts overlay.
await page.click(".ykphone-rich-content");
await kb.down("Control"); await kb.press("a"); await kb.up("Control"); await kb.press("Backspace"); await sleep(300);
await page.evaluate(() => { location.hash = "#drafts"; }); await sleep(2000);
const rows = await page.$$(".draft-message-row .restore-overlay-message.message_content, .draft-row .restore-overlay-message.message_content");
console.log("draft rows", rows.length, await page.$$eval(".restore-overlay-message.message_content", (els) => els.slice(0, 3).map((e) => e.textContent.trim().slice(0, 50))));
if (rows.length > 0) { await rows[0].click(); await sleep(2000); }
s = await state(page);
console.log("restored", JSON.stringify(s.md), s.html?.slice(0, 200), "focus", s.focus);
await shot(page, "t14-restored");
await kb.type("!");
console.log("typed after restore", JSON.stringify((await state(page)).md));
await browser.close();
