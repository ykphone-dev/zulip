// Phase 2: how the edit form's editor sits compared with upstream's
// textarea (the editor hidden and the textarea shown again in the same
// form), in both themes and at 1400 and 480 wide.
/* global document, getComputedStyle -- page.evaluate callbacks run in the browser */
import {BASE, OUT, sleep, start} from "./lib.mjs";

const width = Number(process.env.WIDTH ?? 1400);
const theme = process.env.THEME ?? "light";
const {browser, page} = await start({width, height: 900});

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
// 3 = light, 2 = dark; the run ends on 1, automatic (the default).
await api("PATCH", "/json/settings", {color_scheme: theme === "dark" ? "2" : "3"});
const topic = "rich edit look " + Date.now().toString(36);
const {id} = await api("POST", "/json/messages", {
    type: "stream",
    to: "errors",
    topic,
    content: "plain line one\nline two with **bold** and :smile:",
});
await page.goto(
    BASE + `/#narrow/channel/12-errors/topic/${encodeURIComponent(topic).replaceAll("%", ".")}`,
);
await sleep(4500);
const row = `.focused-message-list .message_row[data-message-id="${id}"]`;
await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({block: "center"}), row);
await page.hover(`${row} .messagebox`);
await sleep(200);
await page.evaluate(
    (sel) => document.querySelector(`${sel} .message-actions-menu-button`).click(),
    row,
);
await sleep(400);
await page.evaluate(() => document.querySelector(".popover_edit_message").click());
await sleep(900);

const measure = () =>
    page.evaluate((id) => {
        const form = document.querySelector(`#edit_form_${id}`);
        const rect = (el) => {
            if (!el) {
                return null;
            }
            const r = el.getBoundingClientRect();
            return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10);
        };
        const container = form.querySelector(".edit-content-container");
        const editor = form.querySelector(".ykphone-rich-editor");
        const ta = form.querySelector("textarea.message_edit_content");
        const shown = editor && getComputedStyle(editor).display !== "none" ? editor : ta;
        const cs = getComputedStyle(shown);
        // Where the first character is drawn.
        let first_char = null;
        if (shown === editor) {
            const text = editor.querySelector("p").firstChild;
            const range = document.createRange();
            range.setStart(text, 0);
            range.setEnd(text, 1);
            first_char = rect(range);
        }
        return {
            container: rect(container),
            shown: rect(shown),
            buttons: rect(form.querySelector(".message-edit-feature-group")),
            save: rect(form.querySelector(".message_edit_save")),
            bg: cs.backgroundColor,
            color: cs.color,
            font: `${cs.fontSize} ${cs.lineHeight} ${cs.fontFamily.slice(0, 20)}`,
            padding: getComputedStyle(
                shown === editor ? editor.querySelector(".ykphone-rich-content") : ta,
            ).padding,
            border: getComputedStyle(container).borderColor,
            first_char,
            scroll_width: document.documentElement.scrollWidth,
        };
    }, id);

const clip = async (name) => {
    const box = await page.evaluate((id) => {
        const r = document.querySelector(`#edit_form_${id}`).getBoundingClientRect();
        return {
            x: Math.max(r.left - 8, 0),
            y: Math.max(r.top - 8, 0),
            width: r.width + 16,
            height: r.height + 16,
        };
    }, id);
    await page.screenshot({path: `${OUT}/${name}.png`, clip: box});
};

const rich = await measure();
await clip(`p2-look-rich-${theme}-${width}`);
await page.screenshot({path: `${OUT}/p2-look-full-${theme}-${width}.png`});
// Upstream's textarea, in the same form.
await page.evaluate((id) => {
    const form = document.querySelector(`#edit_form_${id}`);
    form.querySelector(".ykphone-rich-editor").style.display = "none";
    form.closest(".message_edit_form").classList.remove("ykphone-rich-edit");
    const ta = form.querySelector("textarea.message_edit_content");
    ta.style.height = "";
}, id);
await sleep(300);
const upstream = await measure();
await clip(`p2-look-upstream-${theme}-${width}`);
console.log(theme, width);
console.log("rich    ", JSON.stringify(rich));
console.log("upstream", JSON.stringify(upstream));
await page.evaluate((id) => {
    const form = document.querySelector(`#edit_form_${id}`);
    form.querySelector(".message_edit_cancel").click();
}, id);
await api("PATCH", "/json/settings", {color_scheme: "1"});
await browser.close();
