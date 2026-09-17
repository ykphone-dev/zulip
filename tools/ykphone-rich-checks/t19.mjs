/* global ClipboardEvent, DataTransfer, document -- page.evaluate callbacks run in the browser */
import fs from "node:fs";

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
    await sleep(100);
};
const snap = async (label) => {
    const s = await state(page);
    console.log(
        "==",
        label,
        JSON.stringify(s.md),
        "|",
        s.html
            .replaceAll(
                / class="[^"]*"| contenteditable="false"| data-[a-z-]+="[^"]*"| title="[^"]*"| aria-[a-z]+="[^"]*"| role="[^"]*"| rel="[^"]*"/g,
                "",
            )
            .slice(0, 300),
    );
};
const paste = (data) =>
    page.evaluate((data) => {
        const dt = new DataTransfer();
        for (const [type, value] of Object.entries(data)) {
            dt.setData(type, value);
        }
        document
            .querySelector(".ProseMirror")
            .dispatchEvent(
                new ClipboardEvent("paste", {clipboardData: dt, bubbles: true, cancelable: true}),
            );
    }, data);
await clear();
await paste({
    "text/plain":
        "Use **not bold** and *x* and `code` @**Iago** #**Verona** :smile: <time:2024-01-01> [a](http://b.c)\n- not a list\n# not heading\n> not quote\n```\nnot code\n```",
});
await sleep(300);
await snap("plain text paste");
await kb.press("Enter");
await sleep(1500);
console.log("sent literal");
await clear();
await paste({
    "text/html":
        "<meta charset='utf-8'><p>Rich <b>bold</b> and <i>italic</i> and <a href='https://zulip.com'>a link</a> with **stars**</p><ul><li>one</li><li>two</li></ul><table><tr><td>cell</td></tr></table><img src='x.png'>",
    "text/plain": "Rich bold and italic and a link with **stars**\none\ntwo\ncell",
});
await sleep(300);
await snap("html paste");
await kb.press("Enter");
await sleep(1500);
await clear();
// Zulip message HTML
await paste({
    "text/html":
        '<p>Hi <span class="user-mention" data-user-id="11">@Iago</span> see <a class="stream" data-stream-id="3" href="/#narrow/channel/3-Verona">#Verona</a> <span aria-label="smile" class="emoji emoji-1f604" role="img" title="smile">:smile:</span></p>',
    "text/plain": "Hi @Iago see #Verona :smile:",
});
await sleep(300);
await snap("zulip html paste");
await clear();
await kb.type("select me");
await kb.down("Shift");
for (let i = 0; i < 2; i += 1) {
    await kb.press("ArrowLeft");
}
await kb.up("Shift");
await sleep(100);
await paste({"text/plain": "https://example.com/page"});
await sleep(300);
await snap("url over selection");
await clear();
// image paste
const png = fs
    .readFileSync("/Users/apple/develop/ykphone/zulip/var/rc/sample.png")
    .toString("base64");
await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.codePointAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "pasted.png", {type: "image/png"}));
    document
        .querySelector(".ProseMirror")
        .dispatchEvent(
            new ClipboardEvent("paste", {clipboardData: dt, bubbles: true, cancelable: true}),
        );
}, png);
await sleep(3000);
await snap("image paste");
await kb.press("Enter");
await sleep(1500);
await browser.close();
