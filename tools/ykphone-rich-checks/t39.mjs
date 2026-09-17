// Phase 2: the thread panel's reply box. A reply with bold, a mention
// chosen from the typeahead, Korean IME and a second line is sent with
// Enter and its raw content fetched back; a formatting that cannot be sent
// is refused; the box is compared with the textarea it covers.
/* global ClipboardEvent, DataTransfer, document, getComputedStyle -- page.evaluate callbacks run in the browser */
import {BASE, OUT, sleep, start} from "./lib.mjs";

const width = Number(process.env.WIDTH ?? 1400);
const theme = process.env.THEME ?? "light";
const {browser, page} = await start({width, height: 900});
const kb = page.keyboard;
const cdp = await page.createCDPSession();

const api = (method, url, data) =>
    page.evaluate(
        async ({method, url, data}) => {
            const csrf = document.querySelector("input[name=csrfmiddlewaretoken]")?.value;
            const body = data === undefined ? undefined : new URLSearchParams(data);
            const r = await fetch(url, {method, body, headers: {"X-CSRFToken": csrf}});
            return r.json();
        },
        {method, url, data},
    );
await api("PATCH", "/json/settings", {color_scheme: theme === "dark" ? "2" : "3"});
const {id: root_id} = await api("POST", "/json/messages", {
    type: "stream",
    to: "errors",
    topic: "",
    content: "스레드 루트 " + Date.now().toString(36),
});
await page.goto(BASE + "/#narrow/channel/12-errors/topic/");
await sleep(4500);
const row = `.focused-message-list .message_row[data-message-id="${root_id}"]`;
await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({block: "center"}), row);
await page.hover(`${row} .messagebox`);
await sleep(300);
await page.evaluate((sel) => document.querySelector(`${sel} .ykphone-thread-button`).click(), row);
await sleep(2500);

const panel = () =>
    page.evaluate(() => {
        const ta = document.querySelector(".ykphone-thread-panel-textarea");
        const pm = document.querySelector(".ykphone-thread-panel-composer .ykphone-rich-content");
        return {
            md: ta?.value,
            html: pm?.innerHTML
                .replaceAll(
                    / (class|contenteditable|data-[a-z-]+|title|aria-[a-z]+|role)="[^"]*"/g,
                    "",
                )
                .slice(0, 160),
            focused: document.activeElement === pm,
            error: document.querySelector(".ykphone-thread-panel-send-error")?.textContent,
        };
    });
console.log("open:", JSON.stringify(await panel()));

