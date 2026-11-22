import type { AccessStatus } from "./access";

interface Session {
  id: string;
  name: string;
  database_key: string;
  installation: string;
}

const locked = (error: string | null = null): AccessStatus => ({
  state: "locked", device_id: null, device_name: null, expires_at: null, error,
});
const listeners = new Set<(status: AccessStatus) => void>();
let status = locked();
let database: { id: string; key: CryptoKey } | null = null;
let verifiedUntil = 0;
let check: Promise<AccessStatus> | undefined;
// Ignore responses from requests that overlapped a change to the session.
let revision = 0;

export function pwaStatus() { return status; }

function publish(next: AccessStatus) {
  status = next;
  if (status.state !== "online") {
    database = null;
    verifiedUntil = 0;
  }
  for (const listener of listeners) listener(status);
  return status;
}

export function onPwaAccessChanged(listener: (status: AccessStatus) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

async function request<T>(path: string, method: string, body?: unknown) {
  const response = await fetch(`/api/pwa/${path}`, {
    method,
    headers: { "X-Ffyon-PWA": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok) throw new PwaError(response.status, typeof result.error === "string" ? result.error : "Request failed.");
  return result as T;
}

class PwaError extends Error {
  constructor(public status: number, message: string) { super(`${status}: ${message}`); }
}

function compatible() {
  if (!window.isSecureContext || !crypto.subtle) throw new Error("Open the tracker over trusted HTTPS.");
  if (!navigator.locks || !window.indexedDB) throw new Error("This browser needs an update to store the tracker safely.");
}

async function authorize(session: Session, current: number) {
  const bytes = Uint8Array.from(atob(session.database_key), c => c.charCodeAt(0));
  if (bytes.length !== 32 || !session.installation || !session.id) throw new Error("The tracker returned an invalid session.");
  const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  if (current !== revision) return status;
  if (status.device_id && status.device_id !== session.id) ++revision;
  database = { id: session.installation, key };
  verifiedUntil = Date.now() + 30_000;
  return publish({ state: "online", device_id: session.id, device_name: session.name, expires_at: null, error: null });
}

export function checkPwaAccess() {
  if (check) return check;
  const current = revision;
  check = (async () => {
    try {
      compatible();
      const session = await request<Session>("session", "GET");
      return await authorize(session, current);
    } catch (error) {
      if (current !== revision) return status;
      if (status.state === "online") ++revision;
      if (error instanceof PwaError && error.status === 401) return publish(locked());
      const message = error instanceof PwaError ? error.message : error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError")
        ? "Reconnect to the tracker to verify this device." : error instanceof Error ? error.message : "Could not verify this device.";
      return publish(locked(message));
    }
  })().finally(() => { check = undefined; });
  return check;
}

export async function pairPwaDevice(code: string, name: string) {
  compatible();
  if (check) await check;
  const current = ++revision;
  return authorize(await request<Session>("pair", "POST", { code, name }), current);
}

export async function disconnectPwaDevice() {
  await request("disconnect", "POST", {});
  ++revision;
  return publish(locked());
}

export async function pwaDatabaseKey() {
  if (!database || Date.now() >= verifiedUntil) await checkPwaAccess();
  if (!database) throw new Error(status.error || "Pair this device to open business records.");
  return database;
}

export async function pwaAdminRequest<T>(operation: string, method: string, body?: unknown, query?: Record<string, string>) {
  const search = query ? "?" + new URLSearchParams(query) : "";
  return authorizedRequest<T>(`admin/${operation}${search}`, method, body);
}

async function authorizedRequest<T>(path: string, method: string, body?: unknown) {
  const current = revision;
  try {
    const value = await request<T>(path, method, body);
    if (current !== revision) throw new Error("The approved session changed. Open the tracker again.");
    return value;
  }
  catch (error) {
    if (current === revision && error instanceof PwaError && error.status === 401) {
      ++revision;
      publish(locked("This device needs admin approval."));
    }
    throw error;
  }
}

export function pwaLedgerRequest<T>(revision?: number, body?: unknown) {
  return authorizedRequest<T>(revision === undefined ? "ledger" : `ledger?revision=${revision}`, body === undefined ? "GET" : "PUT", body);
}

export interface PwaPushStatus { enabled: boolean; public_key: string }
export const getPwaPush = () => authorizedRequest<PwaPushStatus>("push", "GET");
export const enablePwaPush = (subscription: PushSubscriptionJSON) => authorizedRequest<PwaPushStatus>("push", "PUT", subscription);
export const disablePwaPush = () => authorizedRequest<PwaPushStatus>("push", "DELETE");
