// Where the focus and the cursor are after every way the box opens.
/* global document, getSelection -- page.evaluate callbacks run in the browser */
import {BASE, sleep, start} from "./lib.mjs";

const {browser, page} = await start({width: 1400, height: 900});
const kb = page.keyboard;
const who = (label) =>
    page.evaluate((label) => {
        const el = document.activeElement;
        const ta = document.querySelector("#compose-textarea");
        const pm = document.querySelector(".ykphone-rich-content");
        const s = getSelection();
        const in_editor = pm !== null && s.anchorNode !== null && pm.contains(s.anchorNode);
        return `${label}: focus=${el === document.body ? "BODY" : el?.id || el?.className?.toString().slice(0, 28)} md=${JSON.stringify(ta?.value ?? null)} ta.sel=${ta?.selectionStart} caret_in_editor=${in_editor} offset=${s.anchorOffset}`;
    }, label);
// A narrow whose box is closed: mentions.
await page.goto(BASE + "/#narrow/is/mentioned");
await sleep(3500);
console.log(
    await who("mentions narrow"),
    "messages:",
    await page.evaluate(() => document.querySelectorAll(".message_row").length),
);
await kb.press("r");
await sleep(1200);
console.log(await who("after r"));
await kb.press("Escape");
await sleep(800);
console.log(await who("after Escape"));
await kb.press("c");
await sleep(1200);
console.log(await who("after c"));
await kb.press("Escape");
await sleep(800);
const bar = await page.evaluateHandle(
    () =>
        [
            ...document.querySelectorAll(
                "#left_bar_compose_reply_button_big, #compose_buttons button, .compose_mobile_button, #new_direct_message_button",
            ),
        ].find((b) => b.offsetParent !== null) ?? null,
);
const bar_info = await page.evaluate(
    (b) => b && {id: b.id, cls: b.className, text: b.textContent.trim().slice(0, 30)},
    bar,
);
console.log("collapsed-bar button:", JSON.stringify(bar_info));
if (bar_info) {
    await bar.asElement().click();
    await sleep(1200);
    console.log(await who("after collapsed-bar button"));
    await kb.press("Escape");
    await sleep(600);
}
// A narrow that auto-opens the box (from the sidebar, mouse), then a
// draft restored into it.
await page.click('#stream_filters a[href*="12-errors"], #stream_filters a[href*="errors"]');
await sleep(2000);
console.log(await who("clicked #errors in the sidebar"));
await page.click('#stream_filters a[href*="Verona"], #stream_filters a[href*="verona"]');
await sleep(2000);
console.log(await who("clicked Verona"));
await page.evaluate(() => document.querySelector(".ykphone-rich-content")?.focus());
await sleep(200);
await kb.type("초안 **굵게** 끝");
await sleep(400);
console.log(await who("typed a draft"));
await page.click('#stream_filters a[href*="12-errors"], #stream_filters a[href*="errors"]');
await sleep(2000);
console.log(await who("to #errors"));
await page.click('#stream_filters a[href*="Verona"], #stream_filters a[href*="verona"]');
await sleep(2500);
console.log(await who("back to Verona (draft)"));
await kb.type("!");
await sleep(300);
console.log(await who("typed after the restored draft"));
await browser.close();
