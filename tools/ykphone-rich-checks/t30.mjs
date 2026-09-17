import {start, state, sleep, BASE} from "./lib.mjs";
const {browser, page} = await start({width: 1400, height: 900});
const kb = page.keyboard;
const who = (label) => page.evaluate((label) => {
    const el = document.activeElement;
    const ta = document.querySelector("#compose-textarea");
    return label + ": " + (el?.id || el?.className?.toString().slice(0, 30) || el?.tagName) + " | md=" + JSON.stringify(ta?.value ?? null) + " | ta.sel=" + ta?.selectionStart;
}, label);
await page.goto(BASE + "/#narrow/channel/12-errors"); await sleep(4000);
console.log(await who("page load"));
// navigate to another channel from the sidebar, then back
await page.click('#stream_filters a[href*="Verona"], #stream_filters a[href*="verona"]').catch(() => console.log("no Verona link"));
await sleep(1500); console.log(await who("clicked Verona in sidebar"));
await page.evaluate(() => { location.hash = "#narrow/channel/12-errors"; }); await sleep(1500); console.log(await who("hash to errors"));
// reply hotkey on a message: click a message first so it is selected
await page.evaluate(() => document.querySelector(".ykphone-rich-content")?.blur());
await page.mouse.click(700, 400); await sleep(400); console.log(await who("clicked in the feed"));
await kb.press("r"); await sleep(800); console.log(await who("after r"));
await page.evaluate(() => document.querySelector(".ykphone-rich-content")?.blur()); await page.mouse.click(700, 400); await sleep(300);
await kb.press("c"); await sleep(800); console.log(await who("after c"));
// type a draft, leave, come back
await kb.type("draft **text** here"); await sleep(400);
await page.click('#stream_filters a[href*="Verona"], #stream_filters a[href*="verona"]').catch(() => {}); await sleep(1500); console.log(await who("left with draft"));
await page.evaluate(() => { location.hash = "#narrow/channel/12-errors"; }); await sleep(2000); console.log(await who("back to errors"));
console.log("dom selection:", await page.evaluate(() => { const s = getSelection(); return [s.anchorNode?.textContent?.slice(0, 30), s.anchorOffset, s.anchorNode?.parentElement?.closest(".ykphone-rich-content") !== null]; }));
// the collapsed bar button, if the box can be closed
await kb.press("Escape"); await sleep(600); console.log(await who("after Escape"));
const btn = await page.$("#compose_buttons .compose_reply_button, #left_bar_compose_reply_button_big, #new_conversation_button, .compose_mobile_button");
if (btn) { await btn.click(); await sleep(800); console.log(await who("after collapsed-bar button")); }
await browser.close();
