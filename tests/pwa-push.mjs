import assert from "node:assert/strict";
import { createECDH, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { generateRequestDetails } from "web-push";
import { createAlertReader } from "../pwa/push-alerts.mjs";
import { createPushService, parseAppleSubscription, vapidKeys } from "../pwa/push.mjs";
import { createPwaServer } from "../pwa/server.mjs";
import { ledgerFixture } from "./support/ledger-fixture.mjs";

const origin = "https://ffyon.home";
const credential = { id: "iphone", token: "disposable-credential" };
const subject = "https://ffyon.example.com";
const seed = randomBytes(32);
const derive = (purpose, value) => createHmac("sha256", seed).update(`${purpose}:${value}`).digest();
const vapid = vapidKeys(derive, subject);

function appleSubscription(name = "test") {
  const curve = createECDH("prime256v1");
  curve.generateKeys();
  return { endpoint: `https://web.push.apple.com/${name}`, keys: {
    p256dh: curve.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url"),
  } };
}

test("accepts Apple subscriptions, rejects arbitrary destinations and signs encrypted Web Push requests", () => {
  const subscription = appleSubscription();
  assert.deepEqual(parseAppleSubscription(subscription), subscription);
  for (const endpoint of ["https://web.push.apple.com.evil.test/key", "https://webpush.apple.com/key",
    "https://web.push.apple.com:8443/key", "http://web.push.apple.com/key", "https://web.push.apple.com@evil.test/key",
    "https://user@web.push.apple.com/key", "https://web.push.apple.com/", "https://127.0.0.1/key"]) {
    assert.equal(parseAppleSubscription({ ...subscription, endpoint }), null);
  }
  assert.equal(parseAppleSubscription({ ...subscription, keys: { ...subscription.keys, p256dh: "A".repeat(87) } }), null);
  assert.deepEqual(vapidKeys(derive, subject), vapid);
  const request = generateRequestDetails(subscription, "Count-only test", { vapidDetails: vapid, topic: "ffyon-todo", TTL: 900 });
  assert.equal(request.endpoint, subscription.endpoint);
  assert.match(request.headers.Authorization, /^vapid t=/);
  assert.equal(request.headers["Content-Encoding"], "aes128gcm");
  assert.equal(request.headers.Topic, "ffyon-todo");
  assert.equal(request.body.includes(Buffer.from("Count-only test")), false);
});

test("quietly baselines, sends only new counts, survives a restart and removes revoked or expired phones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffyon-push-"));
  const key = randomBytes(32);
  const sent = [];
  const mail = { id: "customer-thread", unread: 1, messages: 1, latest: "2026-11-15T08:00:00Z", inbound: true };
  let alerts = { requests: ["old booking"], payments: [], mail: [mail] };
  const revoked = new Set();
  let failure;
  const build = () => createPushService({ directory, key, vapid, origin,
    verify: device => !revoked.has(device.id), readAlerts: async () => alerts, report: () => {},
    async send(subscription, raw, options) {
      if (failure) throw { statusCode: failure };
      sent.push({ subscription, payload: JSON.parse(raw), options });
    },
  });
  try {
    let service = build();
    const subscription = appleSubscription();
    await service.subscribe(credential, subscription);
    await service.poll();
    assert.equal(sent.length, 0);
    alerts = { requests: ["old booking", "new booking"], payments: ["new payment"], mail: [
      { ...mail, messages: 2, latest: "2026-11-15T09:00:00Z" },
    ] };
    await Promise.all([service.poll(), service.poll()]);
    assert.deepEqual(sent.map(item => item.payload.notification), [
      { title: "Tanned by Ffy", body: "1 booking request and 1 payment to confirm.", navigate: `${origin}/#/todo`, tag: "ffyon-todo" },
      { title: "Tanned by Ffy", body: "1 new unread email.", navigate: `${origin}/#/mail`, tag: "ffyon-mail" },
    ]);
    assert.ok(sent.every(item => item.payload.web_push === 8030 && item.options.topic === item.payload.notification.tag));
    const bytes = await readFile(join(directory, "push.v1"));
    assert.ok(!bytes.includes(Buffer.from(credential.token)) && !bytes.includes(Buffer.from(subscription.endpoint)));
    service = build();
    await service.subscribe(credential, subscription);
    await service.poll();
    assert.equal(sent.length, 2);
    alerts.mail[0] = { ...alerts.mail[0], messages: 3, latest: "2026-11-15T09:10:00Z", inbound: false };
    await service.poll();
    assert.equal(sent.length, 2);

    alerts.requests = [];
    alerts.payments = [];
    alerts.mail = undefined; // A failed mail read leaves its notification state in place.
    await service.poll();
    alerts.payments = ["new payment"]; // Marking a payment unpaid can make it actionable again.
    failure = 503;
    await service.poll();
    assert.equal(sent.length, 2);
    failure = undefined;
    await service.poll();
    assert.equal(sent.length, 3);
    assert.equal(sent.at(-1).payload.notification.body, "1 payment to confirm.");

    const second = { id: "iphone-2", token: "second-disposable" };
    await service.subscribe(second, appleSubscription("other"));
    await service.poll();
    revoked.add(credential.id);
    alerts.requests = ["another booking"];
    failure = 410;
    await service.poll();
    assert.equal((await service.status(credential.id)).enabled, false);
    assert.equal((await service.status(second.id)).enabled, false);
    assert.equal(sent.length, 3);
    await service.subscribe(second, appleSubscription("replacement"));
    await service.remove(second.id);
    assert.equal((await service.status(second.id)).enabled, false);
  } finally {
    await rm(join(directory, "push.v1"), { force: true });
    await rmdir(directory);
  }
});

