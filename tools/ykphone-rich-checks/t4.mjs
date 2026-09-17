import {start, state, shot, sleep, BASE} from "./lib.mjs";
const {browser, page} = await start();
await page.goto(BASE + "/#narrow/channel/12-errors/topic/general.20chat");
await sleep(3500);
await page.click(".ykphone-rich-content");
await page.keyboard.type("hi @iag");
await sleep(500);
console.log(await state(page));
console.log(await page.evaluate(() => ({
  ta: document.querySelectorAll(".ykphone-rich-typeahead").length,
  tippy: document.querySelectorAll("[data-tippy-root]").length,
  anchors: document.querySelectorAll(".ykphone-rich-typeahead-anchor").length,
  html: document.querySelector(".ykphone-rich-typeahead")?.outerHTML.slice(0, 300),
})));
await browser.close();
