// Phase 3 polish in the compose box: the code block language menu, the
// math block's rendered formula, Markdown typed in a spoiler's header;
// and the saved snippet form's editor.
import {start, shot, sleep, BASE} from "./lib.mjs";

const {browser, page} = await start({width: 1400, height: 900});
const kb = page.keyboard;
const md = () => page.evaluate(() => document.querySelector("#compose-textarea").value);
const clear = async () => {
    await page.click("#compose .ykphone-rich-content");
    await kb.down("Control");
    await kb.press("a");
    await kb.up("Control");
    await kb.press("Backspace");
    await sleep(150);
};
// Enter sends for this user; Shift+Enter is the new line.
const shift_enter = async () => {
    await kb.down("Shift");
    await kb.press("Enter");
    await kb.up("Shift");
};
await page.goto(BASE + "/#narrow/channel/12-errors/topic/phase.203");
await sleep(4500);

// Code block language.
await clear();
await kb.type("```python");
await shift_enter();
await kb.type("print(1)");
await sleep(200);
console.log("code md:", JSON.stringify(await md()));
const label = () =>
    page.evaluate(() => document.querySelector("#compose .ykphone-rich-code-label")?.textContent);
console.log("label:", await label());
// A plain click in the code opens nothing.
await page.click("#compose .ykphone-rich-code-block code");
await sleep(300);
console.log(
    "click in code opens a menu:",
    await page.evaluate(() => !!document.querySelector(".ykphone-rich-language-menu")),
);
await page.click("#compose .ykphone-rich-code-label");
await sleep(500);
console.log(
    "menu open:",
    await page.evaluate(() => [
        !!document.querySelector(".ykphone-rich-language-menu"),
        document.activeElement?.className,
        [...document.querySelectorAll(".ykphone-rich-language-option")]
            .slice(0, 4)
            .map((li) => li.textContent),
    ]),
);
await shot(page, "p3-language-menu");
await kb.type("javas");
await sleep(200);
console.log(
    "filtered:",
    await page.evaluate(() =>
        [...document.querySelectorAll(".ykphone-rich-language-option")]
            .map((li) => li.textContent)
            .slice(0, 5),
    ),
);
await kb.press("Enter");
await sleep(300);
console.log(
    "after choosing:",
    JSON.stringify(await md()),
    "label:",
    await label(),
    "focus in editor:",
    await page.evaluate(() => document.activeElement?.classList.contains("ProseMirror")),
);
await kb.type("!");
console.log("typing continues in the code:", JSON.stringify(await md()));
// Plain text, from the keyboard only.
await page.click("#compose .ykphone-rich-code-label");
await sleep(400);
await kb.press("Enter");
await sleep(300);
console.log("plain text:", JSON.stringify(await md()), "label:", await label());
// Escape closes the menu and gives the editor the focus back.
await page.click("#compose .ykphone-rich-code-label");
await sleep(400);
await kb.press("Escape");
await sleep(300);
console.log(
    "escape:",
    await page.evaluate(() => [
        !!document.querySelector(".ykphone-rich-language-menu"),
        document.activeElement?.classList.contains("ProseMirror"),
    ]),
    "draft kept:",
    JSON.stringify(await md()),
);

// Math block.
await clear();
await kb.type("```math");
await shift_enter();
await kb.type("x^2 + \\frac{1}{2}");
await sleep(800);
console.log(
    "math md:",
    JSON.stringify(await md()),
    "rendered:",
    await page.evaluate(
        () => !!document.querySelector("#compose .ykphone-rich-math-preview .katex"),
    ),
);
await shot(page, "p3-math");

// Spoiler header.
await clear();
await kb.type("```spoiler 제목");
await shift_enter();
await kb.type("본문");
await page.click("#compose .ykphone-rich-spoiler-header");
await kb.press("End");
await kb.type(" **굵게**");
await sleep(300);
console.log(
    "spoiler md:",
    JSON.stringify(await md()),
    "header html:",
    await page.evaluate(
        () => document.querySelector("#compose .ykphone-rich-spoiler-header")?.innerHTML,
    ),
);
await shot(page, "p3-spoiler");

// A saved snippet form, prefilled from the compose box.
await clear();
await kb.type("snippet **굵게** @oth");
await sleep(600);
await kb.press("Enter");
await sleep(300);
const compose_md = await md();
await page.click("#compose .ykphone-compose-more");
await sleep(400);
await page.click("#compose .saved-snippets-composebox-widget");
await sleep(800);
console.log(
    "dropdown:",
    await page.evaluate(() =>
        [
            ...document.querySelectorAll(
                ".dropdown-list-container button, .dropdown-list-container .sticky-bottom-option-button, .saved_snippets-dropdown-list-container *[class*=sticky]",
            ),
        ]
            .map((e) => e.className)
            .slice(0, 5),
    ),
);
await page.evaluate(() => document.querySelector(".sticky-bottom-option-button")?.click());
await sleep(1000);
const modal = await page.evaluate(() => {
    const ta = document.querySelector(
        "#add-new-saved-snippet-modal textarea.saved-snippet-content",
    );
    const pm = document.querySelector("#add-new-saved-snippet-modal .ykphone-rich-content");
    return {
        md: ta?.value,
        text: pm?.innerText,
        chips: pm?.querySelectorAll(".ykphone-rich-mention").length,
        strong: pm?.querySelector("strong")?.textContent,
    };
});
console.log("snippet form:", JSON.stringify(modal), "same as compose:", modal.md === compose_md);
await page.type("#new-saved-snippet-title", "p2 snippet " + Date.now().toString(36));
await page.click("#add-new-saved-snippet-modal .ykphone-rich-content");
await kb.down("Control");
await kb.press("End");
await kb.up("Control");
// The editor reads a selection the browser moved on its next
// selectionchange; a person does not press the next key within the
// same millisecond.
await sleep(50);
await kb.press("Enter");
await kb.type("둘째 줄");
await sleep(300);
await shot(page, "p3-snippet-form");
console.log(
    "Enter is a new line in the form:",
    JSON.stringify(
        await page.evaluate(
            () =>
                document.querySelector(
                    "#add-new-saved-snippet-modal textarea.saved-snippet-content",
                ).value,
        ),
    ),
);
await page.click("#add-new-saved-snippet-modal .dialog_submit_button");
await sleep(1500);
const snippets = await page.evaluate(
    async () => (await (await fetch("/json/saved_snippets")).json()).saved_snippets,
);
console.log(
    "saved:",
    JSON.stringify(snippets.at(-1).content),
    "modal closed:",
    await page.evaluate(() => !document.querySelector("#add-new-saved-snippet-modal")),
);
await sleep(500);
console.log(
    "editors after the modal closed:",
    await page.evaluate(() => document.querySelectorAll(".ykphone-rich-editor").length),
);
await clear();
await browser.close();
