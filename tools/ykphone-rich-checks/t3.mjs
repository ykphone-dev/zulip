/* global document -- page.evaluate callbacks run in the browser */
import {BASE, shot, sleep, start, state} from "./lib.mjs";

const {browser, page} = await start();
await page.goto(BASE + "/#narrow/channel/12-errors/topic/general.20chat");
await sleep(3500);
await page.click(".ykphone-rich-content");
const step = async (label, fn) => {
    await fn();
    await sleep(300);
    const s = await state(page);
    console.log("==", label, JSON.stringify(s.md), s.sel, s.html);
};
const menu = () =>
    page.evaluate(() =>
        [...document.querySelectorAll(".ykphone-rich-typeahead li")]
            .slice(0, 4)
            .map((li) => li.textContent.trim().replaceAll(/\s+/g, " ").slice(0, 40)),
    );
const shift_enter = async () => {
    await page.keyboard.down("Shift");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Shift");
};
await step("list", () => page.keyboard.type("- one"));
await step("shift-enter in list", shift_enter);
await step("two", () => page.keyboard.type("two"));
await step("shift-enter x2 exits", async () => {
    await shift_enter();
    await shift_enter();
});
await step("para", () => page.keyboard.type("after *it* 3 * 4 and **b"));
await step("mention", async () => {
    await page.keyboard.type(" @iag");
    await sleep(400);
    console.log("menu", await menu());
    await page.keyboard.press("Enter");
});
await step("emoji", async () => {
    await page.keyboard.type(":smil");
    await sleep(400);
    console.log("menu", await menu());
    await page.keyboard.press("Enter");
});
await step("channel", async () => {
    await page.keyboard.type("#ver");
    await sleep(400);
    console.log("menu", await menu());
    await page.keyboard.press("Enter");
});
await step("topic", async () => {
    await page.keyboard.press("Backspace");
    await page.keyboard.type(">");
    await sleep(400);
    console.log("menu", await menu());
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
});
await shot(page, "t3-before-send");
await step("send", async () => {
    await page.keyboard.press("Enter");
    await sleep(1500);
});
console.log(
    "banners",
    await page.evaluate(() =>
        document.querySelector("#compose_banners")?.textContent.trim().slice(0, 200),
    ),
);
await shot(page, "t3-after-send");
await browser.close();
