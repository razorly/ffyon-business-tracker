import { invoke } from "@tauri-apps/api/core";
import { isPwa, requireOnlineAccess } from "./access";
import { openBrowserSqlite } from "./browser-sqlite";
import { exportAll, getDeviceDb, type Db } from "./db";
import { emptyReview, hasLegacyActivity, mergeLegacyLedger, parseReview, seedLedger, type LedgerReview } from "./ledger-merge";
import { pwaLedgerRequest } from "./pwa-access";

type Sqlite = Awaited<ReturnType<typeof openBrowserSqlite>>;
interface LedgerInfo {
  ledger_id: string | null;
  revision: number;
}
interface LedgerResponse extends LedgerInfo { content: string | null }
interface LoadedLedger extends LedgerInfo { bytes?: Uint8Array }
interface LedgerWrite extends LedgerInfo { operation_id: string; content: string }
interface Receipt extends LedgerInfo { applied_revision: number }
export interface SharedLedger {
  id: string;
  revision: number;
  review: LedgerReview;
}

const lastLedgerKey = "ffyon-shared-ledger-id";
export const LEDGER_REFRESH = "ffyon-ledger-refresh";

let loaded: LoadedLedger | undefined;
let fetchedAt = 0;
let reading: Promise<LoadedLedger> | undefined;
let generation = 0;

function toBase64(bytes: Uint8Array) {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(text);
}

export function previousSharedLedger() {
  try { return localStorage.getItem(lastLedgerKey); } catch { return null; }
}

export function resetSharedLedger() {
  ++generation;
  loaded = undefined;
  fetchedAt = 0;
  reading = undefined;
}

