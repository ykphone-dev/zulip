/* global document -- page.evaluate callbacks run in the browser */
import {BASE, shot, sleep, start, state} from "./lib.mjs";

const {browser, page} = await start();
const kb = page.keyboard;
await page.goto(BASE + "/#narrow/channel/12-errors");
await sleep(3500);
// clear composer
await page.click(".ykphone-rich-content");
await kb.down("Control");
await kb.press("a");
await kb.up("Control");
await kb.press("Backspace");
await sleep(200);
await page.waitForSelector(".message_row", {timeout: 15000}).catch(() => console.log("no rows"));
const rows = await page.$$(
    ".message-list:not(.hidden) .message_row, .focused-message-list .message_row",
);
console.log("rows", rows.length);
const last = rows.at(-1);
await last.evaluate((e) => e.querySelector(".message_content").click());
await sleep(400);
await page.evaluate(() => document.activeElement.blur());
await kb.press("<");
await sleep(1500);
console.log(
    "card",
    await page.evaluate(() => Boolean(document.querySelector("#ykphone-forward-card"))),
    "dropdown open",
    await page.evaluate(() =>
        document
            .querySelector("#compose_select_recipient_widget")
            ?.classList.contains("widget-open"),
    ),
);
// choose errors in the dropdown
await page.evaluate(() => {
    const item = [...document.querySelectorAll(".dropdown-list-container .list-item")].find((e) =>
        e.textContent.trim().startsWith("errors"),
    );
    item?.click();
});
await sleep(600);
await page.click(".ykphone-rich-content");
await kb.type("이거 **꼭** 보세요");
await sleep(200);
console.log("before send", JSON.stringify((await state(page)).md));
await shot(page, "t16-forward");
await kb.press("Enter");
await sleep(2000);
console.log(
    "after send",
    JSON.stringify((await state(page)).md),
    "card",
    await page.evaluate(() => Boolean(document.querySelector("#ykphone-forward-card"))),
);
await browser.close();
