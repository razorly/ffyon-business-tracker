import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertLocal, capture, installDesktopFixture } from "./features-browser.js";

const url = process.env.FFYON_TIME_OFF_URL;
if (url) await run();

async function run() {
  assertLocal(url);
  const { chromium } = createRequire(import.meta.url)(process.env.FFYON_PLAYWRIGHT_PATH || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.FFYON_BROWSER_CHANNEL ? { channel: process.env.FFYON_BROWSER_CHANNEL } : {}) });
  const output = resolve("test-results/time-off-browser");
  await mkdir(output, { recursive: true });
  const evidence = [];
  try {
    for (const theme of ["light", "dark"]) for (const width of [1280, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: "America/Los_Angeles" });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      const records = { clients: [], appointments: [], services: [], blocks: [], settings: { booking_enabled: false, timezone: "Europe/London", slot_minutes: 30, horizon_days: 90, opening_hours: [], admin_notifications_enabled: false, admin_notification_email: "", revision: 1 } };
      await page.addInitScript(theme => localStorage.setItem("ffyon-theme", theme), theme);
      const fixture = await installDesktopFixture(page, records);
      try {
        await page.goto(url, { waitUntil: "networkidle" });
        await page.locator('nav a[title="Settings"]').click();
        const card = page.getByRole("heading", { name: "Time off", exact: true }).locator("../../..");
        await card.getByRole("button", { name: "Add", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Add time off", exact: true });
        await dialog.getByLabel("Label", { exact: true }).fill("A week away");
        await dialog.getByLabel("Start date", { exact: true }).fill("2027-03-27");
        await dialog.getByLabel("Start time", { exact: true }).fill("00:00");
        await dialog.getByLabel("End date", { exact: true }).fill("2027-04-03");
        await dialog.getByLabel("End time", { exact: true }).fill("00:00");
        assert.equal(await dialog.getByLabel("Duration (minutes)").count(), 0);
        await capture(page, output, `time-off-${theme}-${width}.png`);
        await dialog.getByRole("button", { name: "Add time off", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        await card.getByRole("button", { name: "Remove A week away", exact: true }).waitFor();
        assert.equal(await card.getByText("A week away", { exact: true }).count(), 1);
        assert.match(await card.innerText(), /27\/03\/2027.*03\/04\/2027/);
        assert.equal(records.blocks.length, 7);
        const saved = fixture.mutations.find(m => m.operation === "blocks" && m.method === "POST").body;
        assert.deepEqual([saved.date, saved.start_time, saved.end_date, saved.end_time], ["2027-03-27", "00:00", "2027-04-03", "00:00"]);
        assert.equal("duration_min" in saved, false);
        await card.getByRole("button", { name: "Add", exact: true }).click();
        await dialog.getByLabel("Label", { exact: true }).fill("Lunch");
        await dialog.getByLabel("Start date", { exact: true }).fill("2027-04-05");
        await dialog.getByLabel("End date", { exact: true }).fill("2027-04-05");
        await dialog.getByLabel("Start time", { exact: true }).fill("13:00");
        await dialog.getByLabel("End time", { exact: true }).fill("12:00");
        assert.equal(await dialog.getByRole("button", { name: "Add time off", exact: true }).isDisabled(), true);
        await dialog.getByText("End date and time must be after the start.", { exact: true }).waitFor();
        await dialog.getByLabel("End time", { exact: true }).fill("14:00");
        await dialog.getByRole("button", { name: "Add time off", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        await card.getByRole("button", { name: "Remove Lunch", exact: true }).waitFor();
        await card.getByRole("button", { name: "Remove A week away", exact: true }).click();
        await card.getByText("A week away", { exact: true }).waitFor({ state: "hidden" });
        assert.equal(records.blocks.length, 1);
        assert.equal(records.blocks[0].label, "Lunch");
        await page.locator('nav a[title="Schedule"]').click();
        await page.getByLabel("Go to date", { exact: true }).fill("2027-04-12");
        await page.getByRole("button", { name: "Book", exact: true }).click();
        const booking = page.getByRole("dialog", { name: "New appointment", exact: true });
        await booking.getByLabel("Date", { exact: true }).waitFor();
        assert.equal(await booking.getByLabel("Date", { exact: true }).inputValue(), "2027-04-12");
        assert.equal(await booking.getByRole("tab", { name: "Appointment", exact: true }).getAttribute("aria-selected"), "true");
        await booking.getByLabel("Private staff note", { exact: true }).fill("Keep this draft");
        await booking.getByLabel("Start", { exact: true }).fill("14:15");
        await booking.getByRole("tab", { name: "Time off", exact: true }).click();
        const scheduleTimeOff = page.getByRole("dialog", { name: "Add time off", exact: true });
        assert.equal(await page.getByRole("dialog").count(), 1);
        assert.equal(await scheduleTimeOff.getByLabel("Start date", { exact: true }).inputValue(), "2027-04-12");
        assert.equal(await scheduleTimeOff.getByLabel("Start time", { exact: true }).inputValue(), "14:15");
        await scheduleTimeOff.getByLabel("Label", { exact: true }).fill("Schedule holiday");
        await scheduleTimeOff.getByLabel("End date", { exact: true }).fill("2027-04-19");
        await scheduleTimeOff.getByRole("tab", { name: "Appointment", exact: true }).click();
        assert.equal(await booking.getByLabel(/^Private staff note/).inputValue(), "Keep this draft");
        await booking.getByRole("tab", { name: "Appointment", exact: true }).focus();
        await page.keyboard.press("ArrowRight");
        assert.equal(await scheduleTimeOff.getByRole("tab", { name: "Time off", exact: true }).getAttribute("aria-selected"), "true");
        assert.equal(await scheduleTimeOff.getByLabel("Label", { exact: true }).inputValue(), "Schedule holiday");
        assert.equal(await scheduleTimeOff.getByLabel("End date", { exact: true }).inputValue(), "2027-04-19");
        await capture(page, output, `schedule-time-off-${theme}-${width}.png`);
        const appointmentWrites = fixture.mutations.filter(m => m.operation === "appointments").length;
        await scheduleTimeOff.getByRole("button", { name: "Add time off", exact: true }).click();
        await scheduleTimeOff.waitFor({ state: "hidden" });
        await page.getByText("Schedule holiday", { exact: true }).first().waitFor();
        assert.equal(fixture.mutations.filter(m => m.operation === "appointments").length, appointmentWrites);
        assert.equal(records.clients.length, 0);
        await page.getByRole("button", { name: "Book", exact: true }).click();
        assert.equal(await booking.getByRole("tab", { name: "Appointment", exact: true }).getAttribute("aria-selected"), "true");
        await booking.getByRole("button", { name: "Close", exact: true }).click();
        await page.getByRole("button", { name: "Day", exact: true }).click();
        await page.getByLabel("Go to date", { exact: true }).fill("2027-05-01");
        await page.evaluate(() => {
          const invoke = window.__TAURI_INTERNALS__.invoke;
          window.__TAURI_INTERNALS__.invoke = async (command, args) => {
            if (command === "db_select" && args.sql.includes("FROM clients")) await new Promise(resolve => setTimeout(resolve, 1500));
            return invoke(command, args);
          };
        });
        await page.locator('[role="presentation"]').first().click({ position: { x: 30, y: 130 } });
        await booking.getByRole("tab", { name: "Time off", exact: true }).click();
        assert.equal(await scheduleTimeOff.getByLabel("Start date", { exact: true }).inputValue(), "2027-05-01");
        assert.equal(await scheduleTimeOff.getByLabel("Start time", { exact: true }).inputValue(), "10:15");
        await scheduleTimeOff.getByRole("button", { name: "Close", exact: true }).click();
        assert.deepEqual(errors, []);
        evidence.push({ theme, width, weekAcrossClockChange: true, onePeriodShown: true, invalidEndRejected: true, wholePeriodRemoved: true, scheduleBookTabs: true, selectedDateAndTimePreserved: true, bothDraftsPreserved: true, keyboardTabs: true, scheduleRefreshesWithoutAppointmentOrClient: true, pageErrors: errors });
      } finally { fixture.close(); await page.close(); }
    }
    await writeFile(resolve(output, "evidence.json"), JSON.stringify({ evidence, limitation: "Browser IPC/SQLite fixture; native WebView2 unverified. Booking capacity is covered by the real API bridge suite." }, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  } finally { await browser.close(); }
}
