import {BASE, sleep, start, state} from "./lib.mjs";

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
const snap = async (l) => {
    const s = await state(page);
    console.log(
        "==",
        l,
        JSON.stringify(s.md),
        "|",
        s.html
            .replaceAll(/ class="[^"]*"| contenteditable="false"| data-[a-z-]+="[^"]*"/g, "")
            .slice(0, 160),
    );
};
const shift_enter = async () => {
    await kb.down("Shift");
    await kb.press("Enter");
    await kb.up("Shift");
    await sleep(150);
};
await clear();
await kb.type("first line");
await shift_enter();
await snap("after break");
await kb.type("- ");
await sleep(250);
await snap("typed dash space");
await kb.type("item");
await snap("typed item");
await clear();
await kb.type("q");
await shift_enter();
await kb.type("> ");
await sleep(250);
await snap("quote prefix");
await kb.type("quoted");
await snap("quote text");
await clear();
await kb.type("# ");
await sleep(250);
await snap("heading prefix");
await kb.type("Title");
await snap("heading text");
await clear();
await kb.type("```python");
await sleep(200);
await snap("fence typed");
await shift_enter();
await sleep(250);
await snap("fence enter");
await kb.type("x = 1");
await snap("code typed");
await clear();
await kb.type("1. ");
await sleep(250);
await snap("ordered prefix");
await kb.type("one");
await snap("ordered text");
await browser.close();
