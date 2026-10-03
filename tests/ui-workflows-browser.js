import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertLocal, capture, installDesktopFixture } from "./features-browser.js";

const require = createRequire(import.meta.url);
const url = process.env.FFYON_UI_ROOT_URL;
if (url) await run();

function data() {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const now = new Date().toISOString();
  const client = { id: "00000000-0000-4000-8000-000000008101", account_id: null, merged_into: null, name: "UI Workflow Customer", email: "workflow@example.invalid", phone: "07000000000", saved_address: "", saved_postcode: "", disabled: false, revision: 1, updated_at: now };
  const service = { id: "ui-workflow-tan", name: "Express spray tan", description: "Disposable fixture", duration_min: 30, price_pence: 2500, discount_percent: 0, booking_price_pence: 2500, active: true, revision: 1 };
  const appointment = { id: "00000000-0000-4000-8000-000000008301", client_id: client.id, service_id: service.id, service_name: service.name, date, start_time: "13:00", time_confirmed: true, duration_min: 30, price_pence: 2500, base_price_pence: 2500, discount_percent: 0, is_remote: false, visit_address: "", visit_postcode: "", notes: "", status: "confirmed", revision: 1, proposed_date: null, proposed_start_time: null, proposed_time_confirmed: null, series_id: null, created_at: now, updated_at: now };
  return { clients: [client], services: [service], appointments: [appointment], blocks: [], settings: { booking_enabled: true, timezone: "Europe/London", slot_minutes: 30, horizon_days: 90, opening_hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, open: "09:00", close: "17:00" })), admin_notifications_enabled: false, admin_notification_email: "", revision: 1 } };
}

async function run() {
  assertLocal(url);
  const { chromium } = require(process.env.FFYON_PLAYWRIGHT_PATH || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.FFYON_BROWSER_CHANNEL ? { channel: process.env.FFYON_BROWSER_CHANNEL } : {}) });
  const output = resolve("test-results/ui-workflows-browser");
  await mkdir(output, { recursive: true });
  const evidence = [];
  try {
    for (const width of [1280, 375, 320]) evidence.push(await workflows(browser, width, output));
    evidence.push(await failureState(browser, output));
    evidence.push(await loaderScope(browser));
    await writeFile(resolve(output, "evidence.json"), JSON.stringify({ evidence, nativeLimit: "Disposable browser IPC/SQLite fixtures. Does not verify WebView2, native notifications or credential storage." }, null, 2));
    console.log(JSON.stringify({ evidence }, null, 2));
  } finally { await browser.close(); }
}

