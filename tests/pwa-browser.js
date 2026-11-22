import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createPwaServer } from "../pwa/server.mjs";
import { ledgerFixture, seedLedger } from "./support/ledger-fixture.mjs";

// Use only disposable state and a stub of the site's admin API.
const require = createRequire(import.meta.url);
const { webkit, devices } = require(process.env.FFYON_PLAYWRIGHT_PATH || "playwright");
const output = resolve("test-results/pwa");
await mkdir(output, { recursive: true });
const key = resolve(output, "local-test.key");
const cert = resolve(output, "local-test.pem");
execFileSync(process.env.FFYON_TEST_OPENSSL || "openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
  "-addext", "subjectAltName=DNS:localhost", "-keyout", key, "-out", cert,
], { stdio: "ignore" });

const desktopId = randomUUID();
const desktopToken = randomBytes(32).toString("hex");
const desktopHeaders = { Authorization: `Bearer ${desktopToken}`, "X-Ffyon-Device": desktopId };
const devicesById = new Map([[desktopId, { name: "Test desktop", token: desktopHeaders.Authorization }]]);
let revoked = false;
let ledgerAvailable = false;
const requests = [];
const customer = {
  id: "7bfc4136-a7c7-4046-819e-8ee73f4c6031", name: "PWA Test Client", account_id: null,
  email: "", phone: "", saved_address: "", saved_postcode: "", disabled: false, revision: 1,
  updated_at: "2026-10-01T12:00:00Z",
};
const otherCustomer = { ...customer, id: "2cced26e-f0bb-4c6d-8d68-696b06c39942", name: "Another Client" };
const matchingBooking = {
  id: randomUUID(), client_id: otherCustomer.id, service_id: null, service_name: "", date: "2026-11-18",
  start_time: "19:00", time_confirmed: true, duration_min: 30, price_pence: 0, base_price_pence: 0,
  discount_percent: 0, is_remote: false, visit_address: "", visit_postcode: "", notes: "Customer booking text",
  status: "confirmed", revision: 1, proposed_date: null, proposed_start_time: null, proposed_time_confirmed: null,
  series_id: null, created_at: "2026-11-17T09:00:00Z", updated_at: "2026-11-17T09:00:00Z",
};
let siteAppointments = [];
const settings = {
  booking_enabled: true, timezone: "Europe/London", slot_minutes: 30, horizon_days: 90, opening_hours: [], revision: 1,
};
const mockSite = async (raw, { method, headers, body }) => {
  const url = new URL(raw);
  assert.equal(url.origin, "https://ffyon-customer.razorly.chatgpt.site");
  const route = url.pathname.slice("/api/admin/v1/".length);
  requests.push([method, route]);
  const id = headers["X-Ffyon-Device"];
  const token = headers.Authorization;
  if (route === "redeem") {
    const { code, name, device_id } = JSON.parse(body);
    assert.equal(device_id, id);
    assert.match(token, /^Bearer [0-9a-f]{64}$/);
    if (code !== "ABCD2345EFGH") return Response.json({ error: "Invalid code." }, { status: 403 });
    devicesById.set(id, { id, name, token });
  }
  const authorized = devicesById.get(id);
  if (!authorized || authorized.token !== token || revoked) {
    return Response.json({ error: "Device unauthorized." }, { status: 401 });
  }
  if (route === "redeem" || route === "session") return Response.json({ device: { id, name: authorized.name }, lease: {} });
  if (route === "sync") return Response.json({
    cursor: 1, changes: [], has_more: false,
    snapshot: url.searchParams.has("cursor") ? null : { clients: [customer, otherCustomer], appointments: siteAppointments, services: [], blocks: [], settings, cursor: 1 },
  });
  if (route === "mail/unread") return Response.json({ conversations: [], unread_count: 0 });
  if (route === "mail/conversations") return Response.json({ conversations: [], next_cursor: null });
  if (route === "mail/status") return Response.json({ configured: true, receiving_configured: true, sender_address: "salon@example.test", receiving_addresses: ["salon@example.test"] });
  if (route === "devices") return Response.json({ devices: [{ id, name: authorized.name }] });
  throw new Error(`Unexpected mock request ${method} ${route}`);
};

