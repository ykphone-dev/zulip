/* global document -- page.evaluate callbacks run in the browser */
import {BASE, shot, sleep, start, state} from "./lib.mjs";

const {browser, page} = await start();
await page.goto(BASE + "/#narrow/channel/3-Verona/topic/general.20chat");
await sleep(3500);
await page.click(".ykphone-rich-content");
const step = async (label, fn) => {
    await fn();
    await sleep(250);
    const s = await state(page);
    console.log("==", label, JSON.stringify(s.md), s.sel, s.html);
};
await step("type bold", () => page.keyboard.type("hello **bold** world"));
await step("select all + clear", async () => {
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
});
await step("list", () => page.keyboard.type("- one"));
await step("enter in list", () => page.keyboard.press("Enter"));
await step("type two", () => page.keyboard.type("two"));
await step("enter enter exits", async () => {
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
});
await step("para after", () => page.keyboard.type("after *it* 3 * 4"));
await step("shift enter", async () => {
    await page.keyboard.down("Shift");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Shift");
    await page.keyboard.type("> quoted");
});
await step("ctrl-b", async () => {
    await page.keyboard.down("Control");
    await page.keyboard.press("b");
    await page.keyboard.up("Control");
    await page.keyboard.type("B");
});
await step("mention", async () => {
    await page.keyboard.type(" @iag");
    await sleep(400);
    console.log(
        "menu",
        await page.evaluate(() =>
            [...document.querySelectorAll(".ykphone-rich-typeahead li")].map((li) =>
                li.textContent.trim().slice(0, 30),
            ),
        ),
    );
    await page.keyboard.press("Enter");
});
await step("emoji", async () => {
    await page.keyboard.type(":smil");
    await sleep(400);
    console.log(
        "menu",
        await page.evaluate(() =>
            [...document.querySelectorAll(".ykphone-rich-typeahead li")]
                .slice(0, 3)
                .map((li) => li.textContent.trim().slice(0, 30)),
        ),
    );
    await page.keyboard.press("Enter");
});
await step("channel", async () => {
    await page.keyboard.type("#ver");
    await sleep(400);
    console.log(
        "menu",
        await page.evaluate(() =>
            [...document.querySelectorAll(".ykphone-rich-typeahead li")]
                .slice(0, 3)
                .map((li) => li.textContent.trim().slice(0, 30)),
        ),
    );
    await page.keyboard.press("Enter");
});
await step("topic", async () => {
    await page.keyboard.press("Backspace");
    await page.keyboard.type(">");
    await sleep(400);
    console.log(
        "menu",
        await page.evaluate(() =>
            [...document.querySelectorAll(".ykphone-rich-typeahead li")]
                .slice(0, 4)
                .map((li) => li.textContent.trim().slice(0, 40)),
        ),
    );
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
});
await shot(page, "t2");
await browser.close();
