import {BASE, shot, sleep, start, state} from "./lib.mjs";

const {browser, page} = await start();
const kb = page.keyboard;
const drafts = () =>
    page.evaluate(() =>
        Object.values(JSON.parse(localStorage.getItem("drafts") ?? "{}")).map((d) => d.content),
    );
await page.goto(BASE + "/#narrow/channel/12-errors/topic/general.20chat");
await sleep(3500);
await page.click(".ykphone-rich-content");
await kb.type("draft **bold** and @iag");
await sleep(400);
await kb.press("Enter");
await sleep(200);
await kb.type("done");
console.log("typed", JSON.stringify((await state(page)).md));
await page.goto(BASE + "/#narrow/channel/11-devel/topic/general.20chat").catch(() => undefined);
await sleep(2500);
console.log("devel box", JSON.stringify((await state(page)).md));
console.log("drafts", await drafts());
await page.goto(BASE + "/#narrow/channel/12-errors/topic/general.20chat");
await sleep(2500);
let s = await state(page);
console.log("back in errors", JSON.stringify(s.md), s.html.slice(0, 300));
await page.reload({waitUntil: "networkidle2"});
await sleep(4000);
s = await state(page);
console.log("after reload", JSON.stringify(s.md), s.html?.slice(0, 300));
await shot(page, "t13-reload");
// open drafts overlay and restore
await page.goto(BASE + "/#drafts");
await sleep(2000);
console.log(
    "draft rows",
    await page.$$eval(".draft-row .rendered_markdown, .draft-info-box .messagebox-content", (els) =>
        els.slice(0, 3).map((e) => e.textContent.trim().slice(0, 60)),
    ),
);
await browser.close();
