import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const rootUrl = process.env.FFYON_BROWSER_ROOT_URL;
const siteUrl = process.env.FFYON_BROWSER_SITE_URL;

// Opt in with FFYON_BROWSER_ROOT_URL / FFYON_BROWSER_SITE_URL (loopback only).
// FFYON_BROWSER_MOCK_ADMIN=1 enables isolated IPC and in-memory SQLite fixtures.
// Optionally set FFYON_PLAYWRIGHT_PATH and FFYON_BROWSER_CHANNEL for local runtimes.
// This runner never calls a production service or modifies real business records.
if (rootUrl || siteUrl) await run();

async function run() {
  const { chromium } = require(process.env.FFYON_PLAYWRIGHT_PATH || "playwright");
  const output = resolve("test-results/browser-smoke");
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ ...(process.env.FFYON_BROWSER_CHANNEL ? { channel: process.env.FFYON_BROWSER_CHANNEL } : {}), headless: true });
  const evidence = [];
  try {
    if (rootUrl) for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
      assertLocal(rootUrl);
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(rootUrl, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Admin access required" }).waitFor();
      await page.getByText("Checking authorization", { exact: true }).waitFor({ state: "hidden" });
      assert.equal(await page.getByRole("link", { name: /Dashboard|Schedule|Clients|Monthly|Settings/ }).count(), 0, "Locked browser must not render the business shell");
      assert.equal(await page.getByRole("button", { name: "Pair Device", exact: true }).last().isDisabled(), true);
      await page.getByPlaceholder("e.g. Salon Mac").fill("QA browser only");
      await page.getByPlaceholder("XXXX-XXXX-XXXX").fill("ABCD-EFGH-JKLM");
      await page.getByRole("button", { name: "Pair Device", exact: true }).last().click();
      await page.getByRole("alert").waitFor();
      assert.equal(await page.getByRole("heading", { name: "Admin access required" }).count(), 1, "Unsupported browser pairing must fail closed");
      await assertNoOverflow(page);
      await capture(page, output, `desktop-locked-pair-${viewport.width}.png`);
      await page.getByRole("button", { name: "Set Up First Admin", exact: true }).click();
      await page.getByRole("button", { name: "Generate setup values", exact: true }).click();
      await page.getByRole("alert").waitFor();
      assert.equal(await page.getByText("FFYON_BOOTSTRAP_TOKEN_HASH", { exact: true }).count(), 0, "Browser must not generate a credential");
      await assertNoOverflow(page);
      await capture(page, output, `desktop-locked-owner-${viewport.width}.png`);
      assert.deepEqual(errors, [], "Desktop lock screen must not have uncaught page errors");
      evidence.push({ target: "desktop-lock", viewport, businessShellHidden: true, unsupportedPairAndBootstrapFailClosed: true, pageErrors: errors });
      await page.close();
    }
    if (rootUrl && process.env.FFYON_BROWSER_MOCK_ADMIN === "1") await approvedDesktopSmoke(browser, rootUrl, output, evidence);
    if (siteUrl) {
      await realCustomerSmoke(browser, siteUrl, output, evidence);
      await customerSmoke(browser, siteUrl, output, evidence);
    }
    console.log(JSON.stringify({ evidence, screenshots: output }, null, 2));
  } finally { await browser.close(); }
}