test("background push scans at five-minute intervals and skips remote work with no subscribers", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const directory = await mkdtemp(join(tmpdir(), "ffyon-push-cadence-"));
  let checks = 0;
  let scans = 0;
  const service = createPushService({ directory, key: randomBytes(32), vapid, origin,
    verify: async () => { checks++; return true; },
    readAlerts: async () => { scans++; return { requests: [], payments: [], mail: [] }; },
    send: async () => assert.fail("No new alerts to send"),
  });
  try {
    service.start();
    await service.poll();
    assert.equal(checks, 0);
    await service.subscribe(credential, appleSubscription());
    service.wake();
    await service.poll();
    assert.deepEqual([checks, scans], [1, 1]);
    t.mock.timers.tick(299_999);
    assert.deepEqual([checks, scans], [1, 1]);
    t.mock.timers.tick(1);
    await service.poll();
    assert.deepEqual([checks, scans], [2, 2]);
  } finally {
    service.stop();
    await rm(join(directory, "push.v1"), { force: true });
    await rmdir(directory);
  }
});

test("only unchanged ledger checks reuse longer authorization, while data and saves recheck approval", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const directory = await mkdtemp(join(tmpdir(), "ffyon-ledger-auth-"));
  const id = "7ca0624c-eb50-4c29-8881-f48cfa824d99";
  let checks = 0;
  let revoked = false;
  const server = createPwaServer({ origin, directory, ledgerDirectory: directory, secret: randomBytes(32).toString("hex"),
    async fetchUpstream(url) {
      assert.equal(new URL(url).pathname, "/api/admin/v1/session");
      checks++;
      return revoked ? Response.json({ error: "Device revoked." }, { status: 401 }) : Response.json({ device: { id } });
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const headers = { Authorization: `Bearer ${"a".repeat(64)}`, "X-Ffyon-Device": id };
  const url = `http://127.0.0.1:${server.address().port}/api/ledger`;
  const get = revision => fetch(`${url}?revision=${revision}`, { headers });
  const db = ledgerFixture();
  const content = Buffer.from(db.export()).toString("base64");
  db.close();
  const put = (ledger_id, revision, operation_id) => fetch(url, {
    method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ledger_id, revision, operation_id, content }),
  });
  try {
    const seed = await put(null, 0, "d4cdafd2-a0ed-4f64-9c0b-4ef62fa5c879");
    assert.equal(seed.status, 200);
    const { ledger_id } = await seed.json();
    t.mock.timers.tick(59_999);
    for (let index = 0; index < 4; index++) {
      assert.deepEqual(await (await get(1)).json(), { ledger_id, revision: 1, content: null });
    }
    assert.equal(checks, 1);
    t.mock.timers.tick(1);
    assert.equal((await get(1)).status, 200);
    assert.equal(checks, 2);
    t.mock.timers.tick(6000);
    assert.equal((await (await get(0)).json()).content, content);
    assert.equal(checks, 3);
    assert.equal((await put(ledger_id, 1, "347ec314-a8b7-44f7-a0fb-2fc4c578a0b4")).status, 200);
    assert.equal(checks, 4);
    t.mock.timers.tick(6000);
    revoked = true;
    assert.equal((await get(1)).status, 401, "Returning a changed ledger requires current approval");
    assert.equal((await get(2)).status, 401, "A revocation clears the unchanged revision cache");
    assert.equal((await put(ledger_id, 2, "bd8cc228-6627-4105-ba02-8669f573dd52")).status, 401);
    assert.equal(checks, 7);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(join(directory, "ledger.v1"), { force: true });
    await rm(join(directory, "ledger-replica.v1"), { force: true });
    await rmdir(directory);
  }
});

