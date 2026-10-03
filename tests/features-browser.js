import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const rootUrl = process.env.FFYON_FEATURES_ROOT_URL;
const siteUrl = process.env.FFYON_FEATURES_SITE_URL;

// Opt-in browser QA: loopback servers, disposable IPC/HTTP fixtures, no live writes.
// Set FFYON_PLAYWRIGHT_PATH for a bundled runtime and optional FFYON_BROWSER_CHANNEL.
if ((rootUrl || siteUrl) && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();

async function run() {
  for (const url of [rootUrl, siteUrl].filter(Boolean)) assertLocal(url);
  const { chromium } = require(process.env.FFYON_PLAYWRIGHT_PATH || "playwright");
  const output = resolve("test-results/features-browser");
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ ...(process.env.FFYON_BROWSER_CHANNEL ? { channel: process.env.FFYON_BROWSER_CHANNEL } : {}), headless: true });
  const evidence = [];
  try {
    if (rootUrl) await desktopFeatures(browser, rootUrl, output, evidence);
    if (siteUrl) await customerFeatures(browser, siteUrl, output, evidence);
    await writeFile(resolve(output, "evidence.json"), JSON.stringify({ evidence }, null, 2));
    console.log(JSON.stringify({ evidence, screenshots: output }, null, 2));
  } finally { await browser.close(); }
}

export function assertLocal(url) {
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname), "Feature QA forbids production servers");
}

export async function assertFits(page) {
  const size = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
  assert.ok(size.content <= size.width + 1, `Page overflow: ${JSON.stringify(size)}`);
  const overflows = await page.evaluate(() => [...document.querySelectorAll("form, [role=dialog]")].map(element => ({
    tag: element.tagName, width: element.clientWidth, content: element.scrollWidth,
  })).filter(item => item.width > 0 && item.content > item.width + 1));
  assert.deepEqual(overflows, [], "Forms and dialog surfaces must not clip horizontally");
  const outside = await page.evaluate(() => [...document.querySelectorAll("input, textarea, select")].filter(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && (bounds.left < -1 || bounds.right > innerWidth + 1);
  }).map(element => ({ type: element.type, value: element.value, bounds: element.getBoundingClientRect().toJSON() })));
  assert.deepEqual(outside, [], "Form controls must remain within the viewport");
}

export async function capture(page, output, name) {
  await assertFits(page);
  await page.screenshot({ path: resolve(output, name), fullPage: true, animations: "disabled" });
}

