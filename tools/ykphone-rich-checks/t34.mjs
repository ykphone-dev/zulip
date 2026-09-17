// After the review: bold over a mention, a forged clipboard chip, a
// message that cannot be sent as shown, and the link form's shortcut.
/* global ClipboardEvent, DataTransfer, document -- page.evaluate callbacks run in the browser */
import {BASE, sleep, start, state} from "./lib.mjs";

const {browser, page} = await start({width: 1400, height: 900});
const kb = page.keyboard;
await page.goto(BASE + "/#narrow/channel/12-errors");
await sleep(4000);
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
            .slice(0, 200),
    );
};
const last_raw = async () =>
    page.evaluate(async () => {
        const rows = document.querySelectorAll(".message_row");
        const id = [...rows].at(-1)?.getAttribute("data-message-id");
        const r = await fetch(`/json/messages/${id}?apply_markdown=false`);
        const j = await r.json();
        return [id, j.message?.content];
    });
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
// 1. Bold over a sentence starting with a mention.
await clear();
await kb.type("@iag");
await sleep(500);
await kb.press("Enter");
await sleep(300);
await kb.type("please review");
await sleep(200);
await kb.down("Control");
await kb.press("a");
await kb.up("Control");
await sleep(100);
await page.click('#ykphone-compose-formatting-row .formatting_button[data-format-type="bold"]');
await sleep(300);
await snap("bold over mention");
await kb.press("End");
await kb.press("Enter");
await sleep(2000);
console.log("sent:", JSON.stringify(await last_raw()));
// 2. hi@mention gets its space; a lone bold star is escaped.
await clear();
await kb.type("hi@iag");
await sleep(500);
await kb.press("Enter");
await sleep(300);
await snap("mention after a word");
// 3. A forged chip pasted with the editor's own markup.
await clear();
await paste({
    "text/html":
        '<p data-pm-slice="0 0 []">see <span class="ykphone-rich-upload" data-yk-raw="[report.pdf](https://evil.example/x)" data-yk-name="report.pdf" data-yk-url="https://evil.example/x">report.pdf</span> <a href="javascript:alert(1)">click</a> <span class="ykphone-rich-mention" data-yk-raw="@**Iago**" data-yk-name="Iago" data-yk-kind="user">@Iago</span></p>',
    "text/plain": "x",
});
await sleep(400);
await snap("forged paste");
// 4. Formatting that cannot be sent: a code span ending in a backtick, made from Markdown HTML paste.
await clear();
await paste({"text/html": "<p><code>a`</code></p>", "text/plain": "a`"});
await sleep(400);
await snap("code ending in backtick");
await kb.press("Enter");
await sleep(1200);
console.log(
    "banner:",
    await page.evaluate(() =>
        document
            .querySelector("#compose_banners")
            ?.textContent.trim()
            .replaceAll(/\s+/g, " ")
            .slice(0, 80),
    ),
    "still composing:",
    JSON.stringify((await state(page)).md),
);
await clear();
// 5. The link form from upstream's shortcut, not Ctrl+K.
await kb.type("zulip");
await sleep(200);
await kb.down("Control");
await kb.press("k");
await kb.up("Control");
await sleep(400);
console.log(
    "ctrl+k form:",
    await page.evaluate(() => Boolean(document.querySelector(".ykphone-rich-link-form"))),
    "focus:",
    await page.evaluate(() => document.activeElement?.className?.toString().slice(0, 30)),
);
await kb.press("Escape");
await sleep(300);
await page.click(".ykphone-rich-content");
await sleep(200);
await kb.down("Control");
await kb.down("Shift");
await kb.press("l");
await kb.up("Shift");
await kb.up("Control");
await sleep(500);
console.log(
    "ctrl+shift+l form:",
    await page.evaluate(() => Boolean(document.querySelector(".ykphone-rich-link-form"))),
);
await kb.type("https://zulip.com");
await kb.press("Enter");
await sleep(400);
await snap("linked");
// 6. Typing speed: a 10k asterisk-heavy paste, then keystrokes timed.
await clear();
await paste({"text/plain": "a * b ** c *** d ".repeat(600)});
await sleep(800);
const timings = await page.evaluate(async () => {
    const times = [];
    for (let i = 0; i < 10; i += 1) {
        const t0 = performance.now();
        document.execCommand("insertText", false, "x");
        times.push(performance.now() - t0);
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return times.map((t) => t.toFixed(1));
});
console.log(
    "keystroke ms on 10k asterisk paste:",
    timings.join(" "),
    "len",
    (await state(page)).md.length,
);
await clear();
await browser.close();