async function workflows(browser, width, output) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: "America/Los_Angeles" });
  const records = data();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const fixture = await installDesktopFixture(page, records);
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: /^Today ·/ }).waitFor();
    await page.getByRole("button", { name: /UI Workflow Customer/ }).first().waitFor();
    assert.ok((await page.getByText(records.clients[0].name, { exact: true }).first().boundingBox()).width >= 90, "Today's client name must remain readable at narrow widths");
    await capture(page, output, `dashboard-${width}.png`);
    await page.locator('nav a[title="Schedule"]').click();
    await page.getByRole("heading", { name: "Schedule", exact: true }).waitFor();
    if (width < 640) assert.equal(await page.getByRole("button", { name: "Day", exact: true }).getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "Month", exact: true }).click();
    await page.getByLabel("Go to date", { exact: true }).fill("2027-02-15");
    await page.evaluate(() => {
      window.__delayClients = true;
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (window.__delayClients && command === "db_select" && args.sql.includes("FROM clients")) await new Promise(resolve => setTimeout(resolve, 500));
        return original(command, args);
      };
    });
    await page.getByRole("button", { name: "Book", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "New appointment", exact: true });
    await editor.waitFor();
    assert.equal(await editor.getByRole("button", { name: "Book appointment", exact: true }).isDisabled(), true, "The form must not submit previous fields before its new details load");
    await editor.locator("form").evaluate(form => form.requestSubmit());
    assert.equal(fixture.mutations.filter(item => item.operation === "appointments").length, 0);
    await until(page, async () => !await editor.getByRole("button", { name: "Book appointment", exact: true }).isDisabled());
    await page.evaluate(() => { window.__delayClients = false; });
    assert.equal(await editor.getByLabel("Date", { exact: true }).inputValue(), "2027-02-15", "Book uses the selected date, never a preceding month's spillover day");
    await editor.getByRole("combobox").first().fill(records.clients[0].name);
    await page.keyboard.press("Escape"); // dismiss client options before exercising the dialog
    for (let index = 0; index < 24; index++) {
      await page.keyboard.press("Tab");
      assert.equal(await editor.evaluate(element => element.contains(document.activeElement)), true, "Keyboard focus must remain in the active editor");
    }
    await editor.getByLabel("Start", { exact: true }).fill("23:45");
    await editor.getByRole("button", { name: "Book appointment", exact: true }).click();
    await editor.getByRole("alert").filter({ hasText: "midnight" }).waitFor();
    assert.equal(fixture.mutations.filter(item => item.operation === "appointments").length, 0);
    await editor.getByLabel("Start", { exact: true }).fill("09:00");
    await editor.getByRole("button", { name: "Book appointment", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    assert.equal(records.appointments.at(-1).date, "2027-02-15");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Book", "Closing restores focus to the booking action");
    await page.getByRole("button", { name: "Show Monday 15 February 2027", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Day", exact: true }).getAttribute("aria-pressed"), "true");
    await page.locator("main").evaluate(element => { element.scrollTop = 0; });
    await capture(page, output, `schedule-selected-date-${width}.png`);
    await page.getByLabel("Go to date", { exact: true }).fill(records.appointments[0].date);
    await page.getByRole("button", { name: /UI Workflow Customer/ }).first().click();
    const appointment = page.getByRole("dialog", { name: "Appointment", exact: true });
    await appointment.getByLabel("Amount received", { exact: true }).fill("18.75");
    await appointment.getByRole("button", { name: "Mark paid", exact: true }).click();
    await appointment.waitFor({ state: "hidden" });
    const localId = fixture.select("SELECT id FROM appointments WHERE remote_id=?", [records.appointments[0].id])[0].id;
    const receipt = fixture.select("SELECT transaction_id FROM appointments WHERE id=?", [localId])[0].transaction_id;
    assert.equal(fixture.select("SELECT amount_pence FROM transactions WHERE id=?", [receipt])[0].amount_pence, 1875);
    await page.getByRole("button", { name: /UI Workflow Customer/ }).first().click();
    await appointment.getByRole("button", { name: "Mark cancelled", exact: true }).click();
    await appointment.waitFor({ state: "hidden" });
    assert.equal(records.appointments[0].status, "cancelled");
    assert.equal(fixture.select("SELECT transaction_id FROM appointments WHERE id=?", [localId])[0].transaction_id, receipt);
    await page.getByRole("button", { name: /UI Workflow Customer/ }).first().click();
    await appointment.getByRole("button", { name: "Restore booking", exact: true }).click();
    await appointment.waitFor({ state: "hidden" });
    assert.equal(records.appointments[0].status, "confirmed");
    assert.equal(fixture.select("SELECT transaction_id FROM appointments WHERE id=?", [localId])[0].transaction_id, receipt);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM transactions")[0].n, 1);
    await page.getByRole("button", { name: /UI Workflow Customer/ }).first().click();
    await appointment.getByRole("button", { name: "Delete booking", exact: true }).click();
    const nested = page.getByRole("dialog", { name: "Delete appointment?", exact: true });
    await nested.waitFor();
    for (let index = 0; index < 7; index++) { await page.keyboard.press("Tab"); assert.equal(await nested.evaluate(element => element.contains(document.activeElement)), true); }
    await page.keyboard.press("Escape");
    await nested.waitFor({ state: "hidden" });
    await appointment.getByRole("button", { name: "Cancel", exact: true }).click();
    await appointment.waitFor({ state: "hidden" });
    await page.locator('nav a[title="Clients"]').click();
    const client = page.getByRole("button", { name: records.clients[0].name, exact: true });
    await client.waitFor(); await client.focus(); await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Edit client", exact: true }).waitFor();
    assert.deepEqual(errors, []);
    return { width, deviceTimezone: "America/Los_Angeles", dashboardDiary: true, selectedMonthBooking: true, asyncFormGuard: true, keyboardDateNavigation: true, modalAndNestedFocusTrap: true, focusRestoration: true, crossMidnightBlocked: true, actualPaymentAndPaidCancellationRestorePreserveReceipt: true, keyboardClientSelection: true };
  } catch (error) { await page.screenshot({ path: resolve(output, `failure-${width}.png`), fullPage: true }); throw error; }
  finally { await page.close(); fixture.close(); }
}

async function failureState(browser, output) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const fixture = await installDesktopFixture(page, data());
  await page.addInitScript(() => {
    window.__failFinance = true;
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (window.__failFinance && command === "db_select" && args.sql.includes("GROUP BY month")) throw new Error("Fixture finance read failed");
      return original(command, args);
    };
  });
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("alert").filter({ hasText: "Fixture finance read failed" }).waitFor();
    assert.ok(await page.getByText("Unavailable", { exact: true }).count() >= 3, "A read failure must not look like zero income, expense or profit");
    await capture(page, output, "dashboard-read-failure.png");
    await page.evaluate(() => { window.__failFinance = false; });
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Fixture finance read failed" }).waitFor({ state: "hidden" });
    assert.equal(await page.getByText("Unavailable", { exact: true }).count(), 0);
    return { visibleReadFailureDistinctFromZero: true, retryRecovers: true };
  } finally { await page.close(); fixture.close(); }
}