export async function installDesktopFixture(page, records) {
  const { default: initSqlJs } = await import("sql.js");
  const SQL = await initSqlJs();
  const sqlite = new SQL.Database();
  sqlite.run("PRAGMA foreign_keys = ON");
  const rust = await readFile(resolve("src-tauri/src/lib.rs"), "utf8");
  for (const match of rust.matchAll(/version:\s*(\d+),[\s\S]*?sql:\s*r#"([\s\S]*?)"#/g)) sqlite.run(match[2]);
  const bindings = (sql, params) => /\$\d+\b/.test(sql)
    ? Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value ?? null]))
    : params.map(value => value ?? null);
  const select = (sql, params = []) => {
    const statement = sqlite.prepare(sql);
    try {
      statement.bind(bindings(sql, params));
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally { statement.free(); }
  };
  const execute = (sql, params = []) => {
    sqlite.run(sql, bindings(sql, params));
    return { rowsAffected: sqlite.getRowsModified(), lastInsertId: select("SELECT last_insert_rowid() AS id")[0].id };
  };
  let cursor = 10;
  const commands = [];
  const mutations = [];
  let nextAppointmentError = null;
  const mapTiles = [];
  page.on("response", async response => {
    const resource = new URL(response.url());
    if (!resource.hostname.endsWith(".openstreetmap.org") || !/\/\d+\/\d+\/\d+(?:\.(?:png|pbf|mvt))?$/.test(resource.pathname)) return;
    const headers = await response.request().allHeaders();
    const tile = { status: response.status(), referer: headers.referer ?? null, complete: false, type: "vector", bytes: 0, naturalWidth: null, naturalHeight: null, error: null };
    mapTiles.push(tile);
    try {
      const body = await response.body();
      tile.bytes = body.length;
      if (response.headers()["content-type"]?.includes("image/png")) {
        const imageRequire = process.env.FFYON_PLAYWRIGHT_PATH ? createRequire(resolve(process.env.FFYON_PLAYWRIGHT_PATH, "index.js")) : require;
        const { PNG } = imageRequire("pngjs");
        const raster = PNG.sync.read(body);
        tile.type = "raster";
        tile.naturalWidth = raster.width;
        tile.naturalHeight = raster.height;
      }
    } catch (error) { tile.error = error.message; }
    finally { tile.complete = true; }
  });
  const now = new Date().toISOString();
  const status = () => ({ state: "online", device_id: "feature-fixture", device_name: "Disposable feature browser", expires_at: Math.floor(Date.now() / 1000) + 86400, error: null });
  if (process.env.FFYON_FEATURES_MAP_OFFLINE === "1") await page.route("https://www.openstreetmap.org/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Disposable postcode area</title><body>Postcode map fixture</body>" }));
  await page.exposeBinding("__ffyonFeatureInvoke", async (_source, command, args = {}) => {
    commands.push({ command, args });
    if (command === "access_status" || command === "access_check") return status();
    if (command === "db_select") return select(args.sql, args.params);
    if (command === "db_read_batch") {
      sqlite.run("BEGIN");
      try { const result = args.statements.map(item => select(item.sql, item.params)); sqlite.run("COMMIT"); return result; }
      catch (error) { sqlite.run("ROLLBACK"); throw error; }
    }
    if (command === "db_execute") return execute(args.sql, args.params);
    if (command === "db_batch") {
      sqlite.run("BEGIN");
      try {
        const result = args.statements.map((item, index) => {
          const result = execute(item.sql, item.params);
          if (args.expectedRows?.[index] != null && result.rowsAffected !== args.expectedRows[index]) throw new Error("The record changed. Refresh before trying again.");
          return result;
        });
        sqlite.run("COMMIT"); return result;
      }
      catch (error) { sqlite.run("ROLLBACK"); throw error; }
    }
    if (command === "lookup_postcode") return { postcode: "SW1A 1AA", latitude: 51.501009, longitude: -0.141588 };
    if (command === "open_appointment_directions") return null;
    if (command === "admin_request") {
      if (args.operation === "mail/unread" && args.method === "GET") return { conversations: [], unread_count: 0 };
      if (args.operation === "mail/status" && args.method === "GET") return { configured: false, sender_address: "", receiving_addresses: [] };
      if (args.operation === "mail/conversations" && args.method === "GET") return { conversations: [], next_cursor: null };
      if (args.operation === "sync") return { snapshot: { ...records, cursor }, changes: [], cursor, has_more: false };
      if (args.operation === "devices") return { devices: [{ id: "feature-fixture", name: "Feature fixture", created_at: now, last_seen_at: now, revoked_at: null }] };
      mutations.push({ operation: args.operation, method: args.method, body: args.body });
      const value = args.body;
      if (args.operation === "appointments") {
        if (args.method === "POST" && nextAppointmentError) {
          const error = nextAppointmentError;
          nextAppointmentError = null;
          throw new Error(error);
        }
        if (value.save_visit_address) {
          const customer = records.clients.find(item => item.id === value.client_id);
          assert.ok(customer, "Saved visit fixture requires its customer");
          customer.saved_address = value.visit_address;
          customer.saved_postcode = value.visit_postcode;
          customer.revision++;
        }
        if (args.method === "POST") records.appointments.push({ ...value, status: "confirmed", service_name: records.services.find(item => item.id === value.service_id)?.name ?? "Feature Tan", revision: 1, proposed_date: null, proposed_start_time: null, series_id: null, created_at: now, updated_at: now });
        else if (args.method === "DELETE") records.appointments = records.appointments.filter(item => item.id !== value.id);
        else {
          const appointment = records.appointments.find(item => item.id === value.id);
          assert.ok(appointment, "Expected a fixture appointment");
          if (value.action === "edit") Object.assign(appointment, value, { revision: appointment.revision + 1 });
          else appointment.status = ({ accept: "confirmed", reject: "rejected", cancel: "cancelled", restore: "confirmed", no_show: "no_show" })[value.action];
        }
      } else if (args.operation === "services") {
        const service = records.services.find(item => item.id === value.id);
        if (service) Object.assign(service, value, { revision: service.revision + 1 });
        else if (args.method === "POST") records.services.push({ ...value, revision: 1 });
        else throw new Error("Expected a fixture service");
        const saved = records.services.find(item => item.id === value.id);
        saved.booking_price_pence = Math.round(saved.price_pence * (100 - (saved.discount_percent ?? 0)) / 100);
      } else if (args.operation === "clients") {
        if (args.method === "POST") records.clients.push({ ...value, account_id: null, merged_into: null, disabled: false, revision: 1, updated_at: now });
        else if (args.method === "DELETE") {
          records.clients = records.clients.filter(item => item.id !== value.id);
          records.appointments = records.appointments.filter(item => item.client_id !== value.id);
        } else Object.assign(records.clients.find(item => item.id === value.id), value);
      } else throw new Error(`Unexpected feature fixture operation: ${args.operation}`);
      cursor++;
      return { ok: true };
    }
    if (command === "plugin:updater|check") return null;
    if (command === "plugin:notification|is_permission_granted") return true;
    if (command === "notify_payment_confirmation") return null;
    if (command.includes("listen") || command.includes("register") || command === "sync_tray" || command === "set_tray_state" || command === "set_close_action") return null;
    throw new Error(`Unexpected feature IPC command: ${command}`);
  });
  await page.addInitScript(() => {
    const callbacks = new Map();
    let next = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback(callback) { const id = ++next; callbacks.set(id, callback); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command, args) {
        if (command === "plugin:event|listen") return ++next;
        if (command === "plugin:event|unlisten") return null;
        return window.__ffyonFeatureInvoke(command, args);
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  });
  return { records, commands, mutations, mapTiles, select, execute, failNextAppointment: (message = "409: Fixture slot no longer available") => { nextAppointmentError = message; }, close: () => sqlite.close() };
}

