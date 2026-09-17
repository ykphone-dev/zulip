// Phase 2 review fixes, live:
// B1 — the thread panel's typeahead and send answer for the thread, not
//      for whatever the compose box addresses; snippets have no recipient.
// S1 — a message arriving right after fast typing in an edit form does
//      not move the cursor back.
// S2 — editors whose box leaves the page are destroyed at once.
// S3 — the code block language control from the keyboard.
// S4 — the language menu goes with its editor.
/* global document, window, zulip_test -- page.evaluate callbacks run in the browser */
import {BASE, sleep, start} from "./lib.mjs";

const {browser, page} = await start({width: 1400, height: 900});
const kb = page.keyboard;
const errors = [];
page.on("pageerror", (err) => errors.push(err.message));
page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().includes("Failed to load resource")) {
        errors.push(msg.text());
    }
});

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
const raw = async (id) =>
    (await api("GET", `/json/messages/${id}?apply_markdown=false`)).message.content;
const count = () => page.evaluate(() => document.body.dataset.ykphoneRichEditors);
const shift_enter = async () => {
    await kb.down("Shift");
    await kb.press("Enter");
    await kb.up("Shift");
};
const othello_id = await page.evaluate(() =>
    zulip_test.get_user_id_from_name("Othello, the Moor of Venice"),
);

// ---- B1: the thread panel ----
const {id: root_id} = await api("POST", "/json/messages", {
    type: "stream",
    to: "errors",
    topic: "",
    content: "B1 thread root " + Date.now().toString(36),
});
await page.goto(BASE + "/#narrow/channel/12-errors/topic/");
await sleep(4500);
const row = `.focused-message-list .message_row[data-message-id="${root_id}"]`;
await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({block: "center"}), row);
await page.hover(`${row} .messagebox`);
await sleep(300);
await page.evaluate((sel) => document.querySelector(`${sel} .ykphone-thread-button`).click(), row);
await sleep(2500);
console.log("S2 editors with the panel open:", await count());
// The compose box now addresses a DM with Othello; the panel stays open.
await page.evaluate((id) => {
    window.location.hash = `#narrow/dm/${id}`;
}, othello_id);
await sleep(3000);
console.log(
    "B1 compose addresses:",
    await page.evaluate(() => [
        zulip_test.private_message_recipient_emails(),
        Boolean(document.querySelector("#ykphone-thread-panel .ykphone-rich-editor")),
    ]),
);
const panel_md = () =>
    page.evaluate(() => document.querySelector(".ykphone-thread-panel-textarea").value);
await page.click(".ykphone-thread-panel-composer .ykphone-rich-content");
await kb.type("@oth");
await sleep(600);
await kb.press("Enter");
await sleep(300);
console.log(
    "B1 panel mention with a DM to Othello in the compose box:",
    JSON.stringify(await panel_md()),
);
await kb.type("@al");
await sleep(600);
console.log(
    "B1 wildcard offered in the panel:",
    await page.evaluate(() =>
        [...document.querySelectorAll(".ykphone-rich-typeahead li")]
            .map((li) => li.textContent.trim().replaceAll(/\s+/g, " "))
            .slice(0, 2),
    ),
);
await kb.press("Escape");
await kb.down("Control");
await kb.press("a");
await kb.up("Control");
await kb.press("Backspace");
await sleep(200);

// @all in a large channel waits for a confirmation shown in the panel.
await page.evaluate(() => zulip_test.set_wildcard_mention_threshold(3));
await kb.type("@**all** B1 wildcard");
await sleep(300);
await kb.press("Enter");
await sleep(1200);
const replies = () =>
    page.evaluate(() =>
        [...document.querySelectorAll(".ykphone-thread-panel-message")].map((m) =>
            Number(m.dataset.messageId),
        ),
    );
const before_confirm = await replies();
console.log(
    "B1 confirmation:",
    await page.evaluate(() =>
        document
            .querySelector(".ykphone-thread-panel-banners")
            ?.textContent.trim()
            .replaceAll(/\s+/g, " ")
            .slice(0, 120),
    ),
    "compose banners untouched:",
    await page.evaluate(
        () => document.querySelector("#compose_banners")?.textContent.trim() === "",
    ),
    "draft kept:",
    JSON.stringify(await panel_md()),
);
await page.click(".ykphone-thread-panel-banners .main-view-banner-action-button");
await sleep(2500);
const after_confirm = await replies();
const sent_id = after_confirm.find((id) => !before_confirm.includes(id));
console.log(
    "B1 sent after Yes:",
    sent_id,
    JSON.stringify(sent_id && (await raw(sent_id))),
    "banners cleared:",
    await page.evaluate(
        () => document.querySelector(".ykphone-thread-panel-banners").textContent.trim() === "",
    ),
    "compose still a DM draft:",
    await page.evaluate(() => zulip_test.private_message_recipient_emails()),
);
await page.evaluate(() => zulip_test.set_wildcard_mention_threshold(15));
// Closing the panel destroys its editor.
await page.click(".ykphone-thread-panel-close");
await sleep(300);
console.log("S2 editors after the panel closed:", await count());

