import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertLocal, capture, installDesktopFixture } from "./features-browser.js";

const require = createRequire(import.meta.url);
const url = process.env.FFYON_INBOX_ROOT_URL;

// Opt-in browser evidence uses only loopback and disposable native IPC/storage fixtures.
if (url) await run();

async function run() {
  assertLocal(url);
  const { chromium } = require(process.env.FFYON_PLAYWRIGHT_PATH || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.FFYON_BROWSER_CHANNEL ? { channel: process.env.FFYON_BROWSER_CHANNEL } : {}) });
  const output = resolve("test-results/inbox-browser");
  await mkdir(output, { recursive: true });
  const widths = process.env.FFYON_INBOX_WIDTHS ? process.env.FFYON_INBOX_WIDTHS.split(",").map(Number) : [1280, 1024, 800, 640, 375, 320];
  assert.ok(widths.length && widths.every(width => Number.isInteger(width) && width >= 320 && width <= 1920));
  const evidence = [];
  try {
    for (const width of widths) evidence.push(await inboxFlows(browser, width, output));
    const report = {
      storage: "Actual native migrations and disposable in-memory SQLite IPC fixture",
      nativeLimit: "Browser evidence does not verify native OS delivery, WebView2, macOS notifications or credentials",
      evidence,
    };
    await writeFile(resolve(output, "evidence.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
}

function businessDate(now) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
function dateOffset(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function inboxFlows(browser, width, output) {
  const viewport = { width, height: width >= 640 ? 900 : width === 375 ? 812 : 740 };
  const now = new Date().toISOString();
  const today = businessDate(new Date());
  const yesterday = dateOffset(today, -1);
  const tomorrow = dateOffset(today, 1);
  const names = [
    "Past confirmed customer with a longer name for narrow-screen checks",
    "Date-only completed customer",
    "Unknown quote customer",
    "Website request customer",
    "Cancelled appointment customer",
    "Rejected appointment customer",
    "No-show appointment customer",
    "Free treatment customer",
    "Future appointment customer",
    "Date-only today customer",
    "Already paid customer",
  ];
  const clients = names.map((name, index) => ({
    id: `00000000-0000-4000-8000-${String(7101 + index).padStart(12, "0")}`,
    account_id: null, merged_into: null, name, email: `inbox${index}@example.invalid`, phone: "",
    saved_address: "", saved_postcode: "", disabled: false, revision: 1, updated_at: now,
  }));
  const service = {
    id: "inbox-browser-treatment", name: "Saved treatment with a personalised colour consultation",
    description: "Disposable Inbox fixture", duration_min: 45, price_pence: 2750, discount_percent: 20, booking_price_pence: 2200, active: true, revision: 1,
  };
  const appointments = names.map((_name, index) => ({
    id: `00000000-0000-4000-8000-${String(7301 + index).padStart(12, "0")}`,
    client_id: clients[index].id, service_id: service.id, service_name: service.name,
    date: yesterday, start_time: "10:00", time_confirmed: true, duration_min: 45,
    price_pence: 2200, base_price_pence: 2750, discount_percent: 20,
    is_remote: false, visit_address: "", visit_postcode: "", notes: "Inbox fixture",
    status: "confirmed", revision: 1, proposed_date: null, proposed_start_time: null,
    proposed_time_confirmed: null, series_id: null, created_at: now, updated_at: now,
  }));
  Object.assign(appointments[1], { time_confirmed: false, start_time: "00:00", price_pence: 1800 });
  Object.assign(appointments[2], { price_pence: null, base_price_pence: null, discount_percent: 0 });
  appointments[3].status = "pending";
  appointments[4].status = "cancelled";
  appointments[5].status = "rejected";
  appointments[6].status = "no_show";
  Object.assign(appointments[7], { price_pence: 0, discount_percent: 100 });
  appointments[8].date = tomorrow;
  Object.assign(appointments[9], { date: today, time_confirmed: false, start_time: "00:00" });
  const records = {
    clients, appointments, services: [service], blocks: [],
    settings: {
      booking_enabled: true, timezone: "Europe/London", slot_minutes: 30, horizon_days: 90,
      opening_hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, open: "09:00", close: "17:00" })),
      admin_notifications_enabled: false, admin_notification_email: "", revision: 1,
    },
  };
  const page = await browser.newPage({ viewport, timezoneId: "Europe/London" });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const fixture = await installDesktopFixture(page, records);
  await page.addInitScript(() => {
    // Headless browser permission must not stand in for the fixture's approved desktop permission.
    Object.defineProperty(window.Notification, "permission", { configurable: true, get: () => "default" });
  });
  const notifications = () => fixture.commands.filter(item => item.command === "notify_payment_confirmation");
  try {
    fixture.execute("INSERT INTO clients(id,name,remote_id) VALUES (101,?,?)", [clients[10].name, clients[10].id]);
    fixture.execute("INSERT INTO transactions(id,type,date,amount_pence,client_id) VALUES (201,'income',?,2200,101)", [yesterday]);
    fixture.execute(`INSERT INTO appointments
      (id,remote_id,client_id,date,start_time,duration_min,price_pence,status,transaction_id,service_id,service_name)
      VALUES (201,?,101,?,'10:00',45,2200,'confirmed',201,?,?)`, [appointments[10].id, yesterday, service.id, service.name]);
    const legacyUrl = new URL(url);
    legacyUrl.hash = "/requests";
    await page.goto(legacyUrl.href, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "To do", exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, "#/todo", "Old Requests bookmarks must redirect to To do");
    legacyUrl.hash = "/inbox";
    await page.goto(legacyUrl.href, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "To do", exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, "#/todo", "Old Inbox bookmarks must redirect to To do");
    await page.locator('nav a[title="To do"]').click();
    await page.getByRole("heading", { name: "To do", exact: true }).waitFor();
    const requests = page.locator('section[aria-labelledby="requests-heading"]');
    const payments = page.locator('section[aria-labelledby="payments-heading"]');
    await until(page, () => fixture.select("SELECT COUNT(*) AS n FROM appointments")[0].n === appointments.length);
    const localIds = appointments.map(appointment => fixture.select("SELECT id FROM appointments WHERE remote_id=?", [appointment.id])[0].id);
    const paymentRow = (index) => page.getByTestId(`payment-confirmation-${localIds[index]}`);
    await paymentRow(0).waitFor();
    await paymentRow(1).waitFor();
    await paymentRow(2).waitFor();
    await requests.getByRole("button", { name: clients[3].name, exact: true }).waitFor();
    await until(page, async () => await payments.locator('li[data-testid^="payment-confirmation-"]').count() === 3);
    assert.equal(await requests.locator("li").count(), 1, "Website decisions stay separate from local payment confirmations");
    assert.equal(await page.getByTestId("todo-badge").innerText(), "4");
    assert.match(await page.locator('nav a[title="To do"]').getAttribute("aria-label"), /4 appointments needing attention/);
    for (let index = 3; index < clients.length; index++) assert.equal(await paymentRow(index).count(), 0, `${clients[index].name} must not appear in payment confirmations`);
    assert.equal(await paymentRow(1).getByText(/Date only/).count(), 1, "Past confirmed date-only booking remains eligible");
    assert.equal(await paymentRow(0).getByRole("textbox").inputValue(), "22.00");
    assert.equal(await paymentRow(2).getByRole("textbox").inputValue(), "");
    assert.equal(await paymentRow(2).getByRole("button", { name: "Confirm paid", exact: true }).isDisabled(), true);
    await capture(page, output, `inbox-sections-${width}.png`);
    await payments.getByRole("heading", { name: /^Payments to confirm/ }).scrollIntoViewIfNeeded();
    await capture(page, output, `inbox-payment-confirmations-${width}.png`);

    await until(page, () => notifications().length === 1);
    assert.deepEqual(notifications()[0].args, { count: 3 }, "Desktop reminders contain only a count, not customer names or details");
    await repeatSync(page);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "To do", exact: true }).waitFor();
    await paymentRow(0).waitFor();
    await repeatSync(page);
    await page.waitForTimeout(300);
    assert.equal(notifications().length, 1, "Repeated synchronization and restart must not repeat a delivered reminder");

    await paymentRow(0).getByRole("textbox").fill("17.50");
    await paymentRow(0).scrollIntoViewIfNeeded();
    await capture(page, output, `inbox-actual-payment-${width}.png`);
    await paymentRow(0).locator("form").evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await paymentRow(0).waitFor({ state: "hidden" });
    await until(page, async () => await page.getByTestId("todo-badge").innerText() === "3");
    const paid = fixture.select("SELECT transaction_id,price_pence,status FROM appointments WHERE id=?", [localIds[0]])[0];
    assert.ok(paid.transaction_id);
    assert.equal(paid.price_pence, 2200, "Actual received amount must not rewrite the saved booking quote");
    assert.equal(paid.status, "confirmed");
    assert.deepEqual(fixture.select("SELECT amount_pence,service_id,service_name FROM transactions WHERE id=?", [paid.transaction_id])[0], { amount_pence: 1750, service_id: service.id, service_name: service.name });
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM transactions WHERE client_id=(SELECT client_id FROM appointments WHERE id=?)", [localIds[0]])[0].n, 1, "Two rapid UI submissions must create only one payment");
    assert.equal(await requests.getByRole("button", { name: clients[3].name, exact: true }).count(), 1);
    assert.equal(records.appointments[3].status, "pending");

    await paymentRow(2).getByRole("textbox").fill("0");
    assert.equal(await paymentRow(2).getByRole("button", { name: "Confirm paid", exact: true }).isDisabled(), true);
    await paymentRow(2).getByRole("textbox").fill("18.50");
    await paymentRow(2).getByRole("button", { name: "Confirm paid", exact: true }).click();
    await paymentRow(2).waitFor({ state: "hidden" });
    await until(page, async () => await page.getByTestId("todo-badge").innerText() === "2");
    const unknownPaid = fixture.select("SELECT transaction_id,price_pence FROM appointments WHERE id=?", [localIds[2]])[0];
    assert.equal(unknownPaid.price_pence, null);
    assert.equal(fixture.select("SELECT amount_pence FROM transactions WHERE id=?", [unknownPaid.transaction_id])[0].amount_pence, 1850);
    assert.equal(fixture.mutations.length, 0, "Quick payment confirmation must never mutate shared bookings, requests or email settings");

    await page.locator('nav a[title="Settings"]').click();
    await page.getByRole("button", { name: "This computer", exact: true }).click();
    const reminders = page.getByRole("checkbox", { name: "Desktop payment reminders", exact: true });
    await reminders.waitFor();
    assert.equal(await reminders.isChecked(), true);
    await reminders.uncheck();
    assert.equal(await page.evaluate(() => localStorage.getItem("ffyon-payment-reminders")), "off");
    await reminders.scrollIntoViewIfNeeded();
    await capture(page, output, `inbox-reminders-disabled-${width}.png`);
    Object.assign(records.appointments[8], { date: yesterday, revision: 2 });
    await repeatSync(page);
    await page.locator('nav a[title="To do"]').click();
    await paymentRow(8).waitFor();
    await until(page, async () => await page.getByTestId("todo-badge").innerText() === "3");
    assert.equal(notifications().length, 1, "Disabled desktop reminders leave the Inbox badge and payment section active");
    await page.reload({ waitUntil: "networkidle" });
    await paymentRow(8).waitFor();
    await repeatSync(page);
    await page.waitForTimeout(300);
    assert.equal(notifications().length, 1, "Disabled desktop preference persists across restart");
    await page.locator('nav a[title="Settings"]').click();
    await reminders.waitFor();
    assert.equal(await reminders.isChecked(), false);
    await reminders.check();
    await until(page, () => notifications().length === 2);
    assert.deepEqual(notifications()[1].args, { count: 2 });
    await reminders.scrollIntoViewIfNeeded();
    await capture(page, output, `inbox-reminders-enabled-${width}.png`);
    await page.reload({ waitUntil: "networkidle" });
    await reminders.waitFor();
    assert.equal(await reminders.isChecked(), true);
    await repeatSync(page);
    await page.waitForTimeout(300);
    assert.equal(notifications().length, 2);
    assert.equal(fixture.mutations.length, 0, "Desktop reminder preferences and local payments must never upload financial data or send customer emails");
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM transactions")[0].n, 3);
    assert.deepEqual(fixture.select("PRAGMA foreign_key_check"), []);
    assert.deepEqual(pageErrors, []);
    return {
      viewport, legacyRequestsRouteRedirectsToInbox: true, separateRequestsAndCompletedPayments: true, excludesUnconfirmedCancelledRejectedNoShowPaidFreeAndFuture: true,
      confirmedDateOnlyWaitsUntilFollowingDay: true, badgeIncludesRequestsAndPayments: true,
      actualAmountAndExactlyOnceQuickPayment: true, unknownPriceRequiresAmount: true,
      countOnlyNotificationsDeduplicatedAcrossSyncAndRestart: true, desktopPreferencePersistsAndKeepsInboxActive: true,
      noSharedPaymentMutationsOrCustomerEmails: true,
    };
  } finally { await page.close(); fixture.close(); }
}

async function repeatSync(page) {
  await page.evaluate(async () => {
    const sync = await import("/src/lib/sync.ts");
    await sync.syncNow();
    window.dispatchEvent(new Event("focus"));
  });
}

async function until(page, condition) {
  const deadline = Date.now() + 15_000;
  while (!await condition()) {
    assert.ok(Date.now() < deadline, "Inbox fixture did not reach the expected state");
    await page.waitForTimeout(50);
  }
}