async function request<T>(revision?: number, body?: LedgerWrite) {
  await requireOnlineAccess();
  try {
    return isPwa() ? await pwaLedgerRequest<T>(revision, body) : await invoke<T>("ledger_request", { revision, body });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function fetchLedger(force = false) {
  if (reading) return reading;
  if (!force && loaded?.bytes && Date.now() - fetchedAt < 750) return Promise.resolve(loaded);
  const current = loaded;
  const started = generation;
  const task = (async () => {
    const value = await request<LedgerResponse>(current?.revision);
    if (started !== generation) throw new Error("The ledger session changed. Open the tracker again.");
    if (!Number.isSafeInteger(value.revision) || value.revision < 0 || Boolean(value.ledger_id) !== (value.revision > 0)) {
      throw new Error("The shared ledger returned an invalid revision.");
    }
    const expected = previousSharedLedger();
    if (expected && value.ledger_id !== expected) throw new Error("The shared ledger is missing or has changed identity. The device copy is still available for review.");
    if (loaded?.ledger_id && loaded.ledger_id === value.ledger_id && loaded.revision > value.revision) return loaded;
    const bytes = value.content ? Uint8Array.from(atob(value.content), char => char.charCodeAt(0)) :
      current?.ledger_id === value.ledger_id && current?.revision === value.revision ? current.bytes : undefined;
    if (value.ledger_id && !bytes) throw new Error("The shared ledger returned an incomplete snapshot.");
    fetchedAt = Date.now();
    return loaded = { ledger_id: value.ledger_id, revision: value.revision, bytes };
  })().finally(() => { if (reading === task) reading = undefined; });
  return reading = task;
}

async function saveLedger(base: LoadedLedger, bytes: Uint8Array) {
  const current = generation;
  const body = {
    ledger_id: base.ledger_id, revision: base.revision,
    operation_id: crypto.randomUUID(), content: toBase64(bytes),
  };
  if (body.content.length > 16 * 1024 * 1024 - 2048) throw new Error("The ledger is too large to sync.");
  let saved: Receipt;
  try { saved = await request<Receipt>(undefined, body); }
  catch (error) {
    if (current !== generation || /^4\d\d:/.test(String((error as Error).message))) throw error;
    // Retry the exact operation once if the commit may have reached the server.
    saved = await request<Receipt>(undefined, body);
  }
  if (current !== generation) throw new Error("The ledger session changed. Check your records before retrying.");
  if (!saved.ledger_id || !Number.isSafeInteger(saved.revision) || saved.applied_revision !== base.revision + 1) {
    throw new Error("The server could not confirm the save. Refresh before trying again.");
  }
  const result = { ledger_id: saved.ledger_id, revision: saved.applied_revision, bytes };
  if (saved.revision === saved.applied_revision && (!loaded || loaded.revision <= saved.revision)) {
    loaded = result;
    fetchedAt = Date.now();
  } else { fetchedAt = 0; }
  return result;
}

export async function reconcileLedger(deviceId: string, active?: SharedLedger): Promise<SharedLedger | null> {
  let snapshot = await fetchLedger(true);
  if (active?.id === snapshot.ledger_id) return { ...active, revision: snapshot.revision };
  try {
    const local = await getDeviceDb();
    if (!snapshot.bytes) {
      if (!hasLegacyActivity(await exportAll(local))) return null;
      const copy = await openBrowserSqlite();
      try {
        await seedLedger(copy, local, deviceId);
        snapshot = await saveLedger(snapshot, copy.export());
      } finally { copy.close(); }
      return finish(snapshot, emptyReview());
    }
    const copy = await openBrowserSqlite(snapshot.bytes);
    try {
      const [known] = copy.select<{ review: string }[]>("SELECT review FROM ledger_imports WHERE device_id=$1", [deviceId]);
      if (known) return finish(snapshot, parseReview(known.review));
      const review = mergeLegacyLedger(copy, await exportAll(local), deviceId);
      return finish(await saveLedger(snapshot, copy.export()), review);
    } finally { copy.close(); }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("409:")) fetchedAt = 0;
    throw error;
  }
}

function finish(snapshot: LoadedLedger, review: LedgerReview) {
  const id = snapshot.ledger_id!;
  try { localStorage.setItem(lastLedgerKey, id); } catch { /* The active session still uses the shared ledger. */ }
  return { id, revision: snapshot.revision, review };
}

export async function getSharedDb(): Promise<Db> {
  // Reads made by one business operation pin its revision until it commits.
  // Rebase a write only if the rows it depended on are identical.
  let pinned: LoadedLedger | undefined;
  let observations: { read: (db: Sqlite) => unknown; result: string }[] = [];
  const opened = generation;
  async function transact<T>(writable: boolean, action: (db: Sqlite) => T, rebased = false): Promise<T> {
    if (opened !== generation) throw new Error("The ledger session changed. Try again.");
    await requireOnlineAccess();
    const snapshot = pinned ??= await fetchLedger();
    if (!snapshot.bytes) throw new Error("The shared ledger could not be loaded.");
    const db = await openBrowserSqlite(snapshot.bytes);
    try {
      if (rebased && observations.some(({ read, result }) => JSON.stringify(read(db)) !== result)) {
        throw new Error("The records changed on another device. Refresh and try again.");
      }
      const before = db.changes();
      const result = action(db);
      if (!writable) observations.push({ read: action, result: JSON.stringify(result) });
      if (writable && db.changes() !== before) {
        try { await saveLedger(snapshot, db.export()); }
        catch (error) {
          fetchedAt = 0;
          if (!rebased && error instanceof Error && error.message.startsWith("409:")) {
            pinned = await fetchLedger(true);
            if (pinned.revision > snapshot.revision) return await transact(true, action, true);
          }
          window.dispatchEvent(new Event(LEDGER_REFRESH));
          throw error;
        }
      }
      if (writable) { pinned = undefined; observations = []; }
      return result;
    } finally { db.close(); }
  }
  return {
    select: (sql, params) => transact(false, db => db.select(sql, params)),
    readBatch: (statements) => transact(false, db => db.readBatch(statements)),
    execute: (sql, params) => transact(true, db => db.execute(sql, params)),
    batch: (statements) => transact(true, db => db.batch(statements)),
  };
}
