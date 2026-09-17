// Who removes the send-blocking banner after Enter.
/* global ClipboardEvent, DataTransfer, Element, MutationObserver, Node, document -- page.evaluate callbacks run in the browser */
import {BASE, sleep, start} from "./lib.mjs";

const {browser, page} = await start({width: 1400, height: 900});
const kb = page.keyboard;
await page.goto(BASE + "/#narrow/channel/12-errors");
await sleep(4000);
await page.click(".ykphone-rich-content");
const paste = (data) =>
    page.evaluate((data) => {
        const dt = new DataTransfer();
        for (const [type, value] of Object.entries(data)) {
            dt.setData(type, value);
        }
        document
            .querySelector(".ProseMirror")
            .dispatchEvent(
                new ClipboardEvent("paste", {clipboardData: dt, bubbles: true, cancelable: true}),
            );
    }, data);
await paste({"text/html": "<p><code>a`</code></p>", "text/plain": "a`"});
await sleep(300);
await page.evaluate(() => {
    const trace = (what) =>
        console.log(
            "YKDEBUG " +
                what +
                " :: " +
                new Error("trace").stack
                    .split("\n")
                    .slice(2, 9)
                    .map((l) =>
                        l
                            .trim()
                            .replace(/^at /, "")
                            .replace(/\(.*\/(webpack\/|src\/)?/, "("),
                    )
                    .join(" | "),
        );
    const orig_remove_child = Node.prototype.removeChild;
    Node.prototype.removeChild = function (child) {
        if (child.classList?.contains("compose_banner")) {
            trace("removeChild banner");
        }
        return orig_remove_child.call(this, child);
    };
    const orig_remove = Element.prototype.remove;
    Element.prototype.remove = function () {
        if (this.classList?.contains("compose_banner")) {
            trace("remove banner");
        }
        return orig_remove.call(this);
    };
    const orig_append = Element.prototype.append;
    Element.prototype.append = function (...nodes) {
        if (this.id === "compose_banners") {
            trace("append banner");
        }
        return orig_append.apply(this, nodes);
    };
    new MutationObserver((records) => {
        for (const r of records) {
            console.log(
                "YKDEBUG mutation added",
                r.addedNodes.length,
                "removed",
                r.removedNodes.length,
                [...r.removedNodes].map((n) => n.className).join(","),
            );
        }
    }).observe(document.querySelector("#compose_banners"), {childList: true});
});
await kb.press("Enter");
await sleep(800);
console.log(
    "banner:",
    JSON.stringify(
        await page.evaluate(() =>
            document
                .querySelector("#compose_banners")
                ?.textContent.trim()
                .replaceAll(/\s+/g, " ")
                .slice(0, 80),
        ),
    ),
);
await browser.close();
