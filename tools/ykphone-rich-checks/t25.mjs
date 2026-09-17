// Regression pass over the paths touched while finishing the tests:
// the import path in the sync (typeahead insert, drafts, upload
// replace_syntax, upstream's cursor placement) and typed formatting.
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
const snap = async (label) => {
    const s = await state(page);
    console.log(
        "==",
        label,
        JSON.stringify(s.md),
        s.sel,
        "|",
        s.html
            .replaceAll(
                / class="[^"]*"| contenteditable="false"| data-[a-z-]+="[^"]*"| title="[^"]*"| aria-[a-z]+="[^"]*"| role="[^"]*"| rel="[^"]*"/g,
                "",
            )
            .slice(0, 220),
    );
};
const button = (type) =>
    page.click(`#ykphone-compose-formatting-row .formatting_button[data-format-type="${type}"]`);

await clear();
await kb.type("hi **bold** and *italic*");
await sleep(250);
await snap("typed inline");
await clear();
await kb.type("## *heading*");
await sleep(250);
await snap("typed heading");
await clear();
await kb.type("@ia");
await sleep(500);
await kb.press("Enter");
await sleep(300);
await snap("mention from typeahead");
await kb.type("hi");
await snap("typing after the chip");
await clear();
await kb.type("abc");
await kb.down("Control");
await kb.press("a");
await kb.up("Control");
await button("bold");
await sleep(250);
await snap("toolbar bold");
await clear();
await kb.type("one");
await button("bulleted");
await sleep(250);
await snap("toolbar list");
await kb.type("!");
await snap("typing after the list");
await clear();
await button("spoiler");
await sleep(250);
await snap("toolbar spoiler");
await kb.type("Secret");
await snap("spoiler header typed");
await clear();
await page.evaluate(() => {
    document.querySelector("#compose-textarea").value = "restored @**Iago** **draft**";
});
await sleep(300);
await snap("draft restored");
await clear();
await kb.type("file: ");
const input = await page.$("#compose .file_input");
await input.uploadFile("/Users/apple/develop/ykphone/zulip/var/rc/notes.txt");
await sleep(200);
await snap("uploading");
await sleep(2500);
await snap("uploaded");
const cdp = await page.createCDPSession();
await kb.type(" ");
for (const text of ["ㅎ", "하", "한"]) {
    await cdp.send("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
    });
    await sleep(60);
}
await cdp.send("Input.insertText", {text: "한"});
await sleep(100);
for (const text of ["ㄱ", "그", "글"]) {
    await cdp.send("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
    });
    await sleep(60);
}
await cdp.send("Input.insertText", {text: "글"});
await sleep(150);
await snap("hangul after an upload");
await shot(page, "t25-composer");
await kb.press("Enter");
await sleep(1800);
await snap("sent");
console.log(
    "last message",
    await page.evaluate(() => {
        const rows = document.querySelectorAll(".message_row .message_content");
        return [...rows]
            .at(-1)
            ?.innerHTML.replaceAll(
                / class="[^"]*"| data-[a-z-]+="[^"]*"| title="[^"]*"| aria-[a-z]+="[^"]*"| role="[^"]*"/g,
                "",
            )
            .slice(0, 300);
    }),
);
await browser.close();
