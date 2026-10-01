import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertLocal, capture, installDesktopFixture } from "./features-browser.js";

const require = createRequire(import.meta.url);
const url = process.env.FFYON_CATALOGUE_ROOT_URL;

// Opt-in, disposable browser evidence. Never opens the production database or Site.
if (url) await run();

async function run() {
  assertLocal(url);
  const { chromium } = require(process.env.FFYON_PLAYWRIGHT_PATH || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.FFYON_BROWSER_CHANNEL ? { channel: process.env.FFYON_BROWSER_CHANNEL } : {}) });
  const output = resolve("test-results/catalogue-browser");
  await mkdir(output, { recursive: true });
  const widths = process.env.FFYON_CATALOGUE_WIDTHS ? process.env.FFYON_CATALOGUE_WIDTHS.split(",").map(Number) : [1280, 1024, 800, 640, 375, 320];
  assert.ok(widths.length && widths.every(width => Number.isInteger(width) && width >= 320 && width <= 1920));
  const evidence = [];
  try {
    for (const width of widths) evidence.push(await catalogueFlows(browser, width, output));
    const report = { storage: "Actual native migrations and disposable in-memory SQLite IPC fixture", nativeLimit: "Browser evidence does not exercise native tray menus, OS credentials, WebView2 or macOS", evidence };
    await writeFile(resolve(output, "evidence.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
}

async function catalogueFlows(browser, width, output) {
  const viewport = { width, height: width >= 640 ? 900 : width === 375 ? 812 : 740 };
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const now = new Date().toISOString();
  const services = [
    { id: "catalogue-qa-express", name: "Express spray tan with a personalised colour consultation", description: "Disposable catalogue fixture", duration_min: 45, price_pence: 2750, discount_percent: 20, booking_price_pence: 2200, active: true, revision: 1 },
    { id: "catalogue-qa-classic", name: "Classic tan", description: "Second active fixture service", duration_min: 60, price_pence: 3500, discount_percent: 0, booking_price_pence: 3500, active: true, revision: 1 },
    { id: "catalogue-qa-archived", name: "Archived bronze treatment", description: "Historic fixture service", duration_min: 30, price_pence: 9900, discount_percent: 0, booking_price_pence: 9900, active: false, revision: 1 },
  ];
  const client = { id: "00000000-0000-4000-8000-000000009101", account_id: null, merged_into: null, name: "Catalogue Browser Customer", email: "catalogue.browser@example.invalid", phone: "", saved_address: "", saved_postcode: "", disabled: false, revision: 1, updated_at: now };
  const appointment = { id: "00000000-0000-4000-8000-000000009301", client_id: client.id, service_id: services[0].id, service_name: "Saved appointment treatment", date, start_time: "10:00", time_confirmed: true, duration_min: 30, price_pence: 1875, base_price_pence: 2500, discount_percent: 25, is_remote: false, visit_address: "", visit_postcode: "", notes: "Historic quote fixture", status: "confirmed", revision: 1, proposed_date: null, proposed_start_time: null, proposed_time_confirmed: null, series_id: null, created_at: now, updated_at: now };
  const records = { clients: [client], services, appointments: [appointment], blocks: [], settings: { booking_enabled: true, timezone: "Europe/London", slot_minutes: 30, horizon_days: 90, opening_hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, open: "09:00", close: "17:00" })), admin_notifications_enabled: false, admin_notification_email: "", revision: 1 } };
  const page = await browser.newPage({ viewport, timezoneId: "Europe/London" });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const fixture = await installDesktopFixture(page, records);
  try {
    fixture.execute("DELETE FROM categories");
    for (const category of [
      [901, services[0].name, "income", "legacy", null],
      [902, "Historic product sale", "income", "legacy", null],
      [903, "Tips", "income", "other", 500],
      [904, "Supplies", "expense", "legacy", null],
    ]) fixture.execute("INSERT INTO categories(id,name,type,colour,income_kind,default_pence) VALUES(?,?,?,'#BB6677',?,?)", category);
    const txKind = fixture.select("PRAGMA table_info(transactions)").some(column => column.name === "income_kind");
    const seed = (id, categoryId, amount, name, serviceId = null, serviceName = "", kind = "legacy") => fixture.execute(`INSERT INTO transactions(id,type,date,amount_pence,category_id,client_id,description,service_id,service_name,category_name_snapshot${txKind ? ",income_kind" : ""}) VALUES(?,'income',?,?,?,NULL,NULL,?,?,?${txKind ? ",?" : ""})`, [id, date, amount, categoryId, serviceId, serviceName, name, ...(txKind ? [kind] : [])]);
    seed(901, 901, 987, services[0].name);
    seed(902, 902, 680, "Historic product sale");
    seed(903, null, 3100, "", services[2].id, "Saved bronze treatment", "service");

    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator('nav a[title="Settings"]').click();
    await page.getByRole("heading", { name: "Services", exact: true }).waitFor();
    assert.equal(fixture.select("SELECT service_id,income_kind FROM categories WHERE id=901")[0].service_id, null, "Matching names must not guess an explicit service relationship");
    assert.equal(fixture.select("SELECT income_kind FROM categories WHERE id=901")[0].income_kind, "legacy");
    assert.equal(await page.getByRole("heading", { name: "Income categories", exact: true }).count(), 0);
    await page.getByRole("heading", { name: "Other income", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Expense categories", exact: true }).waitFor();
    await until(page, () => fixture.commands.some(command => command.command === "set_tray_state" && command.args.state.quickAdd.some(item => item.id === services[0].id)));
    const initialTray = fixture.commands.filter(command => command.command === "set_tray_state").at(-1).args.state;
    assert.deepEqual(initialTray.quickAdd.map(item => item.id).sort(), services.filter(service => service.active).map(service => service.id).sort());
    assert.ok(initialTray.quickAdd.find(item => item.id === services[0].id).label.includes("20% off"));
    assert.match(initialTray.quickAdd.find(item => item.id === services[0].id).label, /\u00a322(?:\.00)?/);
    await page.getByRole("button", { name: "Add other income", exact: true }).click();
    const otherEditor = page.getByRole("dialog", { name: "Add other income", exact: true });
    await otherEditor.waitFor();
    assert.equal(await otherEditor.getByLabel(/Usual price|Price|Service|Duration/i).count(), 0, "Non-bookable income must not maintain a treatment price or duration");
    await otherEditor.getByLabel("Name", { exact: true }).fill("Product sale");
    await otherEditor.getByRole("button", { name: "Save", exact: true }).click();
    await otherEditor.waitFor({ state: "hidden" });
    assert.deepEqual(fixture.select("SELECT type,income_kind,service_id,default_pence FROM categories WHERE name='Product sale'")[0], { type: "income", income_kind: "other", service_id: null, default_pence: null });
    await capture(page, output, `catalogue-settings-${width}.png`);
    await page.getByRole("button", { name: `Edit ${services[0].name}`, exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit service", exact: true });
    await editor.waitFor();
    assert.equal(await editor.getByLabel(/Income category|Income mapping|Payment category/i).count(), 0, "Service editor must not maintain a duplicate treatment category");
    await capture(page, output, `catalogue-service-editor-${width}.png`);
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();

    await openEntry(page);
    let entry = page.getByRole("dialog", { name: "New entry", exact: true });
    await entry.getByLabel(/^Payment for/).selectOption("service");
    await entry.getByLabel(/^Service/).selectOption(services[0].id);
    await page.waitForFunction(() => document.querySelector('[role="dialog"] input[inputmode="decimal"]')?.value === "22.00");
    assert.equal(await entry.getByLabel(/^Amount/).inputValue(), "22.00", "Standalone treatment payment defaults to the live discounted catalogue price");
    assert.equal(await entry.getByLabel(/^Service/).locator(`option[value="${services[2].id}"]`).count(), 0, "Archived services must not be offered for a new payment");
    assert.equal(await entry.getByLabel("Category", { exact: true }).count(), 0);
    await entry.getByLabel(/^Amount/).fill("19.37");
    await capture(page, output, `catalogue-standalone-payment-${width}.png`);
    await entry.getByRole("button", { name: "Record payment", exact: true }).click();
    await entry.waitFor({ state: "hidden" });
    const standalone = fixture.select("SELECT * FROM transactions WHERE id > 903 ORDER BY id")[0];
    assert.ok(standalone);
    assert.equal(standalone.amount_pence, 1937);
    assert.equal(standalone.service_id, services[0].id);
    assert.equal(standalone.service_name, services[0].name);
    assert.equal(records.appointments.length, 1, "Standalone service payment must not create a booking or request");
    assert.equal(fixture.mutations.filter(mutation => mutation.operation === "appointments").length, 0);

    await openEntry(page);
    entry = page.getByRole("dialog", { name: "New entry", exact: true });
    await entry.getByLabel(/^Payment for/).selectOption("appointment");
    const paymentAppointment = entry.getByLabel(/^Appointment/);
    assert.equal(await paymentAppointment.inputValue(), "", "Payment must require an explicit appointment choice");
    const localAppointment = fixture.select("SELECT id FROM appointments WHERE remote_id=?", [appointment.id])[0];
    await paymentAppointment.selectOption(String(localAppointment.id));
    assert.equal(await entry.getByLabel(/^Amount/).inputValue(), "18.75", "Appointment payment uses its saved quote rather than today's price");
    await entry.getByLabel(/^Amount/).fill("17.50");
    await capture(page, output, `catalogue-appointment-payment-${width}.png`);
    await entry.getByRole("button", { name: "Record payment", exact: true }).click();
    await entry.waitFor({ state: "hidden" });
    const paid = fixture.select("SELECT transaction_id,price_pence FROM appointments WHERE id=?", [localAppointment.id])[0];
    assert.ok(paid.transaction_id);
    assert.equal(paid.price_pence, 1875);
    assert.deepEqual(fixture.select("SELECT amount_pence,service_id,service_name FROM transactions WHERE id=?", [paid.transaction_id])[0], { amount_pence: 1750, service_id: services[0].id, service_name: "Saved appointment treatment" });
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM transactions")[0].n, 5);
    assert.equal(records.appointments.length, 1);
    assert.equal(fixture.mutations.filter(mutation => mutation.operation === "appointments").length, 0, "Recording money must not rewrite the shared diary");
    await openEntry(page);
    entry = page.getByRole("dialog", { name: "New entry", exact: true });
    await entry.getByLabel(/^Payment for/).selectOption("appointment");
    assert.equal(await entry.getByLabel(/^Appointment/).locator(`option[value="${localAppointment.id}"]`).count(), 0, "Paid appointment must not offer a second payment");
    await entry.getByRole("button", { name: "Cancel", exact: true }).click();

    await openEntry(page);
    entry = page.getByRole("dialog", { name: "New entry", exact: true });
    await entry.getByLabel(/^Payment for/).selectOption("other");
    await entry.getByLabel(/^Income type/).selectOption("903");
    await entry.getByLabel(/^Amount/).fill("6.43");
    await capture(page, output, `catalogue-other-income-${width}.png`);
    await entry.getByRole("button", { name: "Record payment", exact: true }).click();
    await entry.waitFor({ state: "hidden" });
    assert.equal(fixture.select("SELECT amount_pence FROM transactions WHERE category_id=903")[0].amount_pence, 643);
    await openEntry(page);
    entry = page.getByRole("dialog", { name: "New entry", exact: true });
    await entry.getByRole("button", { name: "Money out", exact: true }).click();
    await entry.getByLabel(/^Expense category/).selectOption("904");
    await entry.getByLabel(/^Amount/).fill("7.25");
    await capture(page, output, `catalogue-expense-${width}.png`);
    await entry.getByRole("button", { name: "Add expense", exact: true }).click();
    await entry.waitFor({ state: "hidden" });
    assert.deepEqual(fixture.select("SELECT type,amount_pence,service_id FROM transactions WHERE category_id=904")[0], { type: "expense", amount_pence: 725, service_id: null });

    await page.locator('nav a[title="Settings"]').click();
    await reviewLegacy(page, services[0].name, services[0].id);
    await reviewLegacy(page, "Historic product sale", null);
    assert.deepEqual(fixture.select("SELECT income_kind,service_id FROM categories WHERE id=901")[0], { income_kind: "service", service_id: services[0].id });
    assert.deepEqual(fixture.select("SELECT income_kind,service_id FROM categories WHERE id=902")[0], { income_kind: "other", service_id: null });
    assert.equal(fixture.select("SELECT amount_pence FROM transactions WHERE id=901")[0].amount_pence, 987);
    assert.equal(fixture.select("SELECT amount_pence,category_name_snapshot FROM transactions WHERE id=902")[0].amount_pence, 680);
    await capture(page, output, `catalogue-reviewed-income-${width}.png`);

    const originalName = services[0].name;
    await page.getByRole("button", { name: `Edit ${originalName}`, exact: true }).click();
    const rename = page.getByRole("dialog", { name: "Edit service", exact: true });
    await rename.getByLabel("Name", { exact: true }).fill("Renamed express treatment");
    await rename.getByLabel("Price (GBP)", { exact: true }).fill("99.00");
    await rename.getByRole("button", { name: "Save", exact: true }).click();
    await rename.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Archive Renamed express treatment", exact: true }).click();
    await page.getByRole("button", { name: "Archive Renamed express treatment", exact: true }).waitFor({ state: "hidden" });
    await until(page, () => {
      const latest = fixture.commands.filter(command => command.command === "set_tray_state").at(-1)?.args.state;
      return latest && latest.quickAdd.length === 1 && latest.quickAdd[0].id === services[1].id;
    });
    assert.deepEqual(fixture.select("SELECT amount_pence,service_name FROM transactions WHERE id=?", [standalone.id])[0], { amount_pence: 1937, service_name: originalName });
    assert.equal(records.appointments[0].service_name, "Saved appointment treatment");
    assert.equal(records.appointments[0].price_pence, 1875);
    assert.deepEqual(fixture.select("SELECT amount_pence,service_name FROM transactions WHERE id=903")[0], { amount_pence: 3100, service_name: "Saved bronze treatment" });
    await openEntry(page);
    entry = page.getByRole("dialog", { name: "New entry", exact: true });
    await entry.getByLabel(/^Payment for/).selectOption("service");
    assert.equal(await entry.getByLabel(/^Service/).locator(`option[value="${services[0].id}"]`).count(), 0);
    await entry.getByRole("button", { name: "Cancel", exact: true }).click();

    await page.locator('nav a[title="Schedule"]').click();
    await page.getByRole("button", { name: "Day", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(client.name) }).first().click();
    const savedBooking = page.getByRole("dialog", { name: "Appointment", exact: true });
    await savedBooking.waitFor();
    await page.waitForFunction(name => document.querySelector('[placeholder="Search or add a client (optional)"]')?.value === name, client.name);
    assert.equal(await savedBooking.getByLabel(/^Price/).inputValue(), "18.75");
    assert.equal(await savedBooking.getByLabel(/^Length/).inputValue(), "30");
    assert.equal(await savedBooking.getByLabel("Category", { exact: true }).count(), 0);
    assert.ok((await savedBooking.getByLabel(/^Service/).locator(`option[value="${services[0].id}"]`).innerText()).includes("Saved appointment treatment"));
    await savedBooking.getByLabel(/^Service/).selectOption(services[1].id);
    assert.equal(await savedBooking.getByLabel(/^Price/).inputValue(), "35.00");
    assert.equal(await savedBooking.getByLabel(/^Length/).inputValue(), "60");
    await savedBooking.getByLabel(/^Service/).selectOption(services[0].id);
    assert.equal(await savedBooking.getByLabel(/^Price/).inputValue(), "18.75");
    assert.equal(await savedBooking.getByLabel(/^Length/).inputValue(), "30");
    await capture(page, output, `catalogue-historical-appointment-${width}.png`);
    await savedBooking.getByRole("button", { name: "Cancel", exact: true }).click();

    await page.locator('nav a[title="Monthly"]').click();
    await page.getByText("Saved bronze treatment", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Money in", exact: true }).click();
    await page.getByLabel("Income type", { exact: true }).selectOption("service");
    await page.getByText(originalName, { exact: true }).first().waitFor();
    assert.equal(await page.getByText("Tips", { exact: true }).count(), 0);
    await capture(page, output, `catalogue-historical-service-payments-${width}.png`);
    const historicRow = page.getByRole("row").filter({ has: page.getByText("Saved bronze treatment", { exact: true }) });
    await historicRow.getByRole("button", { name: "Edit", exact: true }).click();
    const historicEntry = page.getByRole("dialog", { name: "Edit entry", exact: true });
    await historicEntry.waitFor();
    await page.waitForFunction(() => document.querySelector('[role="dialog"] input[inputmode="decimal"]')?.value === "31.00");
    assert.equal(await historicEntry.getByLabel(/^Amount/).inputValue(), "31.00", "Editing archived history must not reprice to the current catalogue");
    assert.ok((await historicEntry.getByLabel(/^Service/).locator(`option[value="${services[2].id}"]`).innerText()).includes("Saved bronze treatment"));
    await capture(page, output, `catalogue-historical-payment-editor-${width}.png`);
    await historicEntry.getByRole("button", { name: "Save changes", exact: true }).click();
    await historicEntry.waitFor({ state: "hidden" });
    assert.deepEqual(fixture.select("SELECT amount_pence,service_name FROM transactions WHERE id=903")[0], { amount_pence: 3100, service_name: "Saved bronze treatment" });

    const linkedRow = page.getByRole("row").filter({ has: page.getByText("Saved appointment treatment", { exact: true }) });
    await linkedRow.getByRole("button", { name: "Edit", exact: true }).click();
    const linkedEntry = page.getByRole("dialog", { name: "Edit entry", exact: true });
    await linkedEntry.getByLabel(/^Appointment payment/).waitFor();
    assert.equal(await linkedEntry.getByLabel(/^Appointment payment/).getAttribute("readonly"), "");
    assert.equal(await linkedEntry.getByLabel(/^Payment for/).count(), 0);
    assert.equal(await linkedEntry.getByRole("button", { name: "Money out", exact: true }).count(), 0, "An appointment payment cannot be detached by an income source correction");
    assert.equal(await linkedEntry.getByLabel(/^Amount/).inputValue(), "17.50");
    await capture(page, output, `catalogue-linked-payment-editor-${width}.png`);
    await linkedEntry.getByRole("button", { name: "Cancel", exact: true }).click();

    await historicRow.getByRole("button", { name: "Edit", exact: true }).click();
    const toExpense = page.getByRole("dialog", { name: "Edit entry", exact: true });
    await toExpense.getByLabel(/^Payment for/).waitFor();
    await toExpense.getByRole("button", { name: "Money out", exact: true }).click();
    await toExpense.getByLabel(/^Expense category/).selectOption("904");
    assert.equal(await toExpense.getByLabel(/^Amount/).inputValue(), "31.00");
    await capture(page, output, `catalogue-income-to-expense-correction-${width}.png`);
    await toExpense.getByRole("button", { name: "Save changes", exact: true }).click();
    await toExpense.waitFor({ state: "hidden" });
    assert.deepEqual(fixture.select("SELECT type,amount_pence,service_id,service_name,income_kind FROM transactions WHERE id=903")[0], { type: "expense", amount_pence: 3100, service_id: null, service_name: "", income_kind: null });

    const standaloneRow = page.getByRole("row").filter({ hasText: originalName }).filter({ hasText: "+\u00a319.37" });
    await standaloneRow.getByRole("button", { name: "Edit", exact: true }).click();
    const toOther = page.getByRole("dialog", { name: "Edit entry", exact: true });
    await toOther.getByLabel(/^Payment for/).selectOption("other");
    await toOther.getByLabel(/^Income type/).selectOption("903");
    assert.equal(await toOther.getByLabel(/^Amount/).inputValue(), "19.37");
    await capture(page, output, `catalogue-service-to-other-correction-${width}.png`);
    await toOther.getByRole("button", { name: "Save changes", exact: true }).click();
    await toOther.waitFor({ state: "hidden" });
    assert.deepEqual(fixture.select("SELECT amount_pence,service_id,service_name,income_kind FROM transactions WHERE id=?", [standalone.id])[0], { amount_pence: 1937, service_id: null, service_name: "", income_kind: "other" });

    await page.getByRole("button", { name: "Money out", exact: true }).click();
    const expenseRow = page.getByRole("row").filter({ hasText: "\u2212\u00a37.25" });
    await expenseRow.getByRole("button", { name: "Edit", exact: true }).click();
    const toService = page.getByRole("dialog", { name: "Edit entry", exact: true });
    await toService.getByLabel(/^Expense category/).waitFor();
    await toService.getByRole("button", { name: "Money in", exact: true }).click();
    await toService.getByLabel(/^Payment for/).selectOption("service");
    await toService.getByLabel(/^Service/).selectOption(services[1].id);
    assert.equal(await toService.getByLabel(/^Amount/).inputValue(), "7.25");
    await toService.getByRole("button", { name: "Save changes", exact: true }).click();
    await toService.waitFor({ state: "hidden" });
    assert.deepEqual(fixture.select("SELECT type,amount_pence,service_id,income_kind FROM transactions WHERE amount_pence=725")[0], { type: "income", amount_pence: 725, service_id: services[1].id, income_kind: "service" });

    await page.getByRole("button", { name: "Money in", exact: true }).click();
    await page.getByLabel("Income type", { exact: true }).selectOption("other");
    await page.getByText("Tips", { exact: true }).first().waitFor();
    await page.getByText("Historic product sale", { exact: true }).waitFor();
    assert.equal(await page.getByText("Saved bronze treatment", { exact: true }).count(), 0);
    await capture(page, output, `catalogue-other-income-report-${width}.png`);
    fixture.execute("INSERT INTO transactions(type,date,amount_pence,category_id,client_id,description,service_id,service_name,category_name_snapshot,income_kind) VALUES('income',?,1234567,NULL,NULL,'Large totals browser fixture',?,'Classic tan','','service')", [date, services[1].id]);
    fixture.execute("INSERT INTO transactions(type,date,amount_pence,category_id,client_id,description,service_id,service_name,category_name_snapshot,income_kind) VALUES('expense',?,234567,904,NULL,'Large totals browser fixture',NULL,'','Supplies',NULL)", [date]);
    await page.locator('nav a[title="Dashboard"]').click();
    await page.getByText("Income by service", { exact: true }).waitFor();
    const charts = await settleCharts(page);
    const fittedValues = await assertFittedValues(page);
    assert.ok(fittedValues.some(value => value.text === "\u00a312,412.89"), "Dashboard must display the entire realistic income amount, not abbreviate or clip it");
    const resizeEvidence = [];
    if (width === 1280) {
      for (const resizedWidth of [1280, 1024, 320, 1280]) {
        await page.setViewportSize({ width: resizedWidth, height: resizedWidth === 320 ? 740 : 900 });
        await settleCharts(page);
        resizeEvidence.push({ width: resizedWidth, values: await assertFittedValues(page) });
      }
      assert.equal(resizeEvidence.at(-1).values[0].fontSize, resizeEvidence[0].values[0].fontSize, "Fitted currency must recover its original size after widening");
    }
    const mainBounds = await page.locator("main").evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
    assert.ok(mainBounds.content <= mainBounds.width + 1, `Dashboard main content must not clip horizontally: ${JSON.stringify(mainBounds)}`);
    await dismissToasts(page);
    await page.locator("main").evaluate(element => { element.scrollTop = 0; });
    await capture(page, output, `catalogue-dashboard-${width}.png`);
    for (const [name, heading] of [["income-expenses", "Income vs expenses"], ["income-donut", "Tax year so far"], ["profit-bars", "Profit per month"]]) {
      await page.getByRole("heading", { name: heading, exact: true }).locator("xpath=../../..").screenshot({ path: resolve(output, `catalogue-chart-${name}-${width}.png`), animations: "disabled" });
    }
    assert.deepEqual(pageErrors, []);
    return { viewport, catalogueIsSingleTreatmentSource: true, liveDiscountDefaultActualAmountEditable: true, standalonePaymentCreatesNoBooking: true, existingAppointmentPaidOnceAtSavedQuote: true, otherIncomeAndExpensesSeparate: true, legacyChoicesExplicitNoNameGuessing: true, renameArchiveRetainHistoricNamesAndMoney: true, historicalEditorsDoNotReprice: true, explicitUnlinkedSourceCorrectionsPreserveActualAmount: true, linkedPaymentSourceRemainsFixed: true, reportIncomeKinds: true, trayPayloadUsesDiscountedActiveServicesOnly: true, charts, fittedValues, resizeEvidence, mainBounds, pageErrors };
  } catch (error) {
    await page.screenshot({ path: resolve(output, `catalogue-failure-${width}.png`), fullPage: true });
    console.error(JSON.stringify({ viewport, dialogs: await page.getByRole("dialog").allTextContents(), controls: await page.locator("input,textarea,select").evaluateAll(elements => elements.map(element => ({ type: element.type, value: element.value, label: element.closest("label")?.textContent }))) }, null, 2));
    throw error;
  } finally { await page.close(); fixture.close(); }
}

async function openEntry(page) {
  await page.getByRole("button", { name: "New entry", exact: true }).click();
  await page.getByRole("dialog", { name: "New entry", exact: true }).waitFor();
  await page.getByLabel(/^Payment for/).waitFor();
}

async function until(page, predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate() && Date.now() < deadline) await page.waitForTimeout(50);
  assert.ok(predicate(), "Expected fixture state did not settle");
}

async function settleCharts(page) {
  const selectors = [".recharts-area-curve", ".recharts-bar-rectangle path", ".recharts-pie-sector path"];
  await page.evaluate(() => { delete window.__ffyonChartEvidence; });
  // Recharts animates SVG geometry in JavaScript, beyond screenshot CSS controls.
  await page.waitForFunction(selectors => {
    const shapes = selectors.map(selector => [...document.querySelectorAll(selector)].map(element => {
      const bounds = element.getBBox();
      return { path: element.getAttribute("d"), width: bounds.width, height: bounds.height };
    }));
    if (!shapes.every(group => group.some(shape => shape.width > 1 && shape.height > 1))) return false;
    const signature = JSON.stringify(shapes);
    const previous = window.__ffyonChartEvidence;
    if (!previous || previous.signature !== signature) {
      window.__ffyonChartEvidence = { signature, changed: performance.now() };
      return false;
    }
    return performance.now() - previous.changed > 600;
  }, selectors, { timeout: 20000 });
  return page.evaluate(selectors => selectors.map(selector => ({
    selector,
    shapes: [...document.querySelectorAll(selector)].map(element => {
      const bounds = element.getBBox();
      return { width: bounds.width, height: bounds.height };
    }).filter(shape => shape.width > 1 && shape.height > 1),
  })), selectors);
}

async function assertFittedValues(page) {
  await page.waitForFunction(() => {
    const elements = [...document.querySelectorAll("[data-fitted-value]")];
    return elements.length >= 6 && elements.every(element => {
      const container = element.getBoundingClientRect();
      const text = element.firstElementChild.getBoundingClientRect();
      return container.width > 0 && text.left >= container.left - 1 && text.right <= container.right + 1;
    });
  }, null, { timeout: 5000 });
  const values = await page.locator("[data-fitted-value]").evaluateAll(elements => elements.map(element => {
    const container = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    return { text: element.textContent, fontSize: getComputedStyle(element.firstElementChild ?? element).fontSize,
      width: container.width, textWidth: text.width, left: container.left, right: container.right, textLeft: text.left, textRight: text.right };
  }));
  assert.ok(values.length >= 6, "Dashboard KPI and tax summary values need measurable fitted containers");
  assert.ok(values.every(value => value.textLeft >= value.left - 1 && value.textRight <= value.right + 1), `Complete monetary values must fit their own containers: ${JSON.stringify(values)}`);
  return values;
}

async function dismissToasts(page) {
  await page.getByRole("button", { name: "Close toast", exact: true }).evaluateAll(buttons => buttons.forEach(button => button.click()));
  await page.waitForFunction(() => !document.querySelector("[data-sonner-toast]"), null, { timeout: 5000 });
}

async function reviewLegacy(page, name, serviceId) {
  // Each choice is explicit; assertions above establish that sync did not guess it.
  const classification = page.getByRole("combobox", { name: `Classification for ${name}`, exact: true });
  await classification.waitFor();
  assert.equal(await classification.inputValue(), "", "A legacy review must start without a guessed classification");
  const apply = page.getByRole("button", { name: `Apply review for ${name}`, exact: true });
  assert.equal(await apply.isDisabled(), true);
  await classification.selectOption(serviceId ?? "__other_income__");
  await apply.click();
  await classification.waitFor({ state: "hidden" });
}
