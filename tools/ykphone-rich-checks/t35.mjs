// Probes after the review: what a forged paste leaves in the DOM, the
// send-blocking banner's timing, and keystroke cost on a 10k paste.
import {start, state, sleep, BASE} from "./lib.mjs";
const {browser, page} = await start({width: 1400, height: 900});
const kb = page.keyboard;
await page.goto(BASE + "/#narrow/channel/12-errors"); await sleep(4000);
await page.click(".ykphone-rich-content");
const clear = async () => { await kb.down("Control"); await kb.press("a"); await kb.up("Control"); await kb.press("Backspace"); await sleep(150); };
const paste = (data) => page.evaluate((data) => { const dt = new DataTransfer(); for (const [type, value] of Object.entries(data)) dt.setData(type, value); document.querySelector(".ProseMirror").dispatchEvent(new ClipboardEvent("paste", {clipboardData: dt, bubbles: true, cancelable: true})); }, data);
await clear();
await paste({"text/html": '<p data-pm-slice="0 0 []">see <span class="ykphone-rich-upload" data-yk-raw="[report.pdf](https://evil.example/x)" data-yk-name="report.pdf" data-yk-url="https://evil.example/x">report.pdf</span></p>', "text/plain": "x"});
await sleep(400);
console.log("forged upload dom:", await page.evaluate(() => document.querySelector(".ProseMirror").innerHTML.replace(/ class="[^"]*"| contenteditable="false"/g, "").slice(0, 300)));
await clear();
await paste({"text/html": '<p data-pm-slice="0 0 []">a <span class="ykphone-rich-mention" data-yk-raw="@**Iago**" data-yk-name="Iago" data-yk-kind="user">@Iago</span></p>', "text/plain": "x"});
await sleep(400);
console.log("mention dom:", await page.evaluate(() => document.querySelector(".ProseMirror").innerHTML.replace(/ class="[^"]*"| contenteditable="false"/g, "").slice(0, 300)));
await clear();
await paste({"text/html": '<p>a <a href="javascript:alert(1)">click</a></p>', "text/plain": "x"});
await sleep(400);
console.log("js link dom:", await page.evaluate(() => document.querySelector(".ProseMirror").innerHTML.replace(/ class="[^"]*"| contenteditable="false"/g, "").slice(0, 300)));
// Send-blocking banner timing.
await clear();
await paste({"text/html": '<p><code>a`</code></p>', "text/plain": "a`"}); await sleep(300);
await kb.press("Enter");
for (const wait of [50, 300, 1200]) { await sleep(wait); console.log(`banner after +${wait}ms:`, JSON.stringify(await page.evaluate(() => document.querySelector("#compose_banners")?.textContent.trim().replace(/\s+/g, " ").slice(0, 80))), "send button disabled:", await page.evaluate(() => document.querySelector("#compose-send-button")?.disabled ?? document.querySelector("#compose-send-button")?.className.includes("disabled"))); }
await page.click("#compose-send-button").catch(() => {}); await sleep(600);
console.log("after clicking send:", JSON.stringify(await page.evaluate(() => document.querySelector("#compose_banners")?.textContent.trim().replace(/\s+/g, " ").slice(0, 80))), "md:", JSON.stringify((await state(page)).md));
await clear();
// Keystrokes on a 10k asterisk-heavy text set through the textarea (as a draft restore does).
await page.evaluate(() => { document.querySelector("#compose-textarea").value = "a * b ** c *** d ".repeat(600); });
await sleep(500);
console.log("doc length:", (await state(page)).md.length);
await page.evaluate(() => { const pm = document.querySelector(".ProseMirror"); pm.focus(); const s = getSelection(); s.selectAllChildren(pm); s.collapseToEnd(); });
const timings = await page.evaluate(async () => {
    const times = [];
    for (let i = 0; i < 12; i += 1) {
        const t0 = performance.now();
        document.execCommand("insertText", false, "x");
        times.push(performance.now() - t0);
        await new Promise((r) => setTimeout(r, i % 4 === 3 ? 250 : 20));
    }
    return times.map((t) => t.toFixed(1));
});
console.log("keystroke ms (10k asterisk-heavy, flush every 4th):", timings.join(" "));
await sleep(300); console.log("textarea tail:", JSON.stringify((await state(page)).md.slice(-30)));
await clear();
await browser.close();
