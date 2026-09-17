// Phase 2: the message edit form's rich editor. A message with bold, a
// link, a mention, an emoji and an upload is edited and saved and its raw
// content fetched back; two forms at once; cancel; uploads; a formatting
// that cannot be saved; the length limit; view source; a re-render while
// editing; Korean IME.
/* global ClipboardEvent, DataTransfer, document -- page.evaluate callbacks run in the browser */
import fs from "node:fs";

import {BASE, shot, sleep, start} from "./lib.mjs";

const {browser, page} = await start({width: 1400, height: 900});
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
const raw = async (id) =>
    (await api("GET", `/json/messages/${id}?apply_markdown=false`)).message.content;
const othello_send = async (content) => {
    const key = fs.readFileSync("/tmp/othello_key", "utf8").trim();
    const r = await fetch("http://localhost:9991/api/v1/messages", {
        method: "POST",
        headers: {
            Authorization: "Basic " + Buffer.from(`othello@zulip.com:${key}`).toString("base64"),
        },
        body: new URLSearchParams({type: "stream", to: "errors", topic, content}),
    });
    return (await r.json()).id;
};

const upload_uri = await page.evaluate(async () => {
    const csrf = document.querySelector("input[name=csrfmiddlewaretoken]")?.value;
    const form = new FormData();
    form.append("file", new File(["phase 2 upload"], "p2-note.txt", {type: "text/plain"}));
    const r = await fetch("/json/user_uploads", {
        method: "POST",
        body: form,
        headers: {"X-CSRFToken": csrf},
    });
    return (await r.json()).url;
});
const original = `edit **굵게** [링크](https://zulip.com) @**Othello, the Moor of Venice** :smile: [p2-note.txt](${upload_uri})`;
const topic = "rich edit p2 " + Date.now().toString(36);
const send = async (content) =>
    (await api("POST", "/json/messages", {type: "stream", to: "errors", topic, content})).id;
const first = await send(original);
const second = await send("second *message* :tada:");
console.log("sent", first, second);

await page.goto(
    BASE + `/#narrow/channel/12-errors/topic/${encodeURIComponent(topic).replaceAll("%", ".")}`,
);
await sleep(4000);

const row = (id) => `.focused-message-list .message_row[data-message-id="${id}"]`;
async function open_edit(id) {
    await page.evaluate(
        (sel) => document.querySelector(sel).scrollIntoView({block: "center"}),
        row(id),
    );
    await page.hover(`${row(id)} .messagebox`);
    await sleep(200);
    await page.evaluate(
        (sel) => document.querySelector(`${sel} .message-actions-menu-button`).click(),
        row(id),
    );
    await sleep(400);
    await page.evaluate(() =>
        document.querySelector(".popover_edit_message, .popover_view_source").click(),
    );
    await sleep(700);
}
const form_state = (id) =>
    page.evaluate((id) => {
        const form = document.querySelector(`#edit_form_${id}`);
        if (!form) {
            return null;
        }
        const ta = form.querySelector("textarea.message_edit_content");
        const pm = form.querySelector(".ykphone-rich-content");
        return {
            md: ta.value,
            // innerText: the text as shown, which is what the check is about.
            // eslint-disable-next-line unicorn/prefer-dom-node-text-content
            text: pm?.innerText,
            chips: [
                ...(pm?.querySelectorAll(".ykphone-rich-chip, .ykphone-rich-upload") ?? []),
            ].map((c) => c.className.replaceAll("ykphone-rich-", "").replace("chip ", "")),
            strong: pm?.querySelector("strong")?.textContent,
            link: pm?.querySelector("a")?.getAttribute("href"),
            editable: pm?.getAttribute("contenteditable"),
            editor_focused: document.activeElement === pm,
            editors: document.querySelectorAll(".message_edit_form .ykphone-rich-editor").length,
            root_classes: form.querySelector(".ykphone-rich-editor")?.className,
        };
    }, id);
const click_end = async (id) => {
    await page.click(`#edit_form_${id} .ykphone-rich-content`);
    await kb.down("Control");
    await kb.press("End");
    await kb.up("Control");
    await sleep(100);
};
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

// A. What the form shows, then a Korean IME edit with bold, saved with Enter.
await open_edit(first);
let s = await form_state(first);
console.log("A open:", JSON.stringify(s));
console.log(
    "A no syntax visible:",
    !/\*\*|\]\(|@\*\*|user_uploads/u.test(s.text),
    "chips:",
    s.chips.join(","),
);
await shot(page, "p2-edit-light");
await click_end(first);
await kb.type(" ");
await ime(["ㅅ", "수", "숮", "수정"], "수정");
await kb.down("Control");
await kb.press("b");
await kb.up("Control");
await kb.type("bold");
await kb.down("Control");
await kb.press("b");
await kb.up("Control");
await kb.down("Shift");
await kb.press("Enter");
await kb.up("Shift");
await kb.type("line2");
s = await form_state(first);
console.log("A typed md:", JSON.stringify(s.md));
await kb.press("Enter");
await sleep(2000);
const a_raw = await raw(first);
console.log("A saved raw:", JSON.stringify(a_raw));
console.log(
    "A identical to intent:",
    a_raw === original + " 수정**bold**\nline2",
    "form closed:",
    (await form_state(first)) === null,
);

