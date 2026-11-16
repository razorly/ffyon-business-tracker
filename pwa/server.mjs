import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createLedger, ledgerLimit } from "./ledger.mjs";
import { createAlertReader } from "./push-alerts.mjs";
import { createPushService, parseAppleSubscription, vapidKeys } from "./push.mjs";

const site = "https://ffyon-customer.razorly.chatgpt.site";
const installCookie = "__Host-ffyon-install";
const adminCookie = "__Host-ffyon-admin";
const cookieLife = 365 * 24 * 60 * 60;
const token = /^[0-9a-f]{64}$/;
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const uuidPattern = new RegExp(`^${uuid}$`);
const mailItem = new RegExp(`^mail/conversations/${uuid}$`);
const mailAction = new RegExp(`^mail/conversations/${uuid}/(read|trash|restore)$`);
const attachment = new RegExp(`^mail/attachments/${uuid}/${uuid}$`);
const operations = new Map(Object.entries({
  sync: ["GET"], pairing: ["POST"], devices: ["GET", "PATCH"],
  clients: ["POST", "PATCH", "DELETE"], "clients/link": ["POST"],
  appointments: ["POST", "PATCH", "DELETE"], "appointments/series": ["POST"],
  services: ["POST", "PATCH"], settings: ["PUT"], blocks: ["POST", "DELETE"], import: ["POST"],
  "mail/conversations": ["GET"], "mail/unread": ["GET"], "mail/status": ["GET"],
  "mail/send": ["POST"], "mail/reconcile": ["POST"],
}));
const queryKeys = new Map([["sync", ["cursor", "limit"]], ["mail/conversations", ["cursor", "limit", "filter"]]]);
const staticPath = /^\/(?:index\.html|offline\.html|sw\.js|manifest\.webmanifest|(?:apple-touch-icon|icon-(?:192|512))\.png|(?:assets|branding)\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+)$/;
const contentTypes = {
  ".html": "text/html; charset=utf-8", ".webmanifest": "application/manifest+json",
  ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2", ".woff": "font/woff",
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}
function cookie(name, value, age = cookieLife) {
  return `${name}=${value}; Max-Age=${age}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}
function readCookie(request, name) {
  return (request.headers.cookie ?? "").split(";").map(item => item.trim())
    .find(item => item.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
}
async function body(request, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) throw new HttpError(415, "Expected JSON.");
  if (Number(request.headers["content-length"]) > limit) throw new HttpError(413, "Request is too large.");
  const chunks = [];
  let length = 0;
  // If the client exceeds the streaming limit, leave the socket open long enough to send 413.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) {
      request.resume();
      throw new HttpError(413, "Request is too large.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createPwaServer({ origin, secret, directory, ledgerDirectory, pushSender, fetchUpstream = fetch }) {
  if (!token.test(secret ?? "")) throw new Error("Expected a 32-byte FFYON_SESSION_KEY in hex.");
  if (new URL(origin).origin !== origin || new URL(origin).protocol !== "https:") throw new Error("Expected a trusted HTTPS origin.");
  const master = Buffer.from(secret, "hex");
  const derive = (purpose, value = "") => createHmac("sha256", master).update(`${purpose}:${value}`).digest();
  const sealKey = derive("credential-v1");
  const ledger = ledgerDirectory && createLedger(ledgerDirectory, derive("shared-ledger-v1"));
  const verified = new Map();
  const push = ledgerDirectory && pushSender && createPushService({
    directory: ledgerDirectory, key: derive("push-subscriptions-v1"), vapid: vapidKeys(derive, site), origin,
    send: pushSender,
    async verify(credential) {
      const rejected = await verifyDevice(credential, false);
      if (!rejected) return true;
      await rejected.body?.cancel();
      if (rejected.status === 401 || rejected.status === 403) return false;
      throw new Error("Could not verify the device for push delivery.");
    },
    readAlerts: createAlertReader({
      ledger,
      async request(credential, operation, query) {
        const result = await upstream(credential, operation, "GET", undefined, query);
        if (result.ok) return result.json();
        await result.body?.cancel();
        throw new Error("Could not load alerts.");
      },
    }),
  });

  function seal(credential, install) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", sealKey, iv).setAAD(Buffer.from(install));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(credential)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  }
  function session(request, install) {
    const sealed = readCookie(request, adminCookie);
    if (!token.test(install) || !/^[A-Za-z0-9_-]{50,300}$/.test(sealed)) throw new HttpError(401, "Pair this device to access the tracker.");
    try {
      const bytes = Buffer.from(sealed, "base64url");
      const cipher = createDecipheriv("aes-256-gcm", sealKey, bytes.subarray(0, 12))
        .setAAD(Buffer.from(install)).setAuthTag(bytes.subarray(12, 28));
      const credential = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]));
      if (uuidPattern.test(credential.id) && token.test(credential.token)) return credential;
    } catch { /* Invalid or tampered session. */ }
    throw new HttpError(401, "Pair this device to access the tracker.");
  }

  async function upstream(credential, operation, method, data, query = "") {
    let result;
    try {
      result = await fetchUpstream(`${site}/api/admin/v1/${operation}${query}`, {
        method, body: data, redirect: "error", signal: AbortSignal.timeout(25_000),
        headers: {
          Accept: "application/json", Authorization: `Bearer ${credential.token}`, "X-Ffyon-Device": credential.id,
          ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        },
      });
    } catch { throw new HttpError(502, "Could not reach the Tanned by Ffy site."); }
    if (!/^application\/json\b/i.test(result.headers.get("content-type") ?? "") || !result.body) {
      await result.body?.cancel();
      throw new HttpError(502, "The Tanned by Ffy site returned an unexpected response.");
    }
    return result;
  }

  async function publicSession(result, response, install, credential, cookies) {
    if (!result.ok) return forward(result, response);
    const { device } = await result.json();
    if (device?.id !== credential.id || typeof device.name !== "string") throw new HttpError(502, "The site returned invalid authorization.");
    response.setHeader("Set-Cookie", cookies);
    json(response, 200, {
      id: device.id, name: device.name,
      installation: derive("installation-v1", install).toString("hex"),
      database_key: derive("ledger-v1", install).toString("base64"),
    });
  }

  async function verifyDevice(credential, allowCached = true) {
    const key = derive("ledger-auth-v1", `${credential.id}:${credential.token}`).toString("hex");
    const now = Date.now();
    if (allowCached && (verified.get(key) ?? 0) > now) return null;
    const result = await upstream(credential, "session", "GET");
    if (!result.ok) {
      verified.delete(key);
      return result;
    }
    const { device } = await result.json();
    if (device?.id !== credential.id) throw new HttpError(502, "The site returned invalid authorization.");
    if (verified.size >= 128) verified.delete(verified.keys().next().value);
    verified.set(key, now + 5_000);
    return null;
  }

  async function ledgerApi(request, response, url, credential) {
    if (!ledger) throw new HttpError(503, "Shared ledger storage is unavailable.");
    if (request.method !== "GET" && request.method !== "PUT") throw new HttpError(405, "Method not allowed.");
    const rejected = await verifyDevice(credential);
    if (rejected) return forward(rejected, response);
    if (request.method === "GET") {
      const known = url.searchParams.get("revision");
      if ([...url.searchParams.keys()].some(name => name !== "revision") ||
          url.searchParams.getAll("revision").length > 1 || (known !== null && !/^\d{1,16}$/.test(known))) throw new HttpError(400, "Invalid ledger revision.");
      return json(response, 200, await ledger.get(known));
    }
    if (url.search) throw new HttpError(400, "Invalid ledger request.");
    let input;
    try { input = JSON.parse(await body(request, ledgerLimit)); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "Invalid ledger request."); }
    const result = await ledger.put(credential.id, input);
    return json(response, result.status, result.body);
  }

  async function pushApi(request, response, url, credential) {
    if (!push) throw new HttpError(503, "Push notifications are unavailable.");
    if (url.search || !["GET", "PUT", "DELETE"].includes(request.method)) throw new HttpError(405, "Method not allowed.");
    if (request.method === "DELETE") {
      await push.remove(credential.id);
      return json(response, 200, await push.status(credential.id));
    }
    const rejected = await verifyDevice(credential, request.method === "GET");
    if (rejected) return forward(rejected, response);
    if (request.method === "GET") return json(response, 200, await push.status(credential.id));
    let input;
    try { input = JSON.parse(await body(request, 4096)); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "Invalid notification subscription."); }
    const subscription = parseAppleSubscription(input);
    if (!subscription) throw new HttpError(422, "Enable notifications from the iPhone Home Screen app.");
    const result = await push.subscribe(credential, subscription);
    if (!result) throw new HttpError(409, "The tracker has reached its notification device limit.");
    push.wake();
    return json(response, 200, result);
  }

  async function api(request, response, url) {
    const method = request.method;
    const requestOrigin = request.headers.origin;
    if (request.headers["x-ffyon-pwa"] !== "1" || (requestOrigin && requestOrigin !== origin) ||
        (method !== "GET" && requestOrigin !== origin) || request.url.split("?")[0] !== url.pathname) {
      throw new HttpError(403, "Open the tracker directly to use this API.");
    }
    let install = readCookie(request, installCookie);
    const route = url.pathname.slice("/api/pwa/".length);
    if (route === "disconnect" && method === "POST" && !url.search) {
      await body(request, 256);
      if (push) {
        let credential;
        try { credential = session(request, install); }
        catch (error) { if (!(error instanceof HttpError) || error.status !== 401) throw error; }
        if (credential) await push.remove(credential.id);
      }
      response.setHeader("Set-Cookie", cookie(adminCookie, "", 0));
      return json(response, 200, { ok: true });
    }
    if (route === "pair" && method === "POST" && !url.search) {
      let input;
      try { input = JSON.parse(await body(request, 1024)); }
      catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "Invalid pairing details."); }
      const code = typeof input?.code === "string" ? input.code.trim() : "";
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      if (!/^[A-Z2-7]{12}$/.test(code) || !name || name.length > 80) throw new HttpError(400, "Enter a device name and a valid pairing code.");
      const credential = { id: randomUUID(), token: randomBytes(32).toString("hex") };
      const result = await upstream(credential, "redeem", "POST", JSON.stringify({ code, name, device_id: credential.id }));
      if (!result.ok) return forward(result, response);
      if (!token.test(install)) install = randomBytes(32).toString("hex");
      return publicSession(result, response, install, credential, [
        cookie(installCookie, install), cookie(adminCookie, seal(credential, install)),
      ]);
    }
    const credential = session(request, install);
    if (route === "ledger") return ledgerApi(request, response, url, credential);
    if (route === "push") return pushApi(request, response, url, credential);
    if (route === "session" && method === "GET" && !url.search) {
      const result = await upstream(credential, "session", "GET");
      return publicSession(result, response, install, credential, [cookie(installCookie, install)]);
    }
    if (!route.startsWith("admin/")) throw new HttpError(404, "Unknown tracker operation.");
    const operation = route.slice("admin/".length);
    const methods = operations.get(operation) ?? (mailItem.test(operation) || attachment.test(operation) ? ["GET"] : mailAction.test(operation) ? ["POST"] : []);
    if (!methods.includes(method)) throw new HttpError(404, "Unknown tracker operation.");
    const allowed = queryKeys.get(operation) ?? (mailItem.test(operation) ? ["cursor", "limit"] : []);
    const params = new URLSearchParams();
    for (const [key, value] of url.searchParams) {
      if (!allowed.includes(key) || params.has(key) || !/^[\w-]{1,512}$/.test(value)) throw new HttpError(400, "Invalid request parameters.");
      params.set(key, value);
    }
    const data = method === "GET" ? undefined : await body(request, 1024 * 1024);
    const result = await upstream(credential, operation, method, data, params.size ? `?${params}` : "");
    return forward(result, response);
  }

  const server = createServer({ requestTimeout: 35_000 }, async (request, response) => {
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.postcodes.io; frame-src https://www.openstreetmap.org; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const url = new URL(request.url, origin);
      if (url.origin !== origin || !request.url.startsWith("/")) throw new HttpError(400, "Invalid request.");
      if (url.pathname.startsWith("/api/pwa/")) return await api(request, response, url);
      if (url.pathname === "/api/ledger" && request.url.split("?")[0] === url.pathname) {
        const id = request.headers["x-ffyon-device"] ?? "";
        const match = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.authorization ?? "");
        if (request.headers.origin || !uuidPattern.test(id) || !match) throw new HttpError(401, "An approved device is required.");
        return await ledgerApi(request, response, url, { id, token: match[1] });
      }
      if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
      if (url.pathname === "/healthz") {
        await stat(join(directory, "index.html"));
        if (ledgerDirectory) await access(ledgerDirectory, constants.R_OK | constants.W_OK);
        return json(response, 200, { ok: true });
      }
      const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
      if (!staticPath.test(pathname)) throw new HttpError(404, "Not found.");
      const file = join(directory, pathname.slice(1));
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) throw new HttpError(404, "Not found.");
      response.writeHead(200, {
        "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream",
        "Content-Length": info.size,
        "Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      });
      if (request.method === "HEAD") return response.end();
      await pipeline(createReadStream(file), response);
    } catch (error) {
      if (response.headersSent || response.destroyed) return response.destroy();
      if (error instanceof HttpError) return json(response, error.status, { error: error.message });
      console.error("Tracker request failed", error?.name);
      return json(response, 500, { error: "The tracker could not complete this request." });
    }
  });
  server.on("listening", () => push?.start());
  server.on("close", () => push?.stop());
  return server;
}

async function forward(result, response) {
  response.writeHead(result.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  await pipeline(Readable.fromWeb(result.body), response);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { default: webPush } = await import("./dist/server-web-push.cjs");
  const server = createPwaServer({
    origin: process.env.FFYON_PUBLIC_ORIGIN, secret: process.env.FFYON_SESSION_KEY,
    directory: fileURLToPath(new URL("./dist", import.meta.url)),
    ledgerDirectory: process.env.FFYON_LEDGER_DIRECTORY,
    pushSender: webPush.sendNotification,
  });
  server.listen(Number(process.env.PORT || 8080), "0.0.0.0");
  process.on("SIGTERM", () => server.close());
}
