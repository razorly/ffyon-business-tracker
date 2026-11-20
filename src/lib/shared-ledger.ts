import { invoke } from "@tauri-apps/api/core";
import { isPwa, requireOnlineAccess } from "./access";
import { openBrowserSqlite } from "./browser-sqlite";
import { exportAll, getDeviceDb, type Db, type Statement } from "./db";
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

interface SharedNote { remote_id: string; notes: string | null }
interface SharedClientNote extends SharedNote { name: string }
interface SharedAppointmentNote extends SharedNote { date: string; start_time: string; time_confirmed: number; client_name: string | null }
type ReviewNoteSave = { table: "clients" | "appointments"; target: SharedNote; text: string; missingAppointmentId?: string | null };
const importReview = (deviceId: string): Statement => ({ sql: "SELECT review FROM ledger_imports WHERE device_id=$1", params: [deviceId] });

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
  if (active && active.id === snapshot.ledger_id && active.revision === snapshot.revision) return active;
  try {
    if (!snapshot.bytes) {
      const local = await getDeviceDb();
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
      const { sql, params } = importReview(deviceId);
      const [known] = copy.select<{ review: string }[]>(sql, params);
      if (known) {
        const review = active && known.review === JSON.stringify(active.review) ? active.review : parseReview(known.review);
        return finish(snapshot, review);
      }
      const review = mergeLegacyLedger(copy, await exportAll(await getDeviceDb()), deviceId);
      return finish(await saveLedger(snapshot, copy.export()), review);
    } finally { copy.close(); }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("409:")) fetchedAt = 0;
    throw error;
  }
}

export async function loadLedgerReview(deviceId: string) {
  const db = await getSharedDb();
  const [[stored], clients, appointments] = await db.readBatch<[{ review: string }[], SharedClientNote[], SharedAppointmentNote[]]>([
    importReview(deviceId),
    { sql: "SELECT remote_id, name, notes FROM clients WHERE remote_id IS NOT NULL" },
    { sql: `SELECT a.remote_id, a.date, a.start_time, a.time_confirmed, a.notes, c.name AS client_name
        FROM appointments a LEFT JOIN clients c ON c.id=a.client_id WHERE a.remote_id IS NOT NULL` },
  ]);
  return {
    review: stored ? parseReview(stored.review) : emptyReview(),
    clients: new Map(clients.map(row => [row.remote_id, row])),
    appointments: new Map(appointments.map(row => [row.remote_id, row])),
  };
}

export async function resolveLedgerReview(deviceId: string, kind: keyof LedgerReview, id: number, note?: ReviewNoteSave) {
  const db = await getSharedDb();
  const { sql, params } = importReview(deviceId);
  const [stored] = await db.select<{ review: string }[]>(sql, params);
  const review = stored ? parseReview(stored.review) : emptyReview();
  if (!review[kind].includes(id)) return review;

  const statements: Statement[] = [];
  if (note) {
    const { table, target, text, missingAppointmentId } = note;
    const [current] = await db.select<{ notes: string | null }[]>(`SELECT notes FROM ${table} WHERE remote_id=$1`, [target.remote_id]);
    if (!current || current.notes !== target.notes) throw new Error("The shared note changed. Refresh the review before saving.");
    if (missingAppointmentId) {
      const matches = await db.select<{ id: number }[]>("SELECT id FROM appointments WHERE remote_id=$1", [missingAppointmentId]);
      if (matches.length) throw new Error("The matching appointment is now available. Refresh the review to save the note there.");
    }
    if (target.notes !== text) statements.push({
      sql: `UPDATE ${table} SET notes=$1 WHERE remote_id=$2 AND notes IS $3`,
      params: [target.notes ? `${target.notes}\n\n${text}` : text, target.remote_id, target.notes], expectedRows: 1,
    });
  }
  review[kind] = review[kind].filter(rowId => rowId !== id);
  statements.push({ sql: "UPDATE ledger_imports SET review=$1 WHERE device_id=$2", params: [JSON.stringify(review), deviceId], expectedRows: 1 });
  await db.batch(statements);
  window.dispatchEvent(new Event(LEDGER_REFRESH));
  return review;
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