async function desktopFeatures(browser, url, output, evidence) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const widths = process.env.FFYON_FEATURES_WIDTHS ? process.env.FFYON_FEATURES_WIDTHS.split(",").map(Number) : [1280, 1024, 800, 640, 375, 320];
  assert.ok(widths.every(width => Number.isInteger(width) && width >= 320 && width <= 1920));
  for (const viewport of widths.map(width => ({ width, height: width >= 640 ? 900 : width === 375 ? 812 : 740 }))) {
    const now = new Date().toISOString();
    const clients = ["Website Remote Customer", "Manual Sorted Customer", "Salon Customer"].map((name, index) => ({ id: `00000000-0000-4000-8000-${String(index + 101).padStart(12, "0")}`, account_id: null, merged_into: null, name, email: `customer${index}@example.invalid`, phone: "07000000000", saved_address: "1 Saved Browser Fixture Road\nLondon", saved_postcode: "SW1A 1AA", disabled: false, revision: 1, updated_at: now }));
    const services = [{ id: "browser-feature-service", name: "Express spray tan with a personalised colour consultation", description: "Browser-only fixture service", duration_min: 45, price_pence: 2750, discount_percent: 20, booking_price_pence: 2200, active: true, revision: 1 }];
    const makeAppointment = (id, client, fields = {}) => ({ id, client_id: client.id, service_id: services[0].id, service_name: services[0].name, date, start_time: "10:00", time_confirmed: true, duration_min: 45, price_pence: 2200, base_price_pence: 2750, discount_percent: 20, is_remote: false, visit_address: "", visit_postcode: "", notes: "Browser fixture instruction", status: "confirmed", revision: 1, proposed_date: null, proposed_start_time: null, proposed_time_confirmed: null, series_id: null, created_at: now, updated_at: now, ...fields });
    const records = {
      clients, services,
      appointments: [makeAppointment("00000000-0000-4000-8000-000000000301", clients[0], { status: "pending", start_time: "00:00", time_confirmed: false, is_remote: true, visit_address: "2 Remote Browser Fixture Road\nA very long apartment and building name for mobile wrapping\nLondon", visit_postcode: "SW1A 1AA" }), makeAppointment("00000000-0000-4000-8000-000000000302", clients[2])],
      blocks: [],
      settings: { booking_enabled: true, timezone: "Europe/London", slot_minutes: 30, horizon_days: 90, opening_hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, open: "09:00", close: "17:00" })), admin_notifications_enabled: false, admin_notification_email: "", revision: 1 },
    };
    const page = await browser.newPage({ viewport, timezoneId: "Europe/London" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const fixture = await installDesktopFixture(page, records);
    try {
      await page.goto(url, { waitUntil: "networkidle" });
      await page.locator('nav a[title="To do"]').click();
      await page.getByRole("button", { name: clients[0].name, exact: true }).waitFor();
      await page.getByRole("button", { name: "Accept date", exact: true }).waitFor();
      assert.equal(fixture.commands.filter(item => item.command === "lookup_postcode").length, 0, "Opening requests must not disclose a postcode to a map provider");
      await capture(page, output, `admin-remote-request-${viewport.width}.png`);
      await page.getByRole("button", { name: "Show map", exact: true }).click();
      const map = page.locator('iframe[title="Postcode area map for SW1A 1AA"]');
      await map.waitFor();
      assert.equal(await map.getAttribute("sandbox"), "allow-scripts allow-same-origin");
      assert.equal(await map.getAttribute("referrerpolicy"), "strict-origin-when-cross-origin");
      const mapBounds = await map.boundingBox(), requestBounds = await map.locator('xpath=ancestor::li').boundingBox();
      assert.ok(mapBounds.width >= requestBounds.width - 44, "Request actions must not squeeze the map column");
      assert.equal(fixture.commands.filter(item => item.command === "lookup_postcode").length, 1);
      assert.deepEqual(fixture.commands.find(item => item.command === "lookup_postcode").args, { postcode: "SW1A 1AA" }, "Postcode lookup must not send a full visit address");
      let mapRendered = false;
      let mapProviderIssue = null;
      if (process.env.FFYON_FEATURES_MAP_OFFLINE !== "1") {
        try {
          await page.frameLocator('iframe[title="Postcode area map for SW1A 1AA"]').locator("canvas").first().waitFor({ timeout: 20000 });
          const deadline = Date.now() + 20000;
          while ((!fixture.mapTiles.length || fixture.mapTiles.some(tile => !tile.complete)) && Date.now() < deadline) await page.waitForTimeout(100);
          assert.ok(fixture.mapTiles.length > 0 && fixture.mapTiles.every(tile => tile.complete && tile.status === 200 && tile.bytes > 0 && !tile.error), "Every visible raster/vector tile must finish successfully");
          const mapSource = await map.getAttribute("src");
          assert.ok(fixture.mapTiles.every(tile => tile.referer === "https://www.openstreetmap.org/" || tile.referer === mapSource), "Tile requests must identify OSM, with at most the existing postcode-area coordinates");
          await page.waitForTimeout(1000); // OpenLayers fades newly loaded tiles into its canvas.
          const imageRequire = process.env.FFYON_PLAYWRIGHT_PATH ? createRequire(resolve(process.env.FFYON_PLAYWRIGHT_PATH, "index.js")) : require;
          const { PNG } = imageRequire("pngjs");
          const pixels = PNG.sync.read(await map.screenshot());
          const colours = new Set();
          for (let index = 0; index < pixels.data.length; index += 36) colours.add(`${pixels.data[index] >> 4}:${pixels.data[index + 1] >> 4}:${pixels.data[index + 2] >> 4}`);
          mapRendered = colours.size >= 40;
          if (!mapRendered) mapProviderIssue = `Map canvas stayed visually blank (${colours.size} colour buckets)`;
        } catch (error) { mapProviderIssue = error.message; }
        assert.ok(mapRendered && !mapProviderIssue, `Live map must render successfully: ${mapProviderIssue}`);
      }
      await capture(page, output, `admin-postcode-map-${viewport.width}.png`);
      await page.getByRole("button", { name: "Directions", exact: true }).click();
      assert.equal(fixture.commands.filter(item => item.command === "open_appointment_directions").length, 1);
      await page.getByRole("button", { name: "Hide map", exact: true }).click();
      assert.equal(await page.locator("iframe").count(), 0);

      await page.locator('nav a[title="Schedule"]').click();
      await page.getByRole("button", { name: "New entry", exact: true }).click();
      const newEntry = page.getByRole("dialog", { name: "New entry", exact: true });
      await newEntry.getByText(/^For tips, product sales and other income\./).waitFor();
      assert.equal(await newEntry.getByLabel(/^Payment for/).count(), 0);
      assert.equal(await newEntry.getByLabel(/^Income type/).count(), 0, "A one-option income type list is replaced by guidance");
      assert.equal(await newEntry.getByLabel(/^Service/).count(), 0);
      const carriedDate = new Date(`${date}T12:00:00Z`);
      carriedDate.setUTCDate(carriedDate.getUTCDate() + 2);
      const appointmentDate = carriedDate.toISOString().slice(0, 10);
      await newEntry.getByLabel(/^Date/).fill(appointmentDate);
      await newEntry.getByLabel(/^Amount/).fill("19.37");
      await newEntry.getByPlaceholder("Search or add a client (optional)").fill(clients[1].name);
      await newEntry.getByRole("option", { name: clients[1].name, exact: true }).click();
      await capture(page, output, `admin-new-entry-appointment-choice-${viewport.width}.png`);
      await newEntry.getByRole("button", { name: "Appointment", exact: true }).click();
      await newEntry.waitFor({ state: "hidden" });
      await page.getByRole("heading", { name: "New appointment", exact: true }).waitFor();
      await page.waitForFunction(name => document.querySelector('input[role="combobox"]')?.value === name, clients[1].name);
      assert.equal(await page.getByRole("dialog").count(), 1, "New entry must hand off to the existing booking form without stacked dialogs");
      assert.equal(await page.getByLabel(/^Date/).inputValue(), appointmentDate);
      assert.equal(await page.getByLabel(/^Service/).inputValue(), services[0].id);
      assert.equal(await page.getByLabel(/^Price/).inputValue(), "22.00", "Creating a booking must use the agreed service quote, not a payment amount");
      await page.getByLabel(/^Date/).fill(date);
      await page.getByLabel("Time to confirm", { exact: true }).check();
      await page.getByLabel("Home visit", { exact: true }).check();
      await page.getByRole("button", { name: "Use saved address", exact: true }).click();
      assert.equal(await page.getByLabel(/^Address/).inputValue(), clients[1].saved_address);
      await page.getByLabel(/^Address/).fill("3 Manual Browser Fixture Road\nA very long building name with a stairwell, floor and apartment number\nLondon");
      await page.getByLabel("Postcode", { exact: true }).fill("sw1a 1aa");
      await page.getByLabel("Save this address for future appointments", { exact: true }).check();
      assert.equal(await page.getByLabel("Start", { exact: true }).isDisabled(), true);
      assert.equal(await page.getByLabel(/^Price/).inputValue(), "22.00");
      await page.getByRole("dialog", { name: "New appointment", exact: true }).evaluate(element => { element.lastElementChild.scrollTop = 0; });
      await capture(page, output, `admin-manual-remote-untimed-form-${viewport.width}.png`);
      await page.getByRole("dialog", { name: "New appointment", exact: true }).evaluate(element => { element.lastElementChild.scrollTop = element.lastElementChild.scrollHeight; });
      await capture(page, output, `admin-manual-remote-untimed-form-bottom-${viewport.width}.png`);
      await page.getByRole("button", { name: "Book appointment", exact: true }).click();
      await page.getByRole("heading", { name: "New appointment", exact: true }).waitFor({ state: "hidden" });
      const manual = records.appointments.find(item => item.client_id === clients[1].id);
      assert.ok(manual);
      assert.equal(manual.status, "confirmed");
      assert.equal(manual.time_confirmed, false);
      assert.equal(manual.start_time, "00:00");
      assert.equal(manual.is_remote, true);
      assert.equal(manual.discount_percent, 20);
      assert.equal(manual.price_pence, 2200);
      assert.equal(fixture.select("SELECT COUNT(*) AS n FROM transactions")[0].n, 0, "Creating an appointment through New entry must not record income");
      assert.ok(records.clients[1].saved_address.includes("Manual Browser Fixture"));
      const allDay = page.locator('[aria-label="All-day appointments awaiting a time"]');
      await allDay.waitFor();
      assert.ok((await allDay.innerText()).includes(clients[1].name));
      await page.locator('section[aria-label="Appointments needing a confirmed time"]').waitFor();
      await capture(page, output, `admin-all-day-calendar-${viewport.width}.png`);

      await page.locator('nav a[title="To do"]').click();
      await page.getByRole("button", { name: clients[0].name, exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: clients[1].name, exact: true }).count(), 0, "Admin-created entries must stay out of Requests");
      await page.locator('nav a[title="Schedule"]').click();
      await page.getByRole("button", { name: "Day", exact: true }).click();
      await page.getByRole("button", { name: new RegExp(clients[2].name) }).first().click();
      await page.getByRole("heading", { name: "Appointment", exact: true }).waitFor();
      // The heading renders before the asynchronous form reset finishes.
      await page.waitForFunction(name => document.querySelector('input[role="combobox"]')?.value === name, clients[2].name);
      assert.equal(await page.getByRole("button", { name: "Show map", exact: true }).count(), 0, "Salon bookings must not render map controls");
      assert.equal(await page.getByLabel("Home visit", { exact: true }).isChecked(), false);
      await capture(page, output, `admin-salon-booking-${viewport.width}.png`);
      await page.getByRole("button", { name: "Cancel", exact: true }).last().click();

      await page.locator('nav a[title="Settings"]').click();
      await page.getByRole("button", { name: `Edit ${services[0].name}`, exact: true }).click();
      await page.getByRole("heading", { name: "Edit service", exact: true }).waitFor();
      const discountEnabled = page.getByLabel("Discount enabled", { exact: true });
      if (await discountEnabled.count()) await discountEnabled.check();
      await page.getByLabel("Discount (%)", { exact: true }).fill("30");
      await capture(page, output, `admin-discount-editor-${viewport.width}.png`);
      await page.getByRole("button", { name: "Save", exact: true }).last().click();
      await page.getByRole("heading", { name: "Edit service", exact: true }).waitFor({ state: "hidden" });
      assert.equal(services[0].discount_percent, 30);
      assert.equal(manual.price_pence, 2200, "Editing a discount must not change an existing booking quote");
      assert.equal(manual.discount_percent, 20);

      await page.locator('nav a[title="Schedule"]').click();
      await page.getByRole("button", { name: "Book", exact: true }).click();
      await page.getByRole("heading", { name: "New appointment", exact: true }).waitFor();
      await page.getByRole("combobox").first().fill("Retry New Guest");
      await page.getByRole("option", { name: /Retry New Guest.*as a new client/ }).click();
      fixture.failNextAppointment();
      await page.getByRole("button", { name: "Book appointment", exact: true }).click();
      await page.getByText("409: Fixture slot no longer available", { exact: true }).waitFor();
      await page.getByLabel("Start", { exact: true }).fill("11:00");
      await page.getByRole("button", { name: "Book appointment", exact: true }).click();
      await page.getByRole("heading", { name: "New appointment", exact: true }).waitFor({ state: "hidden" });
      const guestCreates = fixture.mutations.filter(item => item.operation === "clients" && item.method === "POST");
      assert.equal(guestCreates.length, 1, "Retrying a conflicted manual booking must not duplicate its newly created guest");
      const guestAttempts = fixture.mutations.filter(item => item.operation === "appointments" && item.method === "POST" && item.body.client_id === guestCreates[0].body.id);
      assert.equal(guestAttempts.length, 2);
      assert.equal(guestAttempts[0].body.client_id, guestAttempts[1].body.client_id);
      assert.equal(records.clients.filter(item => item.name === "Retry New Guest").length, 1);

      await page.locator('nav a[title="Schedule"]').click();
      await page.getByRole("button", { name: new RegExp(clients[1].name) }).first().click();
      await page.getByRole("heading", { name: "Appointment", exact: true }).waitFor();
      await page.waitForFunction(name => document.querySelector('input[role="combobox"]')?.value === name, clients[1].name);
      await page.getByRole("button", { name: "Mark paid", exact: true }).click();
      await page.getByRole("heading", { name: "Appointment", exact: true }).waitFor({ state: "hidden" });
      await page.getByRole("button", { name: new RegExp(clients[1].name) }).first().click();
      await page.getByRole("button", { name: "Delete booking", exact: true }).click();
      const deleteBooking = page.getByRole("dialog", { name: "Delete appointment?", exact: true });
      await deleteBooking.waitFor();
      await capture(page, output, `admin-delete-booking-${viewport.width}.png`);
      await deleteBooking.getByRole("button", { name: "Delete booking", exact: true }).click();
      await deleteBooking.waitFor({ state: "hidden" });
      assert.equal(records.appointments.some(item => item.id === manual.id), false);
      assert.equal(fixture.select("SELECT COUNT(*) AS n FROM appointments WHERE remote_id=?", [manual.id])[0].n, 0);
      assert.deepEqual(fixture.select("SELECT amount_pence,client_id,description FROM transactions")[0], { amount_pence: 2200, client_id: null, description: null }, "Permanent booking deletion must retain anonymized money");

      await page.locator('nav a[title="Clients"]').click();
      await page.getByText(clients[1].name, { exact: true }).first().click();
      await page.getByRole("button", { name: "Delete client", exact: true }).click();
      const deleteClient = page.getByRole("dialog", { name: "Delete client?", exact: true });
      await deleteClient.waitFor();
      await capture(page, output, `admin-delete-client-${viewport.width}.png`);
      await deleteClient.getByRole("button", { name: "Delete client", exact: true }).click();
      await deleteClient.waitFor({ state: "hidden" });
      assert.equal(records.clients.some(item => item.id === clients[1].id), false);
      assert.equal(fixture.select("SELECT amount_pence FROM transactions")[0].amount_pence, 2200);
      assert.deepEqual(errors, []);
      evidence.push({ target: "desktop-features", viewport, storage: "actual migrations + SQL in disposable memory", mapsExplicitOnly: true, mapRendered, mapProviderIssue, mapTiles: fixture.mapTiles, newEntryCreatesAppointmentWithoutIncome: true, moneyInDefaultsToOtherIncome: true, newEntryCarriesDateAndClient: true, manualConfirmedUntimedNotInRequests: true, allDayCalendarAndNeedsTimeHighlight: true, discountQuoteSnapshotPreserved: true, conflictedNewGuestRetryDoesNotDuplicateCustomer: true, destructiveBookingAndClientDeletionPreservesMoney: true, pageErrors: errors });
    } catch (error) {
      console.log(JSON.stringify({ viewport, mapTiles: fixture.mapTiles, form: await page.locator("form").allTextContents(), controls: await page.locator("input,textarea,select").evaluateAll(elements => elements.map(element => ({ type: element.type, value: element.value, label: element.closest("label")?.textContent }))) }, null, 2));
      await page.screenshot({ path: resolve(output, `admin-failure-${viewport.width}.png`), fullPage: true });
      throw error;
    } finally { await page.close(); fixture.close(); }
  }
}