// B. Two forms at once; typing in each; Escape cancels one, Save saves the other.
await open_edit(second);
await open_edit(first);
s = await form_state(first);
console.log("B editors open:", s.editors);
await click_end(second);
await kb.type(" 두번째");
await click_end(first);
await kb.type(" 첫번째");
console.log(
    "B mds:",
    JSON.stringify((await form_state(first)).md.slice(-12)),
    JSON.stringify((await form_state(second)).md),
);
await kb.press("Escape");
await sleep(600);
console.log(
    "B first form after Escape:",
    await form_state(first),
    "second still open:",
    (await form_state(second))?.editors,
);
await page.click(`#edit_form_${second} .message_edit_save`);
await sleep(2000);
console.log(
    "B raws:",
    JSON.stringify(await raw(first)) === JSON.stringify(a_raw),
    JSON.stringify(await raw(second)),
);

// C. An upload into the edit form.
fs.writeFileSync("/tmp/p2-upload.txt", "uploaded into the edit form\n");
await open_edit(second);
const file_input = await page.$(`#edit_form_${second} input.file_input`);
await click_end(second);
await kb.type(" 파일 ");
await file_input.uploadFile("/tmp/p2-upload.txt");
await sleep(2500);
s = await form_state(second);
console.log("C after upload:", JSON.stringify(s.md), s.chips.join(","));
await page.click(`#edit_form_${second} .ykphone-rich-content`);
await kb.down("Control");
await kb.press("End");
await kb.up("Control");
await kb.press("Enter");
await sleep(2000);
console.log("C saved raw:", JSON.stringify(await raw(second)));

// D. Formatting that cannot be written as Markdown is not saved.
await open_edit(second);
await click_end(second);
await page.evaluate((id) => {
    const dt = new DataTransfer();
    dt.setData("text/html", "<p><code>a`</code></p>");
    dt.setData("text/plain", "a`");
    document
        .querySelector(`#edit_form_${id} .ProseMirror`)
        .dispatchEvent(
            new ClipboardEvent("paste", {clipboardData: dt, bubbles: true, cancelable: true}),
        );
}, second);
await sleep(300);
const before_d = await raw(second);
await page.click(`#edit_form_${second} .message_edit_save`);
await sleep(1200);
console.log(
    "D banner:",
    await page.evaluate(
        (id) => document.querySelector(`#edit_form_${id} .edit_form_banners`)?.textContent.trim(),
        second,
    ),
    "unchanged:",
    (await raw(second)) === before_d,
    "form open:",
    (await form_state(second)) !== null,
);
await page.click(`#edit_form_${second} .ykphone-rich-content`);
await kb.press("Enter");
await sleep(1000);
console.log(
    "D Enter also refused:",
    (await raw(second)) === before_d,
    "form open:",
    (await form_state(second)) !== null,
);
await page.evaluate(
    (id) =>
        document
            .querySelector(`#edit_form_${id} .message_edit_cancel`)
            .scrollIntoView({block: "center"}),
    second,
);
await page.click(`#edit_form_${second} .message_edit_cancel`);
await sleep(500);
console.log("D cancelled:", (await form_state(second)) === null);

// E. The length limit.
await open_edit(second);
await page.evaluate((id) => {
    const ta = document.querySelector(`#edit_form_${id} textarea.message_edit_content`);
    ta.value = "x".repeat(10050);
    ta.dispatchEvent(new Event("input", {bubbles: true}));
}, second);
await sleep(500);
s = await form_state(second);
console.log("E over limit class:", s.root_classes, "doc length:", s.md.length);
await page.click(`#edit_form_${second} .ykphone-rich-content`);
await kb.press("Enter");
await sleep(1000);
console.log(
    "E not saved:",
    (await raw(second)).length < 10000,
    "form open:",
    (await form_state(second)) !== null,
);
await shot(page, "p2-edit-over-limit");
await page.evaluate(
    (id) =>
        document
            .querySelector(`#edit_form_${id} .message_edit_cancel`)
            .scrollIntoView({block: "center"}),
    second,
);
await page.click(`#edit_form_${second} .message_edit_cancel`);
await sleep(500);
console.log("E cancelled:", (await form_state(second)) === null);

// F. View source of somebody else's message: read-only, no syntax.
const othello_id = await othello_send(
    "othello **source** [docs](https://zulip.com/help) :octopus:",
);
await sleep(3500);
await open_edit(othello_id);
s = await form_state(othello_id);
console.log("F view source:", JSON.stringify(s));
console.log(
    "F copy button:",
    await page.evaluate(
        (id) => Boolean(document.querySelector(`#edit_form_${id} .copy_message`)),
        othello_id,
    ),
    "focus on close:",
    await page.evaluate(() => document.activeElement?.className),
);
await shot(page, "p2-view-source");
await page.evaluate(
    (id) =>
        document
            .querySelector(`#edit_form_${id} .message_edit_close`)
            .scrollIntoView({block: "center"}),
    othello_id,
);
await page.click(`#edit_form_${othello_id} .message_edit_close`);
await sleep(500);

// G. A message arriving while a form is open re-renders the feed: the
// draft and the focus stay.
await open_edit(first);
await click_end(first);
await kb.type(" 계속");
const typed_md = (await form_state(first)).md;
await othello_send("a message while editing");
await sleep(2500);
s = await form_state(first);
console.log(
    "G after new message:",
    s.md === typed_md,
    "editor focused:",
    s.editor_focused,
    "editors:",
    s.editors,
);
await kb.type("!");
console.log("G typing continues:", JSON.stringify((await form_state(first)).md.slice(-5)));
await kb.press("Escape");
await sleep(400);
console.log(
    "G editors left outside the compose box:",
    await page.evaluate(() =>
        [...document.querySelectorAll(".ykphone-rich-editor")]
            .filter((e) => !e.closest("#compose"))
            .map((e) => [
                e.closest(".message_row")?.dataset.messageId,
                e.closest(".message-list")?.className,
                e.closest(".message_edit_form") !== null,
            ]),
    ),
);

await browser.close();
