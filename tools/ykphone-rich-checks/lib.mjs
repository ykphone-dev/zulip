/* global document -- page.evaluate callbacks run in the browser */
import fs from "node:fs";

import {launch} from "puppeteer";

export const BASE = "http://localhost:9991";
export const OUT = "/Users/apple/develop/ykphone/zulip/var/rc/out";
fs.mkdirSync(OUT, {recursive: true});

export async function start({width = 1280, height = 900, user = "iago@zulip.com"} = {}) {
    const browser = await launch({
        executablePath:
            "/home/vagrant/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome",
        headless: true,
        args: ["--no-sandbox", `--window-size=${width},${height}`, "--lang=ko-KR"],
        defaultViewport: {width, height},
    });
    const page = await browser.newPage();
    page.on("pageerror", (err) => console.log("PAGEERROR", err.message));
    page.on("console", (msg) => {
        if (
            (["error", "warning"].includes(msg.type()) || msg.text().startsWith("YKDEBUG")) &&
            !msg.text().includes("ws://") &&
            !msg.text().includes("webpack-dev-server")
        ) {
            console.log("CONSOLE", msg.type(), msg.text());
        }
    });
    await page.goto(BASE + "/devlogin/");
    await page.waitForSelector(`input[value="${user}"], button[value="${user}"]`);
    await Promise.all([
        page.waitForNavigation({waitUntil: "networkidle2"}),
        page.click(`[value="${user}"]`),
    ]);
    await page.waitForSelector("#compose", {timeout: 60000});
    return {browser, page};
}

export async function state(page) {
    return page.evaluate(() => {
        const ta = document.querySelector("#compose-textarea");
        const pm = document.querySelector(".ykphone-rich-content");
        return {
            md: ta.value,
            sel: [ta.selectionStart, ta.selectionEnd],
            html: pm?.innerHTML,
            focus: document.activeElement?.className ?? document.activeElement?.id,
        };
    });
}

export async function shot(page, name) {
    await page.screenshot({path: `${OUT}/${name}.png`});
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
