// A fresh page load into a conversation, with and without a restored
// draft: the editor must have the focus, with the caret at the end.
/* global document, getSelection -- page.evaluate callbacks run in the browser */
import {BASE, sleep, start} from "./lib.mjs";

const {browser, page} = await start({width: 1400, height: 900});
const kb = page.keyboard;
const who = (label) =>
    page.evaluate((label) => {
        const el = document.activeElement;
        const ta = document.querySelector("#compose-textarea");
        const pm = document.querySelector(".ykphone-rich-content");
        const s = getSelection();
        const in_editor = pm !== null && s.anchorNode !== null && pm.contains(s.anchorNode);
        return `${label}: focus=${el === document.body ? "BODY" : el === pm ? "EDITOR" : el?.tagName + "." + el?.className?.toString().slice(0, 24)} md=${JSON.stringify(ta?.value ?? null)} ta.sel=${ta?.selectionStart} caret_in_editor=${in_editor}`;
    }, label);
const URL = BASE + "/?rc=3#narrow/channel/12-errors/topic/";
const sequence = async (label) => {
    await kb.type("링크 확인 ");
    await sleep(300);
    console.log(await who(label + " typed"));
    await kb.down("Control");
    await kb.down("Shift");
    await kb.press("l");
    await kb.up("Shift");
    await kb.up("Control");
    await sleep(500);
    console.log(
        "form open:",
        await page.evaluate(() => Boolean(document.querySelector(".ykphone-rich-link-form"))),
    );
    await kb.type("https://www.yeopkerphone.co.kr");
    await kb.press("Enter");
    await sleep(500);
    console.log(await who(label + " after link"));
    await kb.type(" @oth");
    await sleep(700);
    console.log(
        "typeahead:",
        await page.evaluate(() =>
            [...document.querySelectorAll(".ykphone-rich-typeahead li")]
                .slice(0, 2)
                .map((li) => li.textContent.trim().replaceAll(/\s+/g, " ").slice(0, 30)),
        ),
    );
    await kb.press("Enter");
    await sleep(400);
    console.log(await who(label + " after mention"));
    await kb.press("Enter");
    await sleep(2500);
    console.log(await who(label + " after send"));
    const id = await page.evaluate(() => {
        const rows = document.querySelectorAll(".message_row");
        return [...rows].at(-1)?.getAttribute("data-message-id") ?? [...rows].at(-1)?.id;
    });
    const raw = await page.evaluate(async (id) => {
        const r = await fetch(`/json/messages/${id}?apply_markdown=false`);
        const j = await r.json();
        return [j.result, j.message?.content];
    }, id);
    console.log(label, "sent message", id, "raw:", JSON.stringify(raw));
};
await page.goto(URL, {waitUntil: "networkidle2"});
await sleep(10000);
console.log(await who("load, no draft (10s)"));
await sequence("no draft:");
// A draft, then a full reload.
await kb.type("가나다 굵게 **볼드** 끝 ");
await sleep(2500);
await page.goto(URL, {waitUntil: "networkidle2"});
await sleep(10000);
console.log(await who("reload with draft (10s)"));
await sequence("draft:");
await browser.close();
