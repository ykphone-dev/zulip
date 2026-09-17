// Phase 2: the edit form's toolbar reaches its own editor: bold, the
// link form, a bulleted list (upstream's Markdown) and the emoji picker;
// with two forms open, only the form whose button was used changes.
// Preview mode hides the editor.
/* global document, getComputedStyle -- page.evaluate callbacks run in the browser */
import {BASE, shot, sleep, start} from "./lib.mjs";

const {browser, page} = await start({width: 1400, height: 900});
const kb = page.keyboard;
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
const topic = "rich toolbar p2 " + Date.now().toString(36);
const a = (
    await api("POST", "/json/messages", {
        type: "stream",
        to: "errors",
        topic,
        content: "alpha word",
    })
).id;
const b = (
    await api("POST", "/json/messages", {type: "stream", to: "errors", topic, content: "beta word"})
).id;
await page.goto(
    BASE + `/#narrow/channel/12-errors/topic/${encodeURIComponent(topic).replaceAll("%", ".")}`,
);
await sleep(4500);

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
    await page.evaluate(() => document.querySelector(".popover_edit_message").click());
    await sleep(700);
}
const md = (id) =>
    page.evaluate(
        (id) => document.querySelector(`#edit_form_${id} textarea.message_edit_content`)?.value,
        id,
    );
const html = (id) =>
    page.evaluate(
        (id) =>
            document
                .querySelector(`#edit_form_${id} .ykphone-rich-content`)
                ?.innerHTML.replaceAll(
                    / (class|contenteditable|data-[a-z-]+|title|aria-[a-z]+|role|rel)="[^"]*"/g,
                    "",
                )
                .slice(0, 200),
        id,
    );
const button = (id, selector) =>
    page.evaluate(
        ({id, selector}) => {
            const el = document.querySelector(`#edit_form_${id} ${selector}`);
            el.scrollIntoView({block: "center"});
            return Boolean(el);
        },
        {id, selector},
    );

await open_edit(a);
await open_edit(b);
// Select "word" in form B and make it bold with the toolbar button.
await page.click(`#edit_form_${b} .ykphone-rich-content`);
await kb.press("End");
for (let i = 0; i < 4; i += 1) {
    await kb.down("Shift");
    await kb.press("ArrowLeft");
    await kb.up("Shift");
}
await button(b, '.formatting_button[data-format-type="bold"]');
await page.click(`#edit_form_${b} .formatting_button[data-format-type="bold"]`);
await sleep(300);
console.log(
    "bold button:",
    JSON.stringify(await md(b)),
    "other form:",
    JSON.stringify(await md(a)),
);

// The link form from the toolbar, over form B.
await kb.press("End");
await kb.type(" ");
await page.click(`#edit_form_${b} .formatting_button[data-format-type="link"]`);
await sleep(500);
console.log(
    "link form open:",
    await page.evaluate(() => Boolean(document.querySelector(".ykphone-rich-link-form"))),
    "focus:",
    await page.evaluate(() => document.activeElement?.className),
);
await kb.type("zulip.com");
await kb.press("Enter");
await sleep(400);
console.log("link:", JSON.stringify(await md(b)), await html(b));

// A bulleted list: upstream's Markdown on the textarea, shown by the sync.
await page.click(`#edit_form_${a} .ykphone-rich-content`);
await kb.press("End");
await page.click(`#edit_form_${a} .formatting_button[data-format-type="bulleted"]`);
await sleep(400);
console.log(
    "bulleted:",
    JSON.stringify(await md(a)),
    await html(a),
    "focus in A:",
    await page.evaluate(
        (id) => document.activeElement === document.querySelector(`#edit_form_${id} .ProseMirror`),
        a,
    ),
);

// The emoji picker inserts a chip in form A.
await kb.press("End");
await page.click(`#edit_form_${a} .emoji_map`);
await sleep(700);
await kb.type("tada");
await sleep(500);
await kb.press("Enter");
await sleep(500);
console.log(
    "emoji:",
    JSON.stringify(await md(a)),
    "focus in A:",
    await page.evaluate(
        (id) => document.activeElement === document.querySelector(`#edit_form_${id} .ProseMirror`),
        a,
    ),
);
await shot(page, "p2-edit-toolbar");

// Preview mode shows the rendered message instead of the editor, and
// leaving it brings the editor back.
await page.click(`#edit_form_${a} .markdown_preview`);
await sleep(1200);
const preview_state = () =>
    page.evaluate((id) => {
        const form = document.querySelector(`#edit_form_${id}`);
        const box = form.querySelector(".message-edit-textbox").getBoundingClientRect();
        return {
            textbox_height: Math.round(box.height),
            preview: form.querySelector(".preview_content")?.textContent.trim().slice(0, 30),
            preview_shown: getComputedStyle(form.querySelector(".preview_message_area")).display,
        };
    }, a);
console.log("preview:", JSON.stringify(await preview_state()));
await shot(page, "p2-edit-preview");
await page.click(`#edit_form_${a} .undo_markdown_preview`);
await sleep(500);
console.log("preview closed:", JSON.stringify(await preview_state()));

// Saving both.
await page.click(`#edit_form_${a} .message_edit_save`);
await sleep(1500);
await page.click(`#edit_form_${b} .message_edit_save`);
await sleep(1500);
const raw = async (id) =>
    (await api("GET", `/json/messages/${id}?apply_markdown=false`)).message.content;
console.log("saved A:", JSON.stringify(await raw(a)));
console.log("saved B:", JSON.stringify(await raw(b)));
await browser.close();
