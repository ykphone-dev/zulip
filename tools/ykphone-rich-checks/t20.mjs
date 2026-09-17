/* global ClipboardEvent, DataTransfer, document -- page.evaluate callbacks run in the browser */
import {BASE, sleep, start, state} from "./lib.mjs";

const {browser, page} = await start();
const kb = page.keyboard;
await page.goto(BASE + "/#narrow/channel/12-errors");
await sleep(3500);
await page.click(".ykphone-rich-content");
await kb.down("Control");
await kb.press("a");
await kb.up("Control");
await kb.press("Backspace");
await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData(
        "text/html",
        '<p>Hi <span class="user-mention" data-user-id="11">@Iago</span> see <a class="stream" data-stream-id="3" href="/#narrow/channel/3-Verona">#Verona</a> <span aria-label="smile" class="emoji emoji-1f604" role="img" title="smile">:smile:</span></p>',
    );
    dt.setData("text/plain", "Hi @Iago see #Verona :smile:");
    document
        .querySelector(".ProseMirror")
        .dispatchEvent(
            new ClipboardEvent("paste", {clipboardData: dt, bubbles: true, cancelable: true}),
        );
});
await sleep(400);
const s = await state(page);
console.log(JSON.stringify(s.md));
console.log(s.html);
await browser.close();