async function approvedDesktopSmoke(browser, url, output, evidence) {
  const { default: initSqlJs } = await import("sql.js");
  const SQL = await initSqlJs();
  const rust = await readFile(resolve("src-tauri/src/lib.rs"), "utf8");
  const migrations = [...rust.matchAll(/version:\s*(\d+),[\s\S]*?sql:\s*r#"([\s\S]*?)"#/g)].map(match => match[2]);
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
    const sqlite = new SQL.Database();
    for (const sql of migrations) sqlite.run(sql);
    const select = (sql, params = []) => {
      const statement = sqlite.prepare(sql);
      try {
        statement.bind(params.map(value => value ?? null));
        const rows = [];
        while (statement.step()) rows.push(statement.getAsObject());
        return rows;
      } finally { statement.free(); }
    };
    const execute = (sql, params = []) => {
      sqlite.run(sql, params.map(value => value ?? null));
      return { rowsAffected: sqlite.getRowsModified(), lastInsertId: select("SELECT last_insert_rowid() AS id")[0].id };
    };
    const now = new Date().toISOString();
    const clients = ["Acceptance Customer", "Rejection Customer", "Reschedule Customer", "Proposal Rejection Customer"].map((name, index) => ({ id: `fixture-client-${index}`, account_id: `fixture-account-${index}`, name, email: `customer${index}@example.invalid`, phone: "07000000000", disabled: false, revision: 1, updated_at: now }));
    const services = [{ id: "fixture-service", name: "Custom express tan with consultation", description: "Browser-only in-memory service.", duration_min: 45, price_pence: 2750, active: true, revision: 1 }];
    const settings = { booking_enabled: false, timezone: "Europe/London", slot_minutes: 30, horizon_days: 90, opening_hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, open: "09:00", close: "17:00" })), revision: 1 };
    const appointments = clients.map((client, index) => ({ id: `fixture-appointment-${index}`, client_id: client.id, service_id: services[0].id, service_name: services[0].name, date, start_time: `${10 + index}:00`, duration_min: 45, price_pence: 2750, notes: "Customer-visible fixture note.", status: index >= 2 ? "confirmed" : "pending", revision: 1, proposed_date: index >= 2 ? date : null, proposed_start_time: index >= 2 ? `${13 + index}:00` : null, series_id: null, created_at: now, updated_at: now }));
    let cursor = 10;
    let accessState = "online";
    const mutations = [];
    const status = () => ({ state: accessState, device_id: "fixture-device", device_name: "Fixture browser", expires_at: Math.floor(Date.now() / 1000) + 86400, error: null });
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.exposeBinding("__ffyonMockInvoke", async (_source, command, args = {}) => {
      if (command === "_mock_access") { accessState = args.state; return status(); }
      if (command === "access_status" || command === "access_check") return status();
      if (command === "db_select") return select(args.sql, args.params);
      if (command === "db_execute") return execute(args.sql, args.params);
      if (command === "db_batch") {
        sqlite.run("BEGIN");
        try { const result = args.statements.map(item => execute(item.sql, item.params)); sqlite.run("COMMIT"); return result; }
        catch (error) { sqlite.run("ROLLBACK"); throw error; }
      }
      if (command === "admin_request") {
        assert.equal(accessState, "online", "No shared mutation while offline");
        if (args.operation === "sync") return { snapshot: { clients, appointments, services, blocks: [], settings, cursor }, changes: [], cursor, has_more: false };
        if (args.operation === "devices") return { devices: [{ id: "fixture-device", name: "Fixture browser", created_at: now, last_seen_at: now, revoked_at: null }] };
        mutations.push({ operation: args.operation, method: args.method, body: args.body });
        if (args.operation === "appointments") {
          const appointment = appointments.find(item => item.id === args.body.id);
          assert.ok(appointment, "Appointment fixture must exist");
          if (args.body.action === "accept_reschedule") { appointment.date = appointment.proposed_date; appointment.start_time = appointment.proposed_start_time; appointment.proposed_date = null; appointment.proposed_start_time = null; }
          else if (args.body.action === "reject_reschedule") { appointment.proposed_date = null; appointment.proposed_start_time = null; }
          else appointment.status = ({ accept: "confirmed", restore: "confirmed", reject: "rejected", cancel: "cancelled", no_show: "no_show" })[args.body.action];
          appointment.revision++;
        } else if (args.operation === "services") {
          const service = services.find(item => item.id === args.body.id);
          Object.assign(service, args.body, { revision: service.revision + 1 });
        } else throw new Error(`Unexpected browser fixture mutation: ${args.operation}`);
        cursor++;
        return { ok: true };
      }
      if (command === "plugin:updater|check") return null;
      if (command.includes("listen") || command.includes("register") || command === "sync_tray" || command === "set_close_action") return null;
      return null;
    });
    await page.addInitScript(() => {
      const callbacks = new Map();
      const accessHandlers = [];
      let next = 0;
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        transformCallback(callback) { const id = ++next; callbacks.set(id, callback); return id; },
        unregisterCallback(id) { callbacks.delete(id); },
        async invoke(command, args) {
          if (command === "plugin:event|listen") { if (args.event === "app-access-changed") accessHandlers.push(args.handler); return ++next; }
          if (command === "plugin:event|unlisten") return null;
          return window.__ffyonMockInvoke(command, args);
        },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.__ffyonMockSetState = async state => {
        const payload = await window.__ffyonMockInvoke("_mock_access", { state });
        for (const handler of accessHandlers) callbacks.get(handler)?.({ event: "app-access-changed", id: 1, payload });
      };
    });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator('nav a[title="To do"]').click();
    await page.getByRole("button", { name: "Acceptance Customer", exact: true }).waitFor();
    await assertBusinessViewport(page);
    const details = await page.getByRole("button", { name: "Acceptance Customer", exact: true }).evaluate(element => element.parentElement.getBoundingClientRect().width);
    assert.ok(details >= 160, `Request details must not be squeezed beside actions: ${details}px`);
    await capture(page, output, `admin-requests-${viewport.width}.png`);
    await page.evaluate(() => window.__ffyonMockSetState("offline"));
    await page.getByText("You're offline. Reconnect to accept or reject booking requests. Payments can still be confirmed.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Accept", exact: true }).first().isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Reject", exact: true }).first().isDisabled(), true);
    await capture(page, output, `admin-offline-requests-${viewport.width}.png`);
    await page.evaluate(() => window.__ffyonMockSetState("online"));
    await page.getByRole("button", { name: "Accept", exact: true }).first().click();
    await page.getByRole("button", { name: "Acceptance Customer", exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Reject", exact: true }).first().click();
    await page.getByRole("button", { name: "Rejection Customer", exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Approve new time", exact: true }).first().click();
    await page.getByRole("button", { name: "Reschedule Customer", exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Keep current time", exact: true }).click();
    await page.getByText("All caught up", { exact: true }).waitFor();
    assert.equal(appointments[0].status, "confirmed");
    assert.equal(appointments[1].status, "rejected");
    assert.equal(appointments[2].start_time, "15:00");
    assert.equal(appointments[3].start_time, "13:00", "Rejecting a proposal preserves the original confirmed time");
    assert.equal(appointments[3].status, "confirmed");
    assert.equal(appointments[3].proposed_start_time, null);
    await page.locator('nav a[title="Settings"]').click();
    await page.getByRole("button", { name: `Edit ${services[0].name}`, exact: true }).waitFor();
    await assertBusinessViewport(page);
    await capture(page, output, `admin-connection-${viewport.width}.png`);
    await page.evaluate(() => window.__ffyonMockSetState("offline"));
    await page.getByText("Reconnect to change shared booking settings.", { exact: true }).first().waitFor();
    assert.equal(await page.getByRole("button", { name: `Edit ${services[0].name}`, exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: `Archive ${services[0].name}`, exact: true }).isDisabled(), true);
    await page.evaluate(() => window.__ffyonMockSetState("online"));
    await page.getByText("Reconnect to change shared booking settings.", { exact: true }).first().waitFor({ state: "hidden" });
    await page.getByRole("button", { name: `Edit ${services[0].name}`, exact: true }).scrollIntoViewIfNeeded();
    await capture(page, output, `admin-services-${viewport.width}.png`);
    await page.getByRole("button", { name: `Edit ${services[0].name}`, exact: true }).click();
    await page.getByRole("heading", { name: "Edit service", exact: true }).waitFor();
    await page.getByLabel("Price (GBP)", { exact: true }).fill("29.25");
    await page.getByLabel("Duration (minutes)", { exact: true }).fill("60");
    await capture(page, output, `admin-service-editor-${viewport.width}.png`);
    await page.getByRole("button", { name: "Save", exact: true }).last().click();
    await page.getByRole("heading", { name: "Edit service", exact: true }).waitFor({ state: "hidden" });
    assert.equal(services[0].price_pence, 2925);
    assert.equal(services[0].duration_min, 60);
    await page.getByRole("button", { name: `Archive ${services[0].name}`, exact: true }).click();
    await page.getByRole("button", { name: `Archive ${services[0].name}`, exact: true }).waitFor({ state: "hidden" });
    assert.equal(services[0].active, false);
    assert.equal(appointments[0].price_pence, 2750, "Existing booked quote must remain unchanged");
    assert.equal(appointments[0].duration_min, 45, "Existing booked duration must remain unchanged");
    assert.deepEqual(select("SELECT price_pence,duration_min FROM appointments WHERE remote_id=?", [appointments[0].id]), [{ price_pence: 2750, duration_min: 45 }], "Synced local quote must remain unchanged");
    await page.locator('nav a[title="Clients"]').click();
    await page.getByText("Acceptance Customer", { exact: true }).waitFor();
    await page.getByText("Acceptance Customer", { exact: true }).click();
    await page.getByText("Website account linked", { exact: true }).waitFor();
    await assertBusinessViewport(page);
    await page.getByText("Website account linked", { exact: true }).scrollIntoViewIfNeeded();
    await capture(page, output, `admin-client-profile-${viewport.width}.png`);
    await page.evaluate(() => window.__ffyonMockSetState("locked"));
    await page.getByRole("heading", { name: "Admin access required", exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Clients", exact: true }).count(), 0, "Native lock event must unmount loaded business data");
    assert.deepEqual(errors, [], "Approved fixture must have no uncaught page errors");
    evidence.push({ target: "approved-desktop-fixture", viewport, nativeIpcAndBackend: "mocked; actual migrations and SQL in disposable memory only", offlineSharedControlsDisabled: true, acceptedRejectedAndRescheduled: true, updatedAndArchivedService: true, existingBookingQuotePreserved: true, loadedBusinessShellUnmountedOnNativeLock: true, mutations: mutations.map(item => ({ operation: item.operation, method: item.method, action: item.body?.action ?? null })), pageErrors: errors });
    await page.close();
    sqlite.close();
  }
}

function assertLocal(url) {
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname), "Browser smoke only accepts local servers");
}

async function assertNoOverflow(page) {
  const size = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(size.document <= size.viewport + 1, `Horizontal overflow: ${JSON.stringify(size)}`);
}

async function assertBusinessViewport(page) {
  await assertNoOverflow(page);
  const size = await page.locator("main").evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
  if (size.content > size.width + 1) {
    const overflow = await page.evaluate(() => [...document.querySelectorAll("main *")].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.right > innerWidth + 1;
    }).map(element => ({ tag: element.tagName, class: element.className, text: element.textContent?.trim().slice(0, 100), right: element.getBoundingClientRect().right })).slice(0, 15));
    console.log(JSON.stringify({ overflow }, null, 2));
    await capture(page, resolve("test-results/browser-smoke"), `admin-overflow-${await page.evaluate(() => innerWidth)}.png`);
  }
  assert.ok(size.content <= size.width + 1, `Business panel horizontal overflow: ${JSON.stringify(size)}`);
}

async function capture(page, output, name) {
  await page.screenshot({ path: resolve(output, name), fullPage: true, animations: "disabled" });
}

async function realCustomerSmoke(browser, url, output, evidence) {
  assertLocal(url);
  for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const response = await page.request.get(new URL("/api/services", url).href);
    assert.equal(response.status(), 200, "Real local Worker catalogue must return 200");
    const catalogue = await response.json();
    assert.equal(catalogue.booking_enabled, false, "Local fixture should keep online booking disabled");
    assert.ok(catalogue.services.length > 0);
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByText("Online booking is currently closed. Please check back soon.", { exact: true }).waitFor();
    for (const service of catalogue.services.filter(item => item.active)) await page.getByRole("heading", { name: service.name, exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Book", exact: true }).count(), 0, "Closed catalogue must not expose service booking actions");
    await assertNoOverflow(page);
    await capture(page, output, `customer-real-closed-${viewport.width}.png`);
    await page.goto(new URL(`/book?service=${catalogue.services[0].id}`, url).href, { waitUntil: "networkidle" });
    await page.getByText("Online booking is currently closed. Your draft is saved for when booking reopens.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Choose date & time", exact: true }).isDisabled(), true, "Direct booking URL must also remain closed");
    await assertNoOverflow(page);
    await capture(page, output, `customer-real-booking-closed-${viewport.width}.png`);
    assert.deepEqual(errors, []);
    evidence.push({ target: "customer-real-local-worker", viewport, catalogue: "real local D1/Worker, no fetch mocks", services: catalogue.services.length, bookingClosedOnCatalogueAndDirectUrl: true, pageErrors: errors });
    await page.close();
  }
}

async function customerSmoke(browser, url, output, evidence) {
  assertLocal(url);
  for (const viewport of [{ width: 1280, height: 900 }, { width: 768, height: 1024 }, { width: 375, height: 812 }, { width: 320, height: 740 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let revision = 1;
    const service = () => ({ id: "qa-service", name: "Custom express tan with consultation", description: "A local browser-only catalogue fixture.", duration_min: revision === 1 ? 45 : 60, price_pence: revision === 1 ? 2750 : 2925, active: true, revision });
    await page.route("**/api/services", route => route.fulfill({ json: { services: [service()], booking_enabled: true } }));
    await page.route("**/api/availability?**", route => route.fulfill({ json: { services: [service()], booking_enabled: true, times: ["09:00", "09:30", "11:00", "12:30", "14:00", "16:00"] } }));
    await page.route("**/api/appointments", route => route.abort("blockedbyclient"));
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: service().name, exact: true }).waitFor();
    await page.getByText("£27.50", { exact: true }).waitFor();
    await assertNoOverflow(page);
    await capture(page, output, `customer-catalogue-${viewport.width}.png`);
    await page.getByRole("link", { name: "Book", exact: true }).click();
    await page.getByRole("button", { name: "Choose date & time", exact: true }).waitFor();
    await page.getByRole("button", { name: "Choose date & time", exact: true }).click();
    const date = await page.locator("#booking-date").getAttribute("min");
    await page.locator("#booking-date").fill(date);
    await page.getByRole("button", { name: "09:00", exact: true }).click();
    await page.getByRole("button", { name: "Review request", exact: true }).click();
    await page.getByRole("heading", { name: "Review your request", exact: true }).waitFor();
    assert.ok((await page.locator(".review-details").innerText()).includes("£27.50"));
    assert.ok((await page.locator(".review-details").innerText()).includes("45 minutes"));
    await assertNoOverflow(page);
    await capture(page, output, `customer-review-${viewport.width}.png`);
    revision = 2;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByText(/This service has changed/).waitFor();
    assert.ok((await page.locator(".review-details").innerText()).includes("£27.50"), "A changed service must not silently overwrite the draft quote");
    await page.getByRole("button", { name: "Use updated service", exact: true }).click();
    await page.getByRole("button", { name: "09:00", exact: true }).click();
    await page.getByRole("button", { name: "Review request", exact: true }).click();
    assert.ok((await page.locator(".review-details").innerText()).includes("£29.25"));
    assert.ok((await page.locator(".review-details").innerText()).includes("60 minutes"));
    await assertNoOverflow(page);
    await capture(page, output, `customer-repriced-${viewport.width}.png`);
    assert.deepEqual(errors, [], "Customer pages must not have uncaught page errors");
    evidence.push({ target: "customer-ui", viewport, catalogueAndAvailability: "mocked local responses", originalQuotePreservedUntilReview: true, updatedPenceAndDuration: true, pageErrors: errors });
    await page.close();
  }
}
