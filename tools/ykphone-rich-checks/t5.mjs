/* global document -- page.evaluate callbacks run in the browser */
import {BASE, shot, sleep, start, state} from "./lib.mjs";

const {browser, page} = await start();
await page.goto(BASE + "/#narrow/channel/12-errors/topic/general.20chat");
await sleep(3500);
await page.click(".ykphone-rich-content");
const kb = page.keyboard;
const clear = async () => {
    await kb.down("Control");
    await kb.press("a");
    await kb.up("Control");
    await kb.press("Backspace");
    await sleep(100);
};
const select_word = async (from_start, len) => {
    await kb.press("Home");
    for (let i = 0; i < from_start; i += 1) {
        await kb.press("ArrowRight");
    }
    await kb.down("Shift");
    for (let i = 0; i < len; i += 1) {
        await kb.press("ArrowRight");
    }
    await kb.up("Shift");
};
const button = async (type) => {
    const visible = await page.evaluate(() =>
        Boolean(document.querySelector("#ykphone-compose-formatting-row")?.offsetParent),
    );
    if (!visible) {
        await page.click(".ykphone-compose-formatting-toggle");
        await sleep(200);
    }
    await page.click(
        `#ykphone-compose-formatting-row .formatting_button[data-format-type="${type}"]`,
    );
    await sleep(300);
};
const report = async (label) => {
    const s = await state(page);
    console.log(
        "==",
        label,
        JSON.stringify(s.md),
        s.sel,
        "|",
        s.html
            .replaceAll(/ class="[^"]*"| contenteditable="false"| data-[a-z-]+="[^"]*"/g, "")
            .slice(0, 200),
    );
};
for (const [type, name] of [
    ["bold", "bold"],
    ["italic", "italic"],
    ["strikethrough", "strike"],
    ["code", "code-inline"],
    ["latex", "math-inline"],
]) {
    await clear();
    await kb.type("before abc after");
    await select_word(7, 3);
    await button(type);
    await report(name + " on");
    await button(type);
    await report(name + " off?");
}
await clear();
await kb.type("before abc after");
await select_word(7, 3);
await button("link");
await sleep(300);
console.log(
    "popover",
    await page.evaluate(() => Boolean(document.querySelector(".ykphone-rich-link-form"))),
);
await kb.type("https://example.com");
await kb.press("Enter");
await sleep(300);
await report("link");
await clear();
await kb.type("first");
await kb.down("Shift");
await kb.press("Enter");
await kb.up("Shift");
await kb.type("second");
await kb.down("Control");
await kb.press("a");
await kb.up("Control");
await button("bulleted");
await report("bulleted on");
await kb.down("Control");
await kb.press("a");
await kb.up("Control");
await button("bulleted");
await report("bulleted off");
await kb.down("Control");
await kb.press("a");
await kb.up("Control");
await button("numbered");
await report("numbered on");
await clear();
await kb.type("before abc after");
await select_word(7, 3);
await button("quote");
await report("quote");
await clear();
await kb.type("before abc after");
await select_word(7, 3);
await button("spoiler");
await report("spoiler");
await kb.type("Title");
await report("spoiler header typed");
await clear();
await kb.type("x");
await button("code");
await report("code block empty sel");
await kb.type("let a = 1;");
await report("typed in code");
await clear();
await kb.type("abc");
await kb.down("Control");
await kb.press("a");
await kb.up("Control");
await button("latex");
await report("latex block? (single line selection -> inline)");
await clear();
await kb.type("line1");
await kb.down("Shift");
await kb.press("Enter");
await kb.up("Shift");
await kb.type("line2");
await kb.down("Control");
await kb.press("a");
await kb.up("Control");
await button("latex");
await report("latex block");
await clear();
await kb.type("before abc after");
await select_word(7, 3);
await kb.down("Control");
await kb.press("b");
await kb.up("Control");
await sleep(200);
await report("ctrl-b");
await kb.down("Control");
await kb.press("i");
await kb.up("Control");
await sleep(200);
await report("ctrl-i");
await kb.down("Control");
await kb.down("Shift");
await kb.press("C");
await kb.up("Shift");
await kb.up("Control");
await sleep(200);
await report("ctrl-shift-c");
await clear();
await kb.type("before abc after");
await select_word(7, 3);
await kb.down("Control");
await kb.down("Shift");
await kb.press("L");
await kb.up("Shift");
await kb.up("Control");
await sleep(300);
console.log(
    "popover via shortcut",
    await page.evaluate(() => Boolean(document.querySelector(".ykphone-rich-link-form"))),
);
await kb.press("Escape");
await sleep(200);
await shot(page, "t5");
await clear();
await browser.close();