async function loaderScope(browser) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  try {
    await page.evaluate(async () => {
      const { mount } = await import("/tests/ui-loader-fixture.tsx");
      const controls = mount();
      window.__loadFixtureResolve = controls.resolve;
      window.__loadFixtureScope = controls.scope;
    });
    const result = page.locator("#load-scope");
    await result.waitFor();
    await page.evaluate(() => window.__loadFixtureResolve("first", "first-client-data"));
    await until(page, async () => await result.textContent() === "first-client-data:");
    await page.evaluate(() => window.__loadFixtureScope("second"));
    await until(page, async () => await result.textContent() === "empty:");
    assert.equal(await result.getAttribute("data-loading"), "true");
    await page.evaluate(() => window.__loadFixtureResolve("second", "second-client-data"));
    await until(page, async () => await result.textContent() === "second-client-data:");
    const clocks = await page.evaluate(async () => {
      const { businessNow } = await import("/src/lib/dates.ts");
      const { isoDate, parseAmount } = await import("/src/lib/format.ts");
      return ["2026-10-02T23:30:00Z", "2026-12-31T23:30:00Z"].map(value => { const now = businessNow(new Date(value)); return { date: isoDate(now), hour: now.getHours(), minute: now.getMinutes() }; }).concat([{ valid: parseAmount("£1,200.50"), overflow: parseAmount("90071992547409.92") }]);
    });
    assert.deepEqual(clocks, [{ date: "2026-10-03", hour: 0, minute: 30 }, { date: "2026-12-31", hour: 23, minute: 30 }, { valid: 120050, overflow: null }]);
    return { scopedLoaderNeverShowsPreviousClientData: true, londonClockAndExactSafePence: true };
  } finally { await page.close(); }
}

async function until(page, condition) {
  const deadline = Date.now() + 15_000;
  while (!await condition()) { assert.ok(Date.now() < deadline, "UI fixture did not reach expected state"); await page.waitForTimeout(40); }
}
