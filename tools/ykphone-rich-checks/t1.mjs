/* global document -- page.evaluate callbacks run in the browser */
import {BASE, shot, sleep, start, state} from "./lib.mjs";

const {browser, page} = await start();
await page.goto(BASE + "/#narrow/channel/3-Verona");
await sleep(3000);
// open composer with keyboard "c"? use the compose button
await page.keyboard.press("Escape");
await page.evaluate(() => document.querySelector("#left-sidebar .top_left_all_messages")?.click());
await sleep(500);
await page.goto(BASE + "/#narrow/channel/3-Verona/topic/general.20chat");
await sleep(3000);
console.log(
    "compose open?",
    await page.evaluate(() => document.querySelector("#compose")?.style.display),
);
console.log(
    await page.evaluate(() => ({
        composing: Boolean(document.querySelector("#compose .ykphone-rich-editor")),
        visible: document.querySelector(".ykphone-rich-editor")?.getBoundingClientRect().height,
    })),
);
await page
    .click(".ykphone-rich-content")
    .catch((error) => console.log("click fail", error.message));
await sleep(300);
await page.keyboard.type("hello **bold** world");
await sleep(300);
console.log(await state(page));
await shot(page, "t1-typed");
await browser.close();
