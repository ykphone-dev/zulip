// The link form: Enter with a URL in the text field, Enter with an
// empty link field, Escape — and where the focus and cursor end up.
import {start, state, sleep, BASE} from "./lib.mjs";
const {browser, page} = await start({width: 1400, height: 900});
const kb = page.keyboard;
await page.goto(BASE + "/#narrow/channel/12-errors"); await sleep(3500);
await page.click(".ykphone-rich-content");
const clear = async () => { await kb.down("Control"); await kb.press("a"); await kb.up("Control"); await kb.press("Backspace"); await sleep(150); };
const ui = () => page.evaluate(() => ({
    form: !!document.querySelector(".ykphone-rich-link-form"),
    focus: document.activeElement === document.body ? "BODY" : (document.activeElement?.className?.toString().slice(0, 34)),
    caret: (() => { const ta = document.querySelector("#compose-textarea"); return [ta.selectionStart, ta.selectionEnd]; })(),
}));
const snap = async (label) => console.log("==", label, JSON.stringify((await state(page)).md), JSON.stringify(await ui()));
const ctrl_k = async () => { await kb.down("Control"); await kb.down("Shift"); await kb.press("l"); await kb.up("Shift"); await kb.up("Control"); await sleep(500); };
await clear();
await kb.type("끝 "); await sleep(200);
await ctrl_k(); await snap("ctrl+k, no selection");
await kb.type("https://www.yeopkerphone.co.kr"); await kb.press("Enter"); await sleep(500); await snap("enter with the URL in the text field");
await kb.type("다음"); await sleep(250); await snap("typing after");
// Enter with text that is not an address and an empty link field.
await clear(); await kb.type("a "); await ctrl_k();
await kb.type("just words"); await kb.press("Enter"); await sleep(400); await snap("enter with words, empty link field");
await kb.type("ex.co.kr"); await kb.press("Enter"); await sleep(500); await snap("then a bare domain in the link field");
await kb.type("!"); await sleep(200); await snap("typing after");
// Escape.
await clear(); await kb.type("b "); await ctrl_k(); await kb.type("https://ex.com"); await kb.press("Escape"); await sleep(400); await snap("escape");
await kb.type("c"); await sleep(200); await snap("typing after escape");
// Enter in the link field with a selection.
await clear(); await kb.type("zulip"); await sleep(200);
await kb.down("Shift"); for (let i = 0; i < 5; i += 1) { await kb.press("ArrowLeft"); await sleep(60); } await kb.up("Shift");
await ctrl_k(); await snap("ctrl+k over a selection");
await kb.type("zulip.com"); await kb.press("Enter"); await sleep(500); await snap("enter over a selection");
await kb.type("."); await sleep(200); await snap("typing after");
await browser.close();
