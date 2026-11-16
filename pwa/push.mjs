import { createECDH, ECDH } from "node:crypto";
import { encryptedJson } from "./encrypted-json.mjs";

const maxSubscribers = 32;
const interval = 45_000;
const emptySeen = () => ({ requests: null, payments: null, mail: null });
const b64url = /^[A-Za-z0-9_-]+$/;

export function parseAppleSubscription(input) {
  try {
    if (typeof input?.endpoint !== "string" || input.endpoint.length > 2048) return null;
    const endpoint = new URL(input.endpoint);
    if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".push.apple.com") ||
        endpoint.port || endpoint.username || endpoint.password || endpoint.hash || endpoint.pathname === "/") return null;
    const { auth, p256dh } = input.keys;
    if (typeof auth !== "string" || typeof p256dh !== "string" || auth.length !== 22 || p256dh.length !== 87 ||
        !b64url.test(auth) || !b64url.test(p256dh)) return null;
    const publicKey = Buffer.from(p256dh, "base64url");
    if (publicKey[0] !== 4) return null;
    ECDH.convertKey(publicKey, "prime256v1");
    return { endpoint: endpoint.href, keys: { auth, p256dh } };
  } catch { return null; }
}

export function vapidKeys(derive, subject) {
  const curve = createECDH("prime256v1");
  // Derive an application-specific key from the existing cluster secret. Keep it stable across rollouts.
  for (let index = 0; index < 16; index++) {
    const bytes = derive("web-push-vapid-v1", String(index));
    try { curve.setPrivateKey(bytes); } catch { continue; }
    return { subject, privateKey: bytes.toString("base64url"), publicKey: curve.getPublicKey().toString("base64url") };
  }
  throw new Error("Could not initialize the Web Push key.");
}

function countNew(seen, current) {
  if (!seen || current === undefined) return 0;
  const previous = new Set(seen);
  return current.filter(key => !previous.has(key)).length;
}

function mailChanges(seen, current) {
  if (current === undefined) return { count: 0, next: seen };
  const known = new Map((seen ?? []).map(row => [row.id, row]));
  const active = new Set(current.map(row => row.id));
  for (const [id, row] of known) if (!active.has(id)) known.set(id, { ...row, unread: 0 });
  let count = 0;
  for (const row of current) {
    const previous = known.get(row.id);
    if (!previous) count += row.unread;
    else if (row.messages > previous.messages || row.latest > previous.latest) {
      // Inbound mail can arrive while another message in that thread is read.
      const incoming = row.inbound && row.latest > previous.latest;
      count += Math.max(0, row.unread - previous.unread, Number(incoming));
    }
    known.delete(row.id);
    known.set(row.id, row);
  }
  return { count: seen ? count : 0, next: [...known.values()].slice(-500) };
}

function alertBody(requests, payments) {
  const parts = [];
  if (requests) parts.push(`${requests} booking ${requests === 1 ? "request" : "requests"}`);
  if (payments) parts.push(`${payments} ${payments === 1 ? "payment" : "payments"} to confirm`);
  return parts.join(" and ") + ".";
}

export function createPushService({ directory, key, vapid, origin, verify, readAlerts, send, report = console.warn }) {
  const file = encryptedJson(directory, "push.v1", key);
  let stored;
  let queue = Promise.resolve();
  let running;
  let timer;

  function subscriptions() {
    return stored ??= file.read().then(value => value?.subscriptions ?? []).catch(error => { stored = undefined; throw error; });
  }
  async function save(next) {
    await file.write({ subscriptions: next });
    stored = Promise.resolve(next);
  }
  function serialize(work) {
    const task = queue.then(work);
    queue = task.catch(() => {});
    return task;
  }
  async function status(id) {
    return { public_key: vapid.publicKey, enabled: (await subscriptions()).some(row => row.credential.id === id) };
  }
  function subscribe(credential, subscription) {
    return serialize(async () => {
      const rows = await subscriptions();
      const existing = rows.find(row => row.credential.id === credential.id && row.subscription.endpoint === subscription.endpoint);
      const others = rows.filter(row => row.credential.id !== credential.id && row.subscription.endpoint !== subscription.endpoint);
      if (others.length >= maxSubscribers) return null;
      await save([...others, { credential, subscription, seen: existing?.seen ?? emptySeen() }]);
      return { public_key: vapid.publicKey, enabled: true };
    });
  }
  function remove(id, expected) {
    return serialize(async () => {
      const rows = await subscriptions();
      const next = rows.filter(row => row.credential.id !== id || (expected && row !== expected));
      if (rows.length !== next.length) await save(next);
    });
  }

  async function deliver(row, alerts) {
    // Serialize with enable/disable. A completed disable cancels future sends for this device.
    return serialize(async () => {
      const rows = await subscriptions();
      const index = rows.indexOf(row);
      if (index === -1) return;
      const { seen } = row;
      const next = { ...seen };
      const email = mailChanges(seen.mail, alerts.mail);
      const requests = countNew(seen.requests, alerts.requests);
      const payments = countNew(seen.payments, alerts.payments);
      const attempts = [
        { route: "todo", count: requests + payments, body: alertBody(requests, payments), record: () => {
          next.requests = alerts.requests ?? seen.requests;
          next.payments = alerts.payments ?? seen.payments;
        } },
        { route: "mail", count: email.count, body: `${email.count} new unread ${email.count === 1 ? "email" : "emails"}.`,
          record: () => { next.mail = email.next; } },
      ];
      for (const attempt of attempts) {
        if (attempt.count) {
          const tag = `ffyon-${attempt.route}`;
          try {
            await send(row.subscription, JSON.stringify({ web_push: 8030, notification: {
              title: "Tanned by Ffy", body: attempt.body, navigate: `${origin}/#/${attempt.route}`, tag,
            } }), { vapidDetails: vapid, timeout: 8000, TTL: 900, topic: tag });
          } catch (error) {
            if (error?.statusCode === 404 || error?.statusCode === 410) {
              await save(rows.filter((_, position) => position !== index));
              return;
            }
            report("Web Push delivery failed.", Number.isInteger(error?.statusCode) ? error.statusCode : "transport");
            continue;
          }
        }
        attempt.record();
      }
      if (JSON.stringify(next) !== JSON.stringify(seen)) {
        const updated = [...rows];
        updated[index] = { ...row, seen: next };
        await save(updated);
      }
    });
  }

  async function scan() {
    const rows = await subscriptions();
    const approvals = await Promise.allSettled(rows.map(row => verify(row.credential)));
    const active = [];
    for (const [index, approval] of approvals.entries()) {
      const row = rows[index];
      if (approval.status === "rejected") continue;
      if (approval.value) active.push(row);
      else await remove(row.credential.id, row);
    }
    if (!active.length) return;
    const alerts = await readAlerts(active[0].credential);
    for (const row of active) await deliver(row, alerts);
  }
  function poll() {
    return running ??= scan().finally(() => { running = undefined; });
  }
  function wake() {
    if (timer) void poll().catch(() => report("Could not check push alerts."));
  }
  return {
    status, subscribe, remove, poll, wake,
    start() { if (!timer) { timer = setInterval(wake, interval); timer.unref(); wake(); } },
    stop() { clearInterval(timer); timer = undefined; },
  };
}
