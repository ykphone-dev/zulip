import {start, state, shot, sleep, BASE} from "./lib.mjs";
const {browser, page} = await start();
await page.goto(BASE + "/#narrow/channel/12-errors/topic/general.20chat");
await sleep(3500);
await page.click(".ykphone-rich-content");
const kb = page.keyboard;
const report = async (label) => { const s = await state(page); console.log("==", label, JSON.stringify(s.md), s.sel, "|", s.html.replace(/ class="[^"]*"| contenteditable="false"| data-[a-z-]+="[^"]*"| title="[^"]*"| aria-[a-z]+="[^"]*"| role="[^"]*"/g, "").slice(0, 260)); };
// poll
await page.evaluate(() => document.querySelector("#compose .add-poll").click()); await sleep(800);
await page.type("#poll-question-input", "점심 메뉴?");
const options = await page.$$("input.poll-option-input");
await options[0].type("김밥"); await sleep(200);
const options2 = await page.$$("input.poll-option-input");
await options2[1].type("라면");
await page.evaluate(() => document.querySelector("#add-poll-modal .dialog_submit_button").click()); await sleep(800);
await report("poll");
await shot(page, "t10-poll");
await kb.press("Enter"); await sleep(1500); await report("sent poll");
// todo
await page.evaluate(() => document.querySelector("#compose .add-todo-list").click()); await sleep(800);
await page.$eval("#todo-title-input", (el) => { el.value = ""; });
await page.type("#todo-title-input", "할 일");
const todos = await page.$$("input.todo-input");
await todos[0].type("보고서"); await sleep(200);
await page.evaluate(() => document.querySelector("#add-todo-modal .dialog_submit_button").click()); await sleep(800);
await report("todo");
await kb.press("Enter"); await sleep(1500); await report("sent todo");
// snippet
await kb.type("snippet: ");
await page.evaluate(() => document.querySelector("#compose .saved-snippets-composebox-widget").click()); await sleep(800);
const items = await page.$$eval(".list-item", (els) => els.map((e) => e.textContent.trim().replace(/\s+/g, " ").slice(0, 30)));
console.log("snippet items", items);
await page.evaluate(() => { const item = [...document.querySelectorAll(".list-item")].find((e) => e.textContent.includes("감사")); item?.click(); });
await sleep(800); await report("snippet");
await kb.press("Enter"); await sleep(1500); await report("sent snippet");
await browser.close();