test("checks live booking changes and uses London time and shared payment markers", async () => {
  const db = ledgerFixture();
  db.exec(`INSERT INTO transactions(id,type,date,amount_pence) VALUES (1,'income','2026-06-12',2500);
    INSERT INTO appointments(date,start_time,status,duration_min,price_pence,remote_id,transaction_id,time_confirmed) VALUES
      ('2026-06-12','09:00','confirmed',30,2500,'paid',1,1),
      ('2026-06-12','09:00','confirmed',30,2500,'cancelled-now',NULL,1),
      ('2026-06-11','00:00','confirmed',30,2500,NULL,NULL,0);`);
  const content = Buffer.from(db.export()).toString("base64");
  db.close();
  const booking = (id, extra = {}) => ({ id, date: "2026-06-12", start_time: "10:30", time_confirmed: true,
    duration_min: 30, price_pence: 2500, status: "confirmed", ...extra });
  const cloud = [booking("due"), booking("paid"), booking("cancelled-now", { status: "cancelled" }),
    booking("free", { price_pence: 0 }), booking("later", { start_time: "10:31" }),
    booking("untimed-today", { time_confirmed: false }), booking("pending", { status: "pending" }),
    booking("change", { start_time: "13:00", proposed_date: "2026-07-01", proposed_start_time: "10:00" })];
  const queries = [];
  let offlineMail = false;
  const read = createAlertReader({
    now: () => new Date("2026-06-12T10:00:00Z"),
    ledger: { get: async revision => ({ revision: 1, content: revision ? null : content }) },
    async request(_device, operation, query) {
      if (operation === "mail/unread") {
        if (offlineMail) throw new Error("Mail unavailable");
        return { conversations: [] };
      }
      queries.push(query);
      if (!query) return { snapshot: { appointments: cloud }, cursor: 11, changes: [] };
      return { snapshot: null, cursor: 12, changes: [{ entity: "appointment", id: "due", record: null }] };
    },
  });
  const first = await read(credential);
  assert.deepEqual(first.payments.map(key => JSON.parse(key)[0]), ["due", 3]);
  assert.deepEqual(first.requests.map(key => JSON.parse(key).slice(0, 2)), [["pending", "new"], ["change", "change"]]);
  offlineMail = true;
  const second = await read(credential);
  assert.equal(second.mail, undefined);
  assert.deepEqual(second.payments.map(key => JSON.parse(key)[0]), [3]);
  assert.deepEqual(queries, ["", "?cursor=11&limit=250"]);
});

test("legacy service-worker delivery displays a notification and click navigation stays in the tracker", async () => {
  const callbacks = new Map();
  const calls = [];
  const self = {
    location: { origin },
    addEventListener: (name, handler) => callbacks.set(name, handler),
    registration: { async showNotification(title, options) { calls.push([title, options.data.url]); } },
    clients: { matchAll: async () => [], openWindow: async url => calls.push(url) },
  };
  runInNewContext(await readFile(new URL("../pwa/public/sw.js", import.meta.url), "utf8"), { self, URL });
  let pending;
  const waitUntil = promise => { pending = promise; };
  callbacks.get("push")({ data: { json: () => ({ notification: { navigate: `${origin}/#/mail` } }) }, waitUntil });
  await pending;
  callbacks.get("push")({ notification: {}, waitUntil: () => assert.fail("Safari displays the declarative notification") });
  callbacks.get("notificationclick")({ notification: { close() {}, data: { url: "https://elsewhere.test/#/mail" } }, waitUntil });
  await pending;
  assert.deepEqual(calls, [["Tanned by Ffy", `${origin}/#/mail`], `${origin}/`]);
});
