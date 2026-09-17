// Where focus is after every way the compose box opens.
import {start, state, sleep, BASE} from "./lib.mjs";
const {browser, page} = await start();
const kb = page.keyboard;
const who = () => page.evaluate(() => {
    const el = document.activeElement;
    return (el?.id || el?.className?.toString().slice(0, 40) || el?.tagName) + " | compose open: " + !!document.querySelector("#compose")?.offsetParent + " | md: " + JSON.stringify(document.querySelector("#compose-textarea")?.value ?? null);
});
await page.goto(BASE + "/#narrow/channel/12-errors"); await sleep(4000);
console.log("after narrow (auto-open):", await who());
await page.evaluate(() => document.querySelector("#compose .ykphone-rich-content")?.blur());
await page.click("#navbar_alerts_wrapper, .message-header, body"); await sleep(300);
await kb.press("Escape"); await sleep(500); console.log("after Escape:", await who());
await kb.press("c"); await sleep(800); console.log("after c:", await who());
await kb.press("Escape"); await sleep(500);
await kb.press("r"); await sleep(800); console.log("after r:", await who());
await kb.press("Escape"); await sleep(500);
const bar = await page.$(".compose_mobile_button, #compose_buttons .reply_button, #left_bar_compose_reply_button_big, .compose-reply-button-wrapper button");
console.log("collapsed-bar button found:", !!bar);
if (bar) { await bar.click(); await sleep(800); console.log("after bar button:", await who()); }
// Draft restore then reopen.
await page.evaluate(() => document.querySelector(".ykphone-rich-content")?.focus());
await kb.type("draft **text** here"); await sleep(300);
await kb.press("Escape"); await sleep(800); console.log("after escape with draft:", await who());
await kb.press("c"); await sleep(1000); console.log("after c with draft:", await who());
console.log("editor selection:", await page.evaluate(() => { const s = getSelection(); return [s.anchorNode?.textContent, s.anchorOffset]; }));
await browser.close();
