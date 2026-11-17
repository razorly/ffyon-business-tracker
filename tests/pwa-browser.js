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
    snapshot: url.searchParams.has("cursor") ? null : { clients: [customer, otherCustomer], appointments: [], services: [], blocks: [], settings, cursor: 1 },
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
  await page.getByRole("status", { name: "" }).filter({ hasText: "Checking authorization" }).waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "Set Up First Admin" }).count(), 0);
  await page.getByPlaceholder("e.g. Salon iPhone").fill("Test iPhone");
  await page.getByPlaceholder("XXXX-XXXX-XXXX").fill("ABCD-2345-EFGH");
  const [paired] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith("/api/pwa/pair")),
    page.getByRole("button", { name: "Pair Device" }).click(),
  ]);
  const nav = page.getByRole("navigation", { name: "Business tracker" });
  await nav.getByRole("link", { name: "Clients" }).click();
  await page.getByText(customer.name, { exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, "clients-iphone.png") });
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
    nav.getByRole("link", { name: "Mail" }).click(),
  ]);
  await page.getByRole("button", { name: "New entry" }).click();
  const entry = page.getByRole("dialog");
  await entry.getByRole("button", { name: "Income", exact: true }).click();
  await entry.getByLabel("Amount").fill("23.50");
  await entry.getByRole("button", { name: "Record income" }).click();
  await entry.waitFor({ state: "hidden" });
  await nav.getByRole("link", { name: "Finances" }).click();
  await page.getByText("£23.50", { exact: true }).first().waitFor();
  await page.reload();
  await page.getByText("£23.50", { exact: true }).first().waitFor();
  await page.screenshot({ path: resolve(output, "finances-iphone.png") });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await nav.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "This device" }).click();
  const pushUrl = `${origin}/api/pwa/push`;
  const [enrollment] = await Promise.all([
    page.waitForResponse(response => response.url() === pushUrl && response.request().method() === "PUT"),
    page.getByRole("button", { name: "Enable push notifications" }).click(),
  ]);
  assert.equal(enrollment.status(), 200);
  const pushStatus = await enrollment.json();
  assert.deepEqual(Object.keys(pushStatus).sort(), ["enabled", "public_key"]);
  assert.equal(pushStatus.enabled, true);
  await page.getByText("Alerts are enabled on this iPhone.", { exact: true }).waitFor();
  const [removal] = await Promise.all([
    page.waitForResponse(response => response.url() === pushUrl && response.request().method() === "DELETE"),
    page.getByRole("button", { name: "Disable push notifications" }).click(),
  ]);
  assert.equal((await removal.json()).enabled, false);
  await page.getByRole("button", { name: "Enable push notifications" }).waitFor();
  const [download] = await Promise.all([
    page.waitForEvent("download"), page.getByRole("button", { name: "Save backup" }).click(),
  ]);
  const backup = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(backup.transactions[0].amount_pence, 2350);
  backup.transactions[0].amount_pence = 4100;
  await page.getByRole("button", { name: "Restore from backup" }).click();
  const [picker] = await Promise.all([
    page.waitForEvent("filechooser"), page.getByRole("button", { name: "Choose file" }).click(),
  ]);
  await picker.setFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await page.getByText("Restored 1 entries", { exact: true }).waitFor();
  await nav.getByRole("link", { name: "Finances" }).click();
  await page.getByText("£41.00", { exact: true }).first().waitFor();
  const desktop = ledgerFixture();
  const seed = ledgerFixture();
  const date = backup.transactions[0].date;
  desktop.exec(`INSERT INTO clients(id,name,remote_id,notes,cloud_revision) VALUES
      (122,'PWA Test Client','${customer.id}','Desktop private note',1),
      (123,'Another Client','${otherCustomer.id}',NULL,1);
    INSERT INTO transactions(type,date,amount_pence,description,created_at) VALUES ('expense','${date}',7590,'Desktop-only expense','${date} 06:00:00');`);
  await seedLedger(seed, desktop, desktopId);
  const ledgerUrl = `${origin}/api/ledger`;
  const seeded = await context.request.put(ledgerUrl, {
    headers: desktopHeaders, data: { revision: 0, operation_id: randomUUID(), content: Buffer.from(seed.export()).toString("base64") },
  });
  assert.equal(seeded.status(), 200);
  desktop.close();
  seed.close();
  ledgerAvailable = true;

  const desktopExpense = page.getByRole("row").filter({ hasText: "Desktop-only expense" });
  await desktopExpense.waitFor({ timeout: 15000 });
  await page.getByText("£41.00", { exact: true }).first().waitFor();
  await desktopExpense.getByRole("button", { name: "Delete" }).click();
  const deleting = page.getByRole("dialog", { name: "Delete entry?" });
  await deleting.getByRole("button", { name: "Delete" }).click();
  try { await deleting.waitFor({ state: "hidden", timeout: 5000 }); }
  catch (error) { throw new Error(await deleting.getByRole("alert").textContent({ timeout: 2000 }), { cause: error }); }
  await desktopExpense.waitFor({ state: "hidden" });
  await nav.getByRole("link", { name: "Clients" }).click();
  await page.getByRole("button", { name: customer.name, exact: true }).click();
  await page.getByRole("heading", { name: "Client notes" }).waitFor();
  await page.getByText("Desktop private note", { exact: true }).waitFor();
  const editor = page.getByRole("dialog", { name: "Client notes" });
  const notes = editor.getByLabel("Private client notes");
  const save = editor.getByRole("button", { name: "Save notes" });
  await page.getByRole("button", { name: "Edit notes" }).click();
  assert.equal(await notes.inputValue(), "Desktop private note");
  await notes.fill("Edited from phone\nSecond line");
  await save.click();
  await editor.waitFor({ state: "hidden" });
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
  assert.equal(requests.some(([method, route]) => method !== "GET" && route === "clients"), false, "Client notes must never be sent to the website.");
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
  assert.deepEqual(errors, []);
  console.log("WebKit passed pairing, push opt-in and opt-out, Mail, backup restore, finance merge, synced notes and deletion, and revocation.");
} finally {
  await browser.close();
  server.close();
  await rm(join(ledgerDirectory, "ledger.v1"), { force: true });
  await rm(join(ledgerDirectory, "push.v1"), { force: true });
  await rmdir(ledgerDirectory);
}
