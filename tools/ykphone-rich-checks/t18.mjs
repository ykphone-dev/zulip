import {start, state, shot, sleep, BASE} from "./lib.mjs";
const {browser, page} = await start();
const kb = page.keyboard;
await page.goto(BASE + "/#narrow/channel/12-errors");
await sleep(3500);
await page.click(".ykphone-rich-content");
await kb.down("Control"); await kb.press("a"); await kb.up("Control"); await kb.press("Backspace");
const cdp = await page.createCDPSession();
const events = [];
await page.exposeFunction("__ev", (e) => events.push(e));
await page.evaluate(() => { const pm = document.querySelector(".ProseMirror"); for (const t of ["compositionstart", "compositionupdate", "compositionend"]) pm.addEventListener(t, (e) => window.__ev(t + ":" + e.data)); });
const compose = async (steps, commit) => {
  for (const text of steps) { await cdp.send("Input.imeSetComposition", {text, selectionStart: text.length, selectionEnd: text.length}); await sleep(60); }
  if (commit !== undefined) { await cdp.send("Input.insertText", {text: commit}); await sleep(80); }
};
const snap = async (label) => { const s = await state(page); console.log("==", label, JSON.stringify(s.md), s.sel, s.html.replace(/ class="[^"]*"| contenteditable="false"| data-[a-z-]+="[^"]*"/g, "").slice(0, 160)); };
await compose(["ㅎ", "하"]); await snap("mid-syllable 하 (composing)");
await compose(["한"], "한"); await snap("committed 한");
await compose(["ㄱ", "그", "글"], "글"); await snap("committed 한글");
// backspace through a composed syllable: compose 닭 then delete jamo by jamo
await kb.type(" ");
await compose(["ㄷ", "다", "닭"]); await snap("composing 닭");
await compose(["달", "다", "ㄷ", ""]); await snap("backspaced through composition");
await cdp.send("Input.insertText", {text: ""}); await sleep(80);
await kb.press("Backspace"); await sleep(80); await snap("native backspace after");
// Hangul right after a chip
await kb.type(" @iag"); await sleep(400); await kb.press("Enter"); await sleep(300); await snap("mention chip");
await kb.press("Backspace"); await sleep(100); // remove trailing space after chip
await compose(["ㅇ", "아", "안"], "안"); await compose(["ㄴ", "녀", "녕"], "녕"); await snap("hangul right after chip");
// bold typing with IME
await kb.down("Control"); await kb.press("b"); await kb.up("Control"); await sleep(100);
await compose(["ㄱ", "구", "굵"], "굵"); await compose(["ㄱ", "게"], "게"); await snap("bold hangul");
// Korean with typeahead: @ then hangul composing
await kb.down("Control"); await kb.press("b"); await kb.up("Control");
await kb.type(" #"); await compose(["ㅈ", "조", "졸"]); await sleep(300);
console.log("typeahead during composition", await page.evaluate(() => [...document.querySelectorAll(".ykphone-rich-typeahead li")].slice(0,3).map((li) => li.textContent.trim().slice(0,20))));
await compose(["조", "조ㄹ", "조리"], "조리"); await sleep(300);
console.log("typeahead after commit", await page.evaluate(() => [...document.querySelectorAll(".ykphone-rich-typeahead li")].slice(0,3).map((li) => li.textContent.trim().slice(0,20))));
await kb.press("Enter"); await sleep(300); await snap("korean channel chip");
console.log(events.join(" | ").slice(0, 600));
await shot(page, "t18-ime");
await kb.press("Enter"); await sleep(1500); await snap("sent");
await browser.close();