// ---- B1: a saved snippet, with the compose box still on the DM ----
await page.click("#compose .ykphone-rich-content");
await page.click("#compose .ykphone-compose-more");
await sleep(400);
await page.click("#compose .saved-snippets-composebox-widget");
await sleep(800);
await page.evaluate(() => document.querySelector(".sticky-bottom-option-button")?.click());
await sleep(1000);
console.log("S2 editors with the snippet form open:", await count());
await page.type("#new-saved-snippet-title", "B1 snippet " + Date.now().toString(36));
await page.click("#add-new-saved-snippet-modal .ykphone-rich-content");
await kb.type("@oth");
await sleep(600);
await kb.press("Enter");
await sleep(300);
await kb.type("@al");
await sleep(600);
console.log(
    "B1 snippet:",
    JSON.stringify(
        await page.evaluate(
            () =>
                document.querySelector(
                    "#add-new-saved-snippet-modal textarea.saved-snippet-content",
                ).value,
        ),
    ),
    "wildcards offered:",
    await page.evaluate(() =>
        [...document.querySelectorAll(".ykphone-rich-typeahead li")]
            .map((li) => li.textContent.trim())
            .filter((t) => /^(all|everyone|channel|topic|stream)\b/.test(t)),
    ),
);
await page.evaluate(() =>
    document.querySelector("#add-new-saved-snippet-modal .modal__close")?.click(),
);
await sleep(1000);
console.log(
    "S2 editors after the snippet form closed:",
    await count(),
    "modal gone:",
    await page.evaluate(() => !document.querySelector("#add-new-saved-snippet-modal")),
);

// ---- S1: fast typing, then a message arrives ----
const topic = "S1 fast " + Date.now().toString(36);
const {id: mine} = await api("POST", "/json/messages", {
    type: "stream",
    to: "errors",
    topic,
    content: "시작",
});
await page.goto(
    BASE + `/#narrow/channel/12-errors/topic/${encodeURIComponent(topic).replaceAll("%", ".")}`,
);
await sleep(4500);
const mine_row = `.focused-message-list .message_row[data-message-id="${mine}"]`;
// Upstream gives the focus back to an edit form after a re-render only
// when its message is the selected one.
await page.click(`${mine_row} .message_content`);
await sleep(300);
await page.hover(`${mine_row} .messagebox`);
await sleep(200);
await page.evaluate(
    (sel) => document.querySelector(`${sel} .message-actions-menu-button`).click(),
    mine_row,
);
await sleep(400);
await page.evaluate(() => document.querySelector(".popover_edit_message").click());
await sleep(800);
console.log("S2 editors with an edit form open:", await count());
const edit_state = () =>
    page.evaluate((id) => {
        const ta = document.querySelector(`#edit_form_${id} textarea.message_edit_content`);
        const pm = document.querySelector(`#edit_form_${id} .ProseMirror`);
        return {md: ta?.value, focused: document.activeElement === pm};
    }, mine);
for (let round = 0; round < 2; round += 1) {
    await page.click(`#edit_form_${mine} .ykphone-rich-content`);
    await kb.down("Control");
    await kb.press("End");
    await kb.up("Control");
    await sleep(300);
    // Renaming the user re-renders their messages, the edited one too,
    // while a run of characters is being typed (one every 30ms, so a
    // write to the textarea is pending most of the time); upstream then
    // gives the focus and the cursor it read back to the form. Round 1
    // puts the name back.
    const typed = "0123456789abcdefghijklmnopqrst";
    const rename = page.evaluate(async (round) => {
        const csrf = document.querySelector("input[name=csrfmiddlewaretoken]")?.value;
        await fetch("/json/settings", {
            method: "PATCH",
            headers: {"X-CSRFToken": csrf},
            body: new URLSearchParams({full_name: round === 0 ? "Iago S1" : "Iago"}),
        });
    }, round);
    await page.evaluate(async (typed) => {
        for (const ch of typed) {
            document.execCommand("insertText", false, ch);
            await new Promise((resolve) => setTimeout(resolve, 30));
        }
    }, typed);
    await rename;
    await sleep(1500);
    await kb.type("!");
    await sleep(200);
    const s = await edit_state();
    console.log(
        `S1 round ${round}:`,
        JSON.stringify(s.md),
        "typed run intact:",
        s.md.endsWith(typed + "!"),
        "focused:",
        s.focused,
    );
}
await kb.press("Escape");
await sleep(500);
console.log("S2 editors after Escape:", await count());