const server = createServer({ key: await readFile(key), cert: await readFile(cert) });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `https://localhost:${server.address().port}`;
const ledgerDirectory = await mkdtemp(join(output, "test-ledger-"));
const app = createPwaServer({ origin, secret: randomBytes(32).toString("hex"), directory: resolve("pwa/dist"), ledgerDirectory,
  fetchUpstream: mockSite, pushSender: async () => assert.fail("The loopback UI fixture must never deliver a real push."),
});
server.on("request", (request, response) => {
  if (!ledgerAvailable && request.url.startsWith("/api/pwa/ledger")) {
    response.writeHead(503, { "Content-Type": "application/json" }).end('{"error":"Legacy fixture mode"}');
  } else app.emit("request", request, response);
});
const browser = await webkit.launch();
try {
  const context = await browser.newContext({ ...devices["iPhone 14"], ignoreHTTPSErrors: true });
  const curve = createECDH("prime256v1");
  curve.generateKeys();
  await context.addInitScript(subscription => {
    let active = null;
    let granted = false;
    Object.defineProperty(navigator, "standalone", { value: true });
    Object.defineProperty(window, "Notification", { configurable: true, value: { get permission() { return granted ? "granted" : "default"; } } });
    Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", {
      value: {
        getSubscription: async () => active,
        async subscribe(options) {
          if (!options.userVisibleOnly || options.applicationServerKey.length !== 65) throw new Error("Invalid subscribe options");
          granted = true;
          active = { toJSON: () => subscription, async unsubscribe() { active = null; return true; } };
          return active;
        },
      },
    });
  }, { endpoint: "https://web.push.apple.com/test-fixture", keys: {
    p256dh: curve.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url"),
  } });
  const anonymous = await context.request.get(`${origin}/api/pwa/admin/sync`, { headers: { "X-Ffyon-PWA": "1" } });
  assert.equal(anonymous.status(), 401);
  assert.equal((await context.request.get(`${origin}/api/pwa/push`, { headers: { "X-Ffyon-PWA": "1" } })).status(), 401);
  assert.equal(requests.length, 0);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole("heading", { name: "Admin access required" }).waitFor();
  await page.getByRole("status", { name: "" }).filter({ hasText: "Checking this device" }).waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "Set up first admin" }).count(), 0);
  await page.getByPlaceholder("e.g. Salon iPhone").fill("Test iPhone");
  await page.getByPlaceholder("XXXX-XXXX-XXXX").fill("ABCD-2345-EFGH");
  const [paired] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith("/api/pwa/pair")),
    page.getByRole("button", { name: "Pair device" }).click(),
  ]);
  // The phone shell: four tabs and New along the bottom, Mail and Settings in the header beside her logo.
  const nav = page.getByRole("navigation", { name: "Main" });
  const header = page.getByRole("banner");
  await header.getByRole("img", { name: "Tanned by Ffy" }).waitFor();
  assert.deepEqual(await nav.getByRole("link").allTextContents(), ["Today", "Diary", "Money", "Clients"]);
  await page.getByRole("heading", { name: "Needs you" }).waitFor();
  const fits = async name => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${name} must not scroll sideways`);
    await page.screenshot({ path: resolve(output, `${name}-iphone.png`) });
  };
  await fits("today");
  await nav.getByRole("link", { name: "Diary" }).click();
  await page.getByRole("heading", { name: "Diary", exact: true }).waitFor();
  await fits("diary");
  await nav.getByRole("link", { name: "Clients" }).click();
  await page.getByText(customer.name, { exact: true }).waitFor();
  await fits("clients");
  const cookies = await context.cookies();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.every(cookie => cookie.name.startsWith("__Host-") && cookie.httpOnly && cookie.secure));
  const issued = await paired.headerValues("set-cookie");
  assert.equal(issued.length, 2);
  assert.ok(issued.every(value => value.includes("; Path=/; Secure; HttpOnly; SameSite=Strict")));
  assert.equal(await page.evaluate(() => document.cookie), "");
  const forged = await context.request.post(`${origin}/api/pwa/disconnect`, {
    headers: { "X-Ffyon-PWA": "1", Origin: "https://another.example" }, data: {},
  });
  assert.equal(forged.status(), 403);
  const bootstrap = await context.request.post(`${origin}/api/pwa/admin/bootstrap`, {
    headers: { "X-Ffyon-PWA": "1", Origin: origin }, data: {},
  });
  assert.equal(bootstrap.status(), 404);
  await Promise.all([
    page.waitForResponse(response => response.url().includes("/api/pwa/admin/mail/conversations")),
    header.getByRole("link", { name: /^Mail/ }).click(),
  ]);
  await page.getByRole("heading", { name: "Mail", exact: true }).waitFor();
  await fits("mail");
  await nav.getByRole("button", { name: "New", exact: true }).click();
  const entry = page.getByRole("dialog", { name: "New", exact: true });
  await entry.getByRole("button", { name: "Money in", exact: true }).click();
  await page.screenshot({ path: resolve(output, "new-iphone.png") });
  await entry.getByLabel(/^Amount/).fill("23.50");
  await entry.getByRole("button", { name: "Record income" }).click();
  await entry.waitFor({ state: "hidden" });
  await nav.getByRole("link", { name: "Money" }).click();
  await page.getByText("£23.50", { exact: true }).first().waitFor();
  await page.reload();
  await page.getByText("£23.50", { exact: true }).first().waitFor();
  await fits("money");
  await header.getByRole("link", { name: "Settings" }).click();
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await sections.getByRole("link", { name: /This device/ }).waitFor();
  assert.equal(await sections.getByRole("link").count(), 5);
  await fits("settings");
  await sections.getByRole("link", { name: /This device/ }).click();
  const pushUrl = `${origin}/api/pwa/push`;
  const [enrollment] = await Promise.all([
    page.waitForResponse(response => response.url() === pushUrl && response.request().method() === "PUT"),
    page.getByRole("button", { name: "Turn on notifications" }).click(),
  ]);
  assert.equal(enrollment.status(), 200);
  const pushStatus = await enrollment.json();
  assert.deepEqual(Object.keys(pushStatus).sort(), ["enabled", "public_key"]);
  assert.equal(pushStatus.enabled, true);
  await page.getByText("Notifications are on for this iPhone.", { exact: true }).waitFor();
  await fits("settings-device");
  const [removal] = await Promise.all([
    page.waitForResponse(response => response.url() === pushUrl && response.request().method() === "DELETE"),
    page.getByRole("button", { name: "Turn off notifications" }).click(),
  ]);
  assert.equal((await removal.json()).enabled, false);
  await page.getByRole("button", { name: "Turn on notifications" }).waitFor();
  const [download] = await Promise.all([
    page.waitForEvent("download"), page.getByRole("button", { name: "Save backup" }).click(),
  ]);
  const backup = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(backup.transactions[0].amount_pence, 2350);
  backup.transactions[0].amount_pence = 4100;
  const archivedClientId = backup.clients.find(client => client.remote_id === otherCustomer.id).id;
  const earlierAppointment = {
    id: 81, date: matchingBooking.date, start_time: "18:00", duration_min: 30, client_id: archivedClientId,
    category_id: null, transaction_id: null, status: "confirmed", notes: "Earlier note for missing booking",
    created_at: matchingBooking.created_at,
  };
  backup.appointments = [
    earlierAppointment,
    { ...earlierAppointment, id: 82, start_time: "19:00", remote_id: matchingBooking.id, notes: "Earlier appointment note" },
    { ...earlierAppointment, id: 83, start_time: "20:00", client_id: null, notes: "Earlier unlinked note" },
  ];
  siteAppointments = [matchingBooking];
  await page.getByRole("button", { name: "Restore from backup" }).click();
  const [picker] = await Promise.all([
    page.waitForEvent("filechooser"), page.getByRole("button", { name: "Choose file" }).click(),
  ]);
  await picker.setFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await page.getByText("Restored 1 entries", { exact: true }).waitFor();
  await nav.getByRole("link", { name: "Money" }).click();
  await page.getByText("£41.00", { exact: true }).first().waitFor();
  const desktop = ledgerFixture();
  const seed = ledgerFixture();
  const date = backup.transactions[0].date;
  const missingBooking = { ...matchingBooking, id: randomUUID(), start_time: "20:30", notes: "" };
  desktop.exec(`INSERT INTO clients(id,name,remote_id,notes,cloud_revision) VALUES
      (122,'PWA Test Client','${customer.id}','Desktop private note',1),
      (123,'Another Client','${otherCustomer.id}',NULL,1);
    INSERT INTO transactions(type,date,amount_pence,description,created_at) VALUES ('expense','${date}',7590,'Desktop-only expense','${date} 06:00:00');
    INSERT INTO appointments(date,start_time,duration_min,remote_id,client_id,status,cloud_revision,customer_notes,notes) VALUES
      ('${matchingBooking.date}','19:00',30,'${matchingBooking.id}',123,'confirmed',1,'Customer booking text','Shared appointment note');
    INSERT INTO sync_state VALUES ('cursor','1');`);
  await seedLedger(seed, desktop, desktopId);
  const ledgerUrl = `${origin}/api/ledger`;
  const seeded = await context.request.put(ledgerUrl, {
    headers: desktopHeaders, data: { revision: 0, operation_id: randomUUID(), content: Buffer.from(seed.export()).toString("base64") },
  });
  assert.equal(seeded.status(), 200);
  desktop.close();
  seed.close();
  siteAppointments.push(missingBooking);
  ledgerAvailable = true;

  // Entries are a list now: tapping one opens it, and Delete lives in that dialog.
  const desktopExpense = page.getByRole("button").filter({ hasText: "Desktop-only expense" });
  await desktopExpense.waitFor({ timeout: 15000 });
  await page.getByText("£41.00", { exact: true }).first().waitFor();
  await desktopExpense.click();
  const deleting = page.getByRole("dialog", { name: "Edit entry" });
  await deleting.getByRole("button", { name: "Delete", exact: true }).click();
  try { await deleting.waitFor({ state: "hidden", timeout: 5000 }); }
  catch (error) { throw new Error(await deleting.getByRole("alert").textContent({ timeout: 2000 }), { cause: error }); }
  await desktopExpense.waitFor({ state: "hidden" });
  await nav.getByRole("link", { name: "Clients" }).click();
  await page.getByRole("button", { name: customer.name, exact: true }).click();
  await page.getByRole("heading", { name: "Client notes" }).waitFor();
  await page.getByText("Desktop private note", { exact: true }).waitFor();
  // Notes are edited in place on the profile, not in a separate dialog.
  const editor = page.getByRole("region", { name: "Client notes" });
  const notes = page.getByLabel("Private client notes");
  const save = page.getByRole("button", { name: "Save notes" });
  await page.getByRole("button", { name: "Edit notes" }).click();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await notes.inputValue(), "Desktop private note");
  await fits("client-notes");
  await notes.fill("Edited from phone\nSecond line");
  await save.click();
  await notes.waitFor({ state: "hidden" });
  const snapshot = await (await context.request.get(ledgerUrl, { headers: desktopHeaders })).json();
  const shared = ledgerFixture(Buffer.from(snapshot.content, "base64"));
  assert.deepEqual(shared.select("SELECT amount_pence FROM transactions"), [{ amount_pence: 4100 }]);
  assert.equal(shared.select("SELECT notes FROM clients WHERE id=122")[0].notes, "Edited from phone\nSecond line");
  assert.equal(shared.select("SELECT notes FROM clients WHERE id=123")[0].notes, null);
  await page.getByRole("button", { name: "Edit notes" }).click();
  await notes.fill("Unsaved phone draft");
  shared.exec("UPDATE clients SET notes='Changed from desktop' WHERE id=122");
  const changed = await context.request.put(ledgerUrl, { headers: desktopHeaders, data: {
    ledger_id: snapshot.ledger_id, revision: snapshot.revision, operation_id: randomUUID(), content: Buffer.from(shared.export()).toString("base64"),
  } });
  assert.equal(changed.status(), 200);
  shared.close();
  await save.click();
  await editor.getByRole("alert").filter({ hasText: "changed on another device" }).waitFor();
  assert.equal(await notes.inputValue(), "Unsaved phone draft");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByText("Changed from desktop", { exact: true }).waitFor({ timeout: 12000 });
  await page.getByRole("button", { name: "Edit notes" }).click();
  await notes.fill("");
  await save.click();
  await page.getByText("No notes yet.", { exact: true }).waitFor();
  const cleared = await (await context.request.get(ledgerUrl, { headers: desktopHeaders })).json();
  const afterClear = ledgerFixture(Buffer.from(cleared.content, "base64"));
  assert.equal(afterClear.select("SELECT notes FROM clients WHERE id=122")[0].notes, null);
  afterClear.close();

  await page.getByRole("button", { name: "All clients" }).click();
  await page.getByRole("button", { name: otherCustomer.name, exact: true }).click();
  await page.getByRole("button", { name: "Add notes" }).click();
  await notes.fill("Notes for the second client");
  await save.click();
  await page.getByText("Notes for the second client", { exact: true }).waitFor();

  // Reviews work even for bookings absent from the Diary.
  const reviewButton = page.getByRole("button", { name: "Review records" });
  const reviewDialog = page.getByRole("dialog", { name: "Earlier records to review" });
  await reviewButton.click();
  const missing = reviewDialog.getByRole("listitem").filter({ hasText: "Earlier note for missing booking" });
  const matched = reviewDialog.getByRole("listitem").filter({ hasText: "Earlier appointment note" });
  const unlinked = reviewDialog.getByRole("listitem").filter({ hasText: "Earlier unlinked note" });
  const addToClient = missing.getByRole("button", { name: "Add to client notes" });
  await addToClient.waitFor();
  await missing.getByText(/No matching appointment was found/).waitFor();
  await unlinked.getByRole("button", { name: "Copy note" }).waitFor();
  assert.equal(await unlinked.getByRole("button", { name: "Add to client notes" }).count(), 0);

  const beforeReview = await (await context.request.get(ledgerUrl, { headers: desktopHeaders })).json();
  const concurrent = ledgerFixture(Buffer.from(beforeReview.content, "base64"));
  concurrent.exec("UPDATE clients SET notes='Newer note from desktop' WHERE id=123");
  const concurrentSave = await context.request.put(ledgerUrl, { headers: desktopHeaders, data: {
    ledger_id: beforeReview.ledger_id, revision: beforeReview.revision, operation_id: randomUUID(), content: Buffer.from(concurrent.export()).toString("base64"),
  } });
  concurrent.close();
  assert.equal(concurrentSave.status(), 200);
  await addToClient.click();
  await reviewDialog.getByRole("alert").filter({ hasText: /changed/ }).waitFor();
  await reviewDialog.getByRole("button", { name: "Refresh", exact: true }).click();
  await missing.getByText("Newer note from desktop", { exact: true }).waitFor();
  await addToClient.click();
  await missing.waitFor({ state: "hidden" });
  await matched.getByRole("button", { name: "Add to appointment note" }).click();
  await matched.waitFor({ state: "hidden" });
  await unlinked.getByRole("button", { name: "Dismiss", exact: true }).click();
  await reviewDialog.waitFor({ state: "hidden" });
  await reviewButton.waitFor({ state: "hidden" });
  const reopened = await context.newPage();
  reopened.on("pageerror", error => errors.push(error.message));
  await reopened.goto(origin);
  await reopened.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Clients" }).waitFor();
  assert.equal(await reopened.getByRole("button", { name: "Review records" }).count(), 0);
  const reviewedSnapshot = await (await context.request.get(ledgerUrl, { headers: desktopHeaders })).json();
  const reviewed = ledgerFixture(Buffer.from(reviewedSnapshot.content, "base64"));
  assert.equal(reviewed.select("SELECT notes FROM clients WHERE id=123")[0].notes, "Newer note from desktop\n\nEarlier note for missing booking");
  assert.deepEqual(reviewed.select("SELECT notes,customer_notes FROM appointments WHERE remote_id=$1", [matchingBooking.id]), [{
    notes: "Shared appointment note\n\nEarlier appointment note", customer_notes: "Customer booking text",
  }]);
  assert.deepEqual(reviewed.select("SELECT start_time, transaction_id FROM appointments WHERE remote_id=$1", [missingBooking.id]), [{ start_time: "20:30", transaction_id: null }]);
  const phoneId = [...devicesById.keys()].find(id => id !== desktopId);
  assert.deepEqual(JSON.parse(reviewed.select("SELECT review FROM ledger_imports WHERE device_id=$1", [phoneId])[0].review), {
    entries: [], clients: [], appointments: [],
  });
  reviewed.close();
  assert.equal(requests.some(([method, route]) => method !== "GET" && route === "clients"), false, "Client notes must never be sent to the website.");
  assert.equal(requests.some(([method, route]) => method !== "GET" && route.startsWith("appointments")), false, "Reviewing a note must never write a booking to the website.");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  assert.deepEqual(await page.evaluate(async () => {
    const cache = await caches.open("ffyon-offline-v1");
    return (await cache.keys()).map(request => new URL(request.url).pathname);
  }), ["/offline.html"]);
  revoked = true;
  // Re-check the existing app on focus, as an iPhone would when brought back
  // to the foreground. Reloading here can cancel an in-flight ledger fetch.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("heading", { name: "Admin access required" }).waitFor();
  await nav.waitFor({ state: "hidden" });
  await reopened.close();
  assert.deepEqual(errors, []);
  console.log("WebKit passed pairing, push, Mail, backup restore, missed booking recovery, finance and note sync, appointment-note review and conflicts, and revocation.");
} finally {
  await browser.close();
  server.close();
  await rm(join(ledgerDirectory, "ledger.v1"), { force: true });
  await rm(join(ledgerDirectory, "ledger-replica.v1"), { force: true });
  await rm(join(ledgerDirectory, "push.v1"), { force: true });
  await rmdir(ledgerDirectory);
}