const ime = async (steps, commit) => {
    for (const text of steps) {
        await cdp.send("Input.imeSetComposition", {
            text,
            selectionStart: text.length,
            selectionEnd: text.length,
        });
        await sleep(60);
    }
    await cdp.send("Input.insertText", {text: commit});
    await sleep(100);
};
if (width > 900) {
    await ime(["ㄷ", "다", "답", "답자", "답장"], "답장");
    await kb.type(" ");
    await kb.down("Control");
    await kb.press("b");
    await kb.up("Control");
    await kb.type("굵게");
    await kb.down("Control");
    await kb.press("b");
    await kb.up("Control");
    await kb.type(" @oth");
    await sleep(600);
    console.log(
        "typeahead:",
        await page.evaluate(() =>
            [...document.querySelectorAll(".ykphone-rich-typeahead li")]
                .map((li) => li.textContent.trim().slice(0, 30))
                .slice(0, 3),
        ),
    );
    await kb.press("Enter");
    await sleep(300);
    await kb.down("Shift");
    await kb.press("Enter");
    await kb.up("Shift");
    await kb.type("둘째 줄 :smile:");
    await sleep(300);
    const typed = await panel();
    console.log("typed:", JSON.stringify(typed));
    await kb.press("Enter");
    await sleep(2500);
    const thread_topic = await page.evaluate(() =>
        document.querySelector(".ykphone-thread-panel-full-view")?.getAttribute("href"),
    );
    const last = await page.evaluate(async () => {
        const ids = [...document.querySelectorAll(".ykphone-thread-panel-message")].map((m) =>
            Number(m.dataset.messageId),
        );
        const id = Math.max(...ids);
        const r = await fetch(`/json/messages/${id}?apply_markdown=false`);
        return [id, (await r.json()).message.content];
    });
    console.log("sent:", JSON.stringify(last), thread_topic);
    console.log(
        "identical to intent:",
        last[1] === "답장 **굵게** @**Othello, the Moor of Venice** \n둘째 줄 :smile:",
        "box cleared:",
        JSON.stringify((await panel()).md),
    );

    // Formatting that cannot be sent.
    await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData("text/html", "<p><code>a`</code></p>");
        dt.setData("text/plain", "a`");
        document
            .querySelector(".ykphone-thread-panel-composer .ProseMirror")
            .dispatchEvent(
                new ClipboardEvent("paste", {clipboardData: dt, bubbles: true, cancelable: true}),
            );
    });
    await sleep(300);
    await kb.press("Enter");
    await sleep(800);
    console.log("lossy refused:", JSON.stringify(await panel()));
    await page.click(".ykphone-thread-panel-send");
    await sleep(800);
    console.log("send button refused too:", JSON.stringify((await panel()).md));
    await page.click(".ykphone-thread-panel-composer .ykphone-rich-content");
    await kb.down("Control");
    await kb.press("a");
    await kb.up("Control");
    await kb.press("Backspace");
    await kb.type("ok");
    await sleep(300);
    console.log("error cleared once sendable:", JSON.stringify(await panel()));
    await kb.down("Control");
    await kb.press("a");
    await kb.up("Control");
    await kb.press("Backspace");
}

// Look: the editor against the textarea it covers.
const measure = () =>
    page.evaluate(() => {
        const composer = document.querySelector(".ykphone-thread-panel-composer");
        const editor = composer.querySelector(".ykphone-rich-editor");
        const ta = composer.querySelector("textarea");
        const shown = editor && getComputedStyle(editor).display !== "none" ? editor : ta;
        const r = shown.getBoundingClientRect();
        const cs = getComputedStyle(shown);
        return {
            rect: [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10),
            border: `${cs.borderTopWidth} ${cs.borderTopColor} ${cs.borderRadius}`,
            bg: cs.backgroundColor,
            send: (() => {
                const b = composer
                    .querySelector(".ykphone-thread-panel-send")
                    .getBoundingClientRect();
                return [b.left, b.top].map((value) => Math.round(value));
            })(),
            scroll_width: document.documentElement.scrollWidth,
        };
    });
const clip = async (name) => {
    const box = await page.evaluate(() => {
        const r = document.querySelector(".ykphone-thread-panel-composer").getBoundingClientRect();
        return {x: r.left, y: r.top, width: r.width, height: r.height};
    });
    await page.screenshot({path: `${OUT}/${name}.png`, clip: box});
};
await page.click(".ykphone-thread-panel-composer .ykphone-rich-content");
await sleep(200);
const rich = await measure();
await clip(`p2-thread-rich-${theme}-${width}`);
await page.screenshot({path: `${OUT}/p2-thread-full-${theme}-${width}.png`});
await page.evaluate(() => {
    const composer = document.querySelector(".ykphone-thread-panel-composer");
    composer.querySelector(".ykphone-rich-editor").style.display = "none";
    composer.classList.remove("ykphone-rich-thread-reply");
    composer.querySelector("textarea").focus();
});
await sleep(300);
const upstream = await measure();
await clip(`p2-thread-textarea-${theme}-${width}`);
console.log(
    theme,
    width,
    "\nrich    ",
    JSON.stringify(rich),
    "\ntextarea",
    JSON.stringify(upstream),
);
await api("PATCH", "/json/settings", {color_scheme: "1"});
await browser.close();