// ---- S3: the language control from the keyboard; S4 ----
await page.goto(
    BASE + `/#narrow/channel/12-errors/topic/${encodeURIComponent(topic).replaceAll("%", ".")}`,
);
await sleep(4000);
await page.click("#compose .ykphone-rich-content");
await kb.down("Control");
await kb.press("a");
await kb.up("Control");
await kb.press("Backspace");
await kb.type("```python");
await shift_enter();
await kb.type("print(1)");
await kb.press("Tab");
await sleep(200);
const focus = () =>
    page.evaluate(() => {
        const el = document.activeElement;
        return [
            el?.tagName,
            el?.className?.toString().slice(0, 40),
            el?.getAttribute("aria-expanded"),
            el?.getAttribute("aria-activedescendant"),
        ];
    });
console.log("S3 Tab from the code:", await focus());
await kb.press("Enter");
await sleep(400);
console.log(
    "S3 Enter opens:",
    await focus(),
    "button expanded:",
    await page.evaluate(() =>
        document.querySelector("#compose .ykphone-rich-code-label").getAttribute("aria-expanded"),
    ),
);
await kb.press("ArrowDown");
await kb.press("ArrowDown");
await sleep(100);
console.log(
    "S3 arrows:",
    await page.evaluate(() => {
        const input = document.activeElement;
        const active = document.querySelector(
            `[id="${input.getAttribute("aria-activedescendant")}"]`,
        );
        return [
            active?.textContent,
            active?.getAttribute("aria-selected"),
            active?.getAttribute("role"),
            document
                .querySelector(`[id="${input.getAttribute("aria-controls")}"]`)
                ?.getAttribute("role"),
        ];
    }),
);
await kb.press("Escape");
await sleep(200);
console.log(
    "S3 Escape gives the focus back to the button:",
    await focus(),
    "hotkeys did not fire, md:",
    JSON.stringify(await page.evaluate(() => document.querySelector("#compose-textarea").value)),
);
await kb.press("Space");
await sleep(400);
await kb.type("rust");
await kb.press("Enter");
await sleep(300);
console.log(
    "S3 Space, search, Enter:",
    JSON.stringify(await page.evaluate(() => document.querySelector("#compose-textarea").value)),
    "focus:",
    await focus(),
);
await kb.down("Control");
await kb.press("a");
await kb.up("Control");
await kb.press("Backspace");

// S4: the menu is open in an edit form when the form goes.
await page.hover(`${mine_row} .messagebox`);
await sleep(200);
await page.evaluate(
    (sel) => document.querySelector(`${sel} .message-actions-menu-button`).click(),
    mine_row,
);
await sleep(400);
await page.evaluate(() => document.querySelector(".popover_edit_message").click());
await sleep(800);
await page.click(`#edit_form_${mine} .ykphone-rich-content`);
await kb.down("Control");
await kb.press("End");
await kb.up("Control");
await shift_enter();
await kb.type("```js");
await shift_enter();
await kb.type("x");
await sleep(300);
await page.click(`#edit_form_${mine} .ykphone-rich-code-label`);
await sleep(400);
console.log(
    "S4 menu open:",
    await page.evaluate(() => Boolean(document.querySelector(".ykphone-rich-language-menu"))),
);
// The form closes under the menu (upstream ends the edit when the
// message is changed elsewhere; here the form's Cancel is clicked from
// script, as a re-render would remove it).
await page.evaluate(
    (id) => document.querySelector(`#edit_form_${id} .message_edit_cancel`).click(),
    mine,
);
await sleep(500);
console.log(
    "S4 menu closed with its editor:",
    await page.evaluate(() => !document.querySelector(".ykphone-rich-language-menu")),
    "editors:",
    await count(),
);
// S2: a narrow change throws away the message list with a form open.
await page.hover(`${mine_row} .messagebox`);
await sleep(200);
await page.evaluate(
    (sel) => document.querySelector(`${sel} .message-actions-menu-button`).click(),
    mine_row,
);
await sleep(400);
await page.evaluate(() => document.querySelector(".popover_edit_message").click());
await sleep(800);
console.log("S2 editors with a form open:", await count());
await page.evaluate(() => {
    window.location.hash = "#narrow/channel/12-errors/topic/S2.20elsewhere";
});
await sleep(3000);
console.log(
    "S2 editors after the narrow changed:",
    await count(),
    "form in the page:",
    await page.evaluate(
        (id) => document.querySelector(`#edit_form_${id}`)?.isConnected ?? false,
        mine,
    ),
);
console.log("page errors:", JSON.stringify(errors));
await browser.close();