async function customerFeatures(browser, url, output, evidence) {
  const firstDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const futureDate = days => { const date = new Date(`${firstDate}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
  const dates = [futureDate(2), futureDate(4)];
  for (const viewport of [{ width: 1280, height: 900 }, { width: 768, height: 1024 }, { width: 375, height: 812 }, { width: 320, height: 740 }]) {
    const page = await browser.newPage({ viewport, timezoneId: "Europe/London", locale: "en-GB" });
    const errors = [];
    const writes = [];
    const profile = { name: "Browser Feature Customer", email: "browser.features@example.invalid", phone: "07000000000", saved_address: "1 Saved Customer Browser Fixture Road\nLondon", saved_postcode: "SW1A 1AA" };
    let revision = 1;
    const service = () => ({ id: "browser-feature-service", name: "Express spray tan with a personalised colour consultation", description: "Browser-only catalogue fixture", duration_min: 45, price_pence: 2750, discount_percent: revision === 1 ? 20 : 30, booking_price_pence: revision === 1 ? 2200 : 1925, active: true, revision });
    let customerAppointments = [{ id: "00000000-0000-4000-8000-000000000801", client_id: "00000000-0000-4000-8000-000000000802", service_id: service().id, service_name: service().name, date: dates[0], start_time: "00:00", time_confirmed: false, is_remote: true, visit_address: "42 Customer Browser Fixture Road\nLong apartment and building name\nLondon", visit_postcode: "SW1A 1AA", duration_min: 45, price_pence: 2200, base_price_pence: 2750, discount_percent: 20, notes: "Browser fixture instruction", status: "confirmed", revision: 1, proposed_date: null, proposed_start_time: null, proposed_time_confirmed: null, series_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
    page.on("pageerror", error => errors.push(error.message));
    if (process.env.FFYON_FEATURES_SITE_SESSION) await page.context().addCookies([{ name: "ffy_session", value: process.env.FFYON_FEATURES_SITE_SESSION, url, httpOnly: true, sameSite: "Lax" }]);
    await page.route("**/api/services", route => route.fulfill({ json: { services: [service()], booking_enabled: true } }));
    await page.route("**/api/availability?**", route => route.fulfill({ json: { dates, times: ["09:00", "11:00", "14:30"], services: [service()], booking_enabled: true } }));
    await page.route("**/api/customer", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { profile, appointments: customerAppointments } });
      writes.push({ route: "customer", method: route.request().method(), body: route.request().postDataJSON() });
      return route.fulfill({ json: { ok: true, profile } });
    });
    await page.route("**/api/appointments**", route => {
      writes.push({ route: "appointments", method: route.request().method(), body: route.request().postDataJSON() });
      if (route.request().method() === "DELETE") {
        const input = route.request().postDataJSON();
        customerAppointments = customerAppointments.filter(appointment => appointment.id !== input.id);
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ status: 400, json: { error: "This browser fixture does not submit real appointments" } });
    });
    try {
      await page.goto(url, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: service().name, exact: true }).waitFor();
      await page.getByText("20% off", { exact: true }).waitFor();
      assert.equal(await page.locator("del").first().innerText(), "£27.50");
      await page.getByText("£22.00", { exact: true }).first().waitFor();
      await capture(page, output, `customer-discount-catalogue-${viewport.width}.png`);
      await page.getByRole("link", { name: "Book", exact: true }).click();
      await page.getByRole("button", { name: "Choose date & time", exact: true }).click();
      await page.getByText("Checking available dates...", { exact: true }).waitFor({ state: "hidden" });
      const days = page.locator(".available-calendar button[data-day]");
      assert.ok(await days.count() > 0, "Available date calendar must be rendered before a date is chosen");
      const enabled = page.locator(".available-calendar button[data-day]:not(:disabled)");
      const expectedLabels = dates.map(value => new Date(`${value}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "Europe/London" }));
      assert.deepEqual(await enabled.evaluateAll(elements => elements.map(element => element.getAttribute("data-day"))), expectedLabels, "Only known available dates should be selectable");
      assert.ok(await page.locator(".available-calendar button[data-day]:disabled").count() > 0);
      await capture(page, output, `customer-prefiltered-dates-${viewport.width}.png`);
      await enabled.first().click();
      await page.getByLabel("Confirm a time later", { exact: true }).check();
      assert.equal(await page.getByRole("button", { name: "09:00", exact: true }).count(), 0);
      await page.getByLabel("Home visit: Ffyon travels to me", { exact: true }).check();
      assert.equal(await page.getByRole("button", { name: "Review request", exact: true }).isDisabled(), true, "Remote bookings need their address first");
      if (process.env.FFYON_FEATURES_SITE_SESSION) {
        await page.getByRole("button", { name: "Use my saved address", exact: true }).click();
        assert.equal(await page.getByLabel("Visit address", { exact: true }).inputValue(), profile.saved_address);
      }
      const longAddress = `42 QA Fixture Road\nBlock-${"VeryLongBuildingName".repeat(5)}\nLondon`;
      await page.getByLabel("Visit address", { exact: true }).fill(longAddress);
      await page.getByLabel("Postcode", { exact: true }).fill("not a postcode");
      await page.getByLabel("Postcode", { exact: true }).blur();
      assert.equal(await page.getByRole("button", { name: "Review request", exact: true }).isDisabled(), true);
      await page.getByLabel("Postcode", { exact: true }).fill("sw1a1aa");
      await page.getByLabel("Postcode", { exact: true }).blur();
      assert.equal(await page.getByLabel("Postcode", { exact: true }).inputValue(), "SW1A 1AA");
      await page.getByLabel("Save this address for future appointments", { exact: true }).check();
      await page.locator("#notes").fill(`Customer note: ${"LongUnbrokenFixtureNote".repeat(7)}`);
      await capture(page, output, `customer-remote-date-only-form-${viewport.width}.png`);
      await page.getByRole("button", { name: "Review request", exact: true }).click();
      await page.getByRole("heading", { name: "Review your request", exact: true }).waitFor();
      const originalReview = await page.locator(".review-details").innerText();
      assert.ok(originalReview.includes("Time to be confirmed"));
      assert.ok(originalReview.includes(longAddress));
      assert.ok(originalReview.includes("SW1A 1AA"));
      assert.ok(originalReview.includes("£22.00"));
      assert.ok(originalReview.includes("20% off"));
      await capture(page, output, `customer-remote-date-only-review-${viewport.width}.png`);
      revision = 2;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.getByText(/This service has changed/).waitFor();
      assert.ok((await page.locator(".review-details").innerText()).includes("£22.00"), "An active discount edit must not silently change a reviewed quote");
      await page.getByRole("button", { name: "Use updated service", exact: true }).click();
      await page.getByRole("button", { name: "Review request", exact: true }).click();
      assert.ok((await page.locator(".review-details").innerText()).includes("£19.25"));
      assert.ok((await page.locator(".review-details").innerText()).includes("30% off"));
      await capture(page, output, `customer-reviewed-discount-update-${viewport.width}.png`);
      assert.deepEqual(writes, [], "Browser QA must not submit real or fixture bookings during view-only checks");
      if (process.env.FFYON_FEATURES_SITE_SESSION) {
        await page.goto(new URL("/account", url).href, { waitUntil: "networkidle" });
        await page.getByRole("heading", { name: "Your details", exact: true }).waitFor();
        await page.locator("#saved-address").fill(longAddress);
        await capture(page, output, `customer-account-address-${viewport.width}.png`);
        await page.getByRole("button", { name: "Remove saved address", exact: true }).click();
        assert.equal(await page.locator("#saved-address").inputValue(), "");
        assert.equal(await page.locator("#saved-postcode").inputValue(), "");
        await page.getByText("Change password", { exact: true }).click();
        await capture(page, output, `customer-account-security-${viewport.width}.png`);
        await page.locator("details.delete-account summary").click();
        assert.equal(await page.getByRole("button", { name: "Permanently delete account", exact: true }).isDisabled(), true);
        await page.locator("#delete-password").fill("Disposable Browser Fixture Password");
        await page.locator("#delete-confirmation").fill("DELETE");
        assert.equal(await page.getByRole("button", { name: "Permanently delete account", exact: true }).isDisabled(), false);
        await capture(page, output, `customer-delete-account-confirmation-${viewport.width}.png`);
        assert.deepEqual(writes, [], "Account deletion UI checks must not submit any password or deletion request");

        await page.goto(new URL("/appointments", url).href, { waitUntil: "networkidle" });
        await page.getByRole("heading", { name: service().name, exact: true }).waitFor();
        await page.getByText("Time to be confirmed", { exact: false }).first().waitFor();
        await capture(page, output, `customer-confirmed-date-only-appointment-${viewport.width}.png`);
        await page.getByRole("button", { name: "Change date & time", exact: true }).click();
        const reschedule = page.getByRole("dialog");
        await reschedule.getByRole("heading", { name: "Change your appointment", exact: true }).waitFor();
        await page.getByText("Checking available dates...", { exact: true }).waitFor({ state: "hidden" });
        assert.equal(await reschedule.getByLabel("Confirm a time later", { exact: true }).isChecked(), true);
        assert.equal(await reschedule.locator(".available-calendar button[data-day]:not(:disabled)").count(), 2);
        await capture(page, output, `customer-date-only-reschedule-${viewport.width}.png`);
        await reschedule.getByRole("button", { name: "Back", exact: true }).click();
        await page.getByRole("button", { name: `Delete ${service().name} appointment`, exact: true }).click();
        const deleteAppointment = page.getByRole("dialog");
        await deleteAppointment.getByRole("heading", { name: "Delete this appointment?", exact: true }).waitFor();
        await capture(page, output, `customer-delete-appointment-confirmation-${viewport.width}.png`);
        await deleteAppointment.getByRole("button", { name: "Permanently delete appointment", exact: true }).click();
        await page.getByText("Your appointment has been permanently deleted.", { exact: true }).waitFor();
        assert.equal(customerAppointments.length, 0);
        assert.equal(writes.length, 1);
        assert.equal(writes[0].method, "DELETE");
        assert.equal(writes[0].body.revision, 1);
        assert.match(writes[0].body.operation_id, /^[0-9a-f-]{36}$/);
      }
      assert.deepEqual(errors, []);
      evidence.push({ target: "customer-features", viewport, backend: "mocked catalogue/availability/profile and disposable HTTP deletion fixture only", unavailableDatesDisabledBeforeSelection: true, remoteAddressAndPostcodeRequired: true, dateOnlyReview: true, discountVisibleAndChangeRequiresReview: true, savedAddressVisible: Boolean(process.env.FFYON_FEATURES_SITE_SESSION), accountSecurityAndDeletionForms: Boolean(process.env.FFYON_FEATURES_SITE_SESSION), dateOnlyRescheduleAndPhysicalDelete: Boolean(process.env.FFYON_FEATURES_SITE_SESSION), pageErrors: errors });
    } catch (error) {
      await page.screenshot({ path: resolve(output, `customer-failure-${viewport.width}.png`), fullPage: true });
      throw error;
    } finally { await page.close(); }
  }
}
