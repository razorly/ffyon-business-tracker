import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertLocal, capture, installDesktopFixture } from "./features-browser.js";

// Opt-in, disposable IPC/database fixtures. No production records or OS window actions.
const url = process.env.FFYON_WINDOW_ROOT_URL;
if (url) {
  assertLocal(url);
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.FFYON_PLAYWRIGHT_PATH || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.FFYON_BROWSER_CHANNEL ? { channel: process.env.FFYON_BROWSER_CHANNEL } : {}) });
  const output = resolve("test-results/window-frame");
  await mkdir(output, { recursive: true });
  const evidence = [];
  try {
    for (const width of [1280, 960, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 820 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      const fixture = await installDesktopFixture(page, {
        clients: [], services: [], appointments: [], blocks: [],
        settings: { timezone: "Europe/London", booking_enabled: true, slot_minutes: 30, horizon_days: 90, opening_hours: [], revision: 1 },
      });
      // Wrap the installed fixture binding rather than depending on init-script order.
      await page.addInitScript(() => {
        const original = window.__ffyonFeatureInvoke;
        let maximized = false;
        window.__windowCommands = [];
        window.__windowLocked = false;
        window.__ffyonFeatureInvoke = async (command, args) => {
          if (window.__windowLocked && (command === "access_status" || command === "access_check")) return { state: "locked", device_id: null, device_name: null, expires_at: null, error: null };
          if (command.startsWith("plugin:window|")) {
            window.__windowCommands.push(command);
            if (command.endsWith("is_maximized")) return maximized;
            if (command.endsWith("is_focused")) return true;
            if (command.endsWith("toggle_maximize")) maximized = !maximized;
            return null;
          }
          return original(command, args);
        };
      });
      try {
        await page.goto(url, { waitUntil: "networkidle" });
        await page.locator(".app-layout").waitFor();
        const geometry = await page.evaluate(() => {
          const bar = document.querySelector(".window-titlebar");
          const sidebar = document.querySelector("aside");
          const main = document.querySelector(".app-layout main");
          return { barBottom: bar.getBoundingClientRect().bottom, sidebarTop: sidebar.getBoundingClientRect().top,
            mainTop: main.getBoundingClientRect().top, mainBottom: main.getBoundingClientRect().bottom,
            sidebarWidth: sidebar.getBoundingClientRect().width,
            splitWidth: parseFloat(getComputedStyle(document.querySelector(".window-frame")).getPropertyValue("--sidebar-width")), height: innerHeight };
        });
        assert.equal(geometry.barBottom, geometry.sidebarTop);
        assert.equal(geometry.barBottom, geometry.mainTop);
        assert.equal(geometry.sidebarWidth, geometry.splitWidth);
        assert.equal(geometry.mainBottom, geometry.height);
        for (const theme of ["light", "dark"]) {
          await page.evaluate(theme => { localStorage.setItem("ffyon-theme", theme); }, theme);
          await page.reload({ waitUntil: "networkidle" });
          await page.locator(".app-layout").waitFor();
          assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
          await capture(page, output, `${theme}-${width}.png`);
        }
        await page.getByRole("button", { name: "Maximize window", exact: true }).click();
        await page.getByRole("button", { name: "Restore window", exact: true }).click();
        await page.getByRole("button", { name: "Maximize window", exact: true }).waitFor();
        await page.getByRole("button", { name: "Minimize window", exact: true }).click();
        const beforeClose = await page.evaluate(() => window.__windowCommands.filter(command => command.endsWith("start_dragging")).length);
        await page.getByRole("button", { name: "Close window", exact: true }).click();
        assert.equal(await page.evaluate(() => window.__windowCommands.filter(command => command.endsWith("start_dragging")).length), beforeClose, "Controls must not initiate dragging");
        await page.locator(".window-drag-region").dblclick({ position: { x: 100, y: 18 } });
        await page.getByRole("button", { name: "Restore window", exact: true }).waitFor();
        const commands = await page.evaluate(() => window.__windowCommands);
        for (const action of ["minimize", "toggle_maximize", "start_dragging", "close"]) assert.ok(commands.includes(`plugin:window|${action}`), action);
        // Modal portals must leave the OS-equivalent window controls accessible.
        await page.getByRole("button", { name: "New entry", exact: true }).click();
        await page.getByRole("dialog").waitFor();
        assert.ok(await page.getByRole("button", { name: "Close window", exact: true }).isVisible());
        await page.getByRole("button", { name: "Minimize window", exact: true }).click();
        await page.keyboard.press("Escape");
        await page.evaluate(async () => { window.__windowLocked = true; const { checkAccess } = await import("/src/lib/access.ts"); const status = await checkAccess(); window.__TAURI_INTERNALS__.invoke = async (command, args) => command === "access_status" || command === "access_check" ? status : window.__ffyonFeatureInvoke(command, args); window.dispatchEvent(new Event("focus")); });
        await page.getByRole("heading", { name: "Admin access required" }).waitFor();
        await page.getByRole("button", { name: "Close window", exact: true }).click();
        await capture(page, output, `locked-${width}.png`);
        assert.deepEqual(errors, []);
        evidence.push({ width, geometry, lightAndDark: true, controlsAndDoubleClick: true, controlsAboveModalAndOnLockScreen: true, errors });
      } finally { await page.close(); fixture.close(); }
    }
    const plain = await browser.newPage();
    await plain.goto(url, { waitUntil: "networkidle" });
    assert.equal(await plain.locator(".window-titlebar").count(), 0, "Browser must not show nonfunctional native controls");
    await plain.close();
    await writeFile(resolve(output, "evidence.json"), JSON.stringify({ evidence, nativeLimit: "IPC is mocked; native window movement, tray interception and macOS traffic lights require native QA." }, null, 2));
    console.log(JSON.stringify({ passed: true, evidence, output }, null, 2));
  } finally { await browser.close(); }
}
