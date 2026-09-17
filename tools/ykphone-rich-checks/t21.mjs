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
const menu = () =>
    page.evaluate(() =>
        [...document.querySelectorAll(".ykphone-rich-typeahead li")]
            .slice(0, 3)
            .map((li) => li.textContent.trim().replaceAll(/\s+/g, " ").slice(0, 32)),
    );
const snap = async (label) => {
    const s = await state(page);
    console.log(
        "==",
        label,
        JSON.stringify(s.md),
        "|",
        s.html
            .replaceAll(
                / class="[^"]*"| contenteditable="false"| data-[a-z-]+="[^"]*"| title="[^"]*"| aria-[a-z]+="[^"]*"| role="[^"]*"/g,
                "",
            )
            .slice(0, 200),
    );
};
await clear();
await kb.type("@al");
await sleep(400);
console.log("menu", await menu());
await kb.press("Enter");
await sleep(300);
await snap("@all");
await kb.type("@hamlet");
await sleep(500);
console.log("menu", await menu());
await kb.press("Enter");
await sleep(300);
await snap("group");
await kb.type("@_iag");
await sleep(500);
console.log(
    "menu",
    await menu(),
    "footer",
    await page.evaluate(() =>
        document.querySelector(".ykphone-rich-typeahead .typeahead-footer")?.textContent.trim(),
    ),
);
await kb.press("Enter");
await sleep(300);
await snap("silent");
// Escape with menu open
await kb.type("@ia");
await sleep(400);
console.log("menu open", (await menu()).length > 0);
await kb.press("Escape");
await sleep(300);
console.log(
    "after escape: menu",
    (await menu()).length,
    "composing",
    await page.evaluate(() => Boolean(document.querySelector("#compose")?.offsetParent)),
    "md",
    JSON.stringify((await state(page)).md),
);
await clear();
// link click popover
await kb.type("see [text](https://zulip.com) here");
await sleep(400);
await snap("typed link");
await page.click(".ykphone-rich-content a");
await sleep(500);
console.log(
    "link popover",
    await page.evaluate(() => Boolean(document.querySelector(".ykphone-rich-link-form"))),
    await page.evaluate(() => document.querySelector(".ykphone-rich-link-url")?.value),
);
await page.keyboard.press("Escape");
await sleep(200);
await clear();
// up arrow in empty compose edits last message
await kb.press("ArrowLeft");
await sleep(1500);
console.log(
    "edit box open",
    await page.evaluate(() => Boolean(document.querySelector(".message_edit_content"))),
);
await shot(page, "t21");
await browser.close();
