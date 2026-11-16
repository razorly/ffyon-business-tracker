import type { openBrowserSqlite } from "./browser-sqlite";
import type { Appointment, Backup, Client, Db, Statement, Transaction } from "./db";

type Ledger = Awaited<ReturnType<typeof openBrowserSqlite>>;
const tables = ["categories", "clients", "transactions", "appointments", "cloud_services", "cloud_blocks", "cloud_settings", "sync_state"];

export interface LedgerReview {
  entries: number[];
  clients: number[];
  appointments: number[];
}

export function parseReview(value: string): LedgerReview {
  const result = JSON.parse(value) as LedgerReview;
  if (![result.entries, result.clients, result.appointments].every(list => Array.isArray(list) && list.every(Number.isSafeInteger))) {
    throw new Error("The ledger returned an invalid migration review.");
  }
  return result;
}

export const emptyReview = (): LedgerReview => ({ entries: [], clients: [], appointments: [] });
export const reviewCount = (review: LedgerReview) => review.entries.length + review.clients.length + review.appointments.length;

function insert(table: string, row: Record<string, unknown>): Statement {
  const columns = Object.keys(row);
  if (!columns.length || columns.some(column => !/^[a-z_]+$/.test(column))) throw new Error("An existing ledger column could not be imported.");
  return {
    sql: `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")})`,
    params: Object.values(row),
  };
}

const historyTables: Statement[] = [
  { sql: "CREATE TABLE IF NOT EXISTS ledger_imports (device_id TEXT PRIMARY KEY, review TEXT NOT NULL)" },
  { sql: "CREATE TABLE IF NOT EXISTS ledger_history (kind TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(kind, identity))" },
  ...["UPDATE", "DELETE"].map(event => ({
    sql: `CREATE TRIGGER IF NOT EXISTS ledger_transaction_${event} AFTER ${event} ON transactions
      BEGIN INSERT OR IGNORE INTO ledger_history VALUES ('entry',json_array(OLD.created_at,OLD.type,OLD.date,OLD.amount_pence)); END`,
  })),
  { sql: `CREATE TRIGGER IF NOT EXISTS ledger_payment_removed AFTER UPDATE OF transaction_id ON appointments
      WHEN OLD.remote_id IS NOT NULL AND OLD.transaction_id IS NOT NULL AND OLD.transaction_id IS NOT NEW.transaction_id
      BEGIN INSERT OR IGNORE INTO ledger_history VALUES ('payment',OLD.remote_id); END` },
  ...["UPDATE OF name", "DELETE"].map((event, index) => ({
    sql: `CREATE TRIGGER IF NOT EXISTS ledger_category_${index} AFTER ${event} ON categories
      BEGIN INSERT OR IGNORE INTO ledger_history VALUES ('category',json_array(OLD.type,lower(OLD.name))); END`,
  })),
  ...["clients", "appointments"].map(table => ({
    sql: `CREATE TRIGGER IF NOT EXISTS ledger_${table}_note_edit AFTER UPDATE OF notes ON ${table}
      WHEN OLD.remote_id IS NOT NULL AND OLD.notes IS NOT NEW.notes
      BEGIN INSERT OR IGNORE INTO ledger_history VALUES ('${table}',OLD.remote_id); END`,
  })),
];

export async function seedLedger(db: Ledger, source: Db, deviceId: string) {
  const rows = await source.readBatch<Record<string, unknown>[][]>(tables.map(table => ({ sql: `SELECT * FROM ${table}` })));
  db.batch([
    ...[...tables].reverse().map(table => ({ sql: `DELETE FROM ${table}` })),
    ...rows.flatMap((list, index) => list.map(row => insert(tables[index], row))),
    ...historyTables,
    { sql: "INSERT INTO ledger_imports VALUES ($1,$2)", params: [deviceId, JSON.stringify(emptyReview())] },
  ]);
}

export function hasLegacyActivity(backup: Backup) {
  return backup.transactions.length > 0 || backup.clients.some(row => row.notes || !row.remote_id) ||
    (backup.appointments ?? []).some(row => row.notes || !row.remote_id);
}

function byRemoteId<T extends { remote_id?: string | null }>(values: T[]) {
  return new Map(values.flatMap(row => row.remote_id ? [[row.remote_id, row] as const] : []));
}

function payments(appointments: Appointment[]) {
  return new Map(appointments.flatMap(appointment => appointment.transaction_id != null ? [[appointment.transaction_id, appointment] as const] : []));
}

const entryHistoryKey = (row: Transaction) => JSON.stringify([row.created_at, row.type, row.date, row.amount_pence]);
const possibleDuplicate = (row: Transaction) => JSON.stringify([row.type, row.date, row.amount_pence]);
function sameRecord(left: Transaction, right: Transaction) {
  return entryHistoryKey(left) === entryHistoryKey(right) && left.description === right.description &&
    left.service_id === right.service_id && left.service_name === right.service_name &&
    left.category_name_snapshot === right.category_name_snapshot && left.income_kind === right.income_kind;
}

export function mergeLegacyLedger(db: Ledger, source: Backup, deviceId: string): LedgerReview {
  const prior = db.select<{ review: string }[]>("SELECT review FROM ledger_imports WHERE device_id=$1", [deviceId])[0];
  if (prior) return parseReview(prior.review);
  const [categories, clients, appointments, transactions, history] =
    db.readBatch<[Backup["categories"], Client[], Appointment[], Transaction[], { kind: string; identity: string }[]]>([
      { sql: "SELECT * FROM categories ORDER BY id" }, { sql: "SELECT * FROM clients" }, { sql: "SELECT * FROM appointments" },
      { sql: "SELECT * FROM transactions" }, { sql: "SELECT * FROM ledger_history" },
    ]);
  const touched = new Set(history.map(item => `${item.kind}:${item.identity}`));
  const recordedTimes = new Set(transactions.map(row => row.created_at));
  for (const item of history) if (item.kind === "entry") recordedTimes.add(JSON.parse(item.identity)[0]);
  const liveClients = byRemoteId(clients);
  const localClients = new Map(source.clients.map(row => [row.id, row]));
  const liveAppointments = byRemoteId(appointments);
  const livePayments = payments(appointments);
  const localPayments = payments(source.appointments ?? []);
  const review = emptyReview();
  const statements: Statement[] = [];
  const candidates = new Map<string, Transaction[]>();
  for (const row of transactions) {
    const key = possibleDuplicate(row);
    const group = candidates.get(key) ?? [];
    group.push(row);
    candidates.set(key, group);
  }
  const matched = new Set<number>();
  const categoryKey = (row: Backup["categories"][number]) => JSON.stringify([row.type, row.name.toLowerCase(), row.service_id ?? null, row.income_kind]);
  const categoryIds = new Map(categories.map(row => [categoryKey(row), row.id]));
  const localCategories = new Map(source.categories.map(row => [row.id, row]));
  let nextCategory = db.select<{ seq: number }[]>("SELECT seq FROM sqlite_sequence WHERE name='categories'")[0]?.seq ?? 0;
  function categoryFor(id: number | null) {
    const original = id == null ? undefined : localCategories.get(id);
    if (!original) return null;
    const key = categoryKey(original);
    let target = categoryIds.get(key);
    if (target === undefined) {
      if (touched.has(`category:${JSON.stringify([original.type, original.name.toLowerCase()])}`)) return null;
      target = ++nextCategory;
      statements.push(insert("categories", { ...original, id: target }));
      categoryIds.set(key, target);
    }
    return target;
  }

  for (const row of source.transactions) {
    const localBooking = localPayments.get(row.id);
    const targetBooking = localBooking?.remote_id ? liveAppointments.get(localBooking.remote_id) : undefined;
    const sourceClient = row.client_id == null ? null : localClients.get(row.client_id)?.remote_id ?? null;
    const targetClient = sourceClient ? liveClients.get(sourceClient) : undefined;
    const similar = candidates.get(possibleDuplicate(row)) ?? [];
    const exact = similar.find(candidate => {
      const booked = livePayments.get(candidate.id);
      const sameBooking = localBooking ? Boolean(targetBooking && booked?.id === targetBooking.id) : !booked;
      return !matched.has(candidate.id) && sameBooking && (candidate.client_id ?? null) === (targetClient?.id ?? null) && sameRecord(candidate, row);
    });
    if (exact) { matched.add(exact.id); continue; }
    if (similar.length || recordedTimes.has(row.created_at) ||
        (localBooking && (!targetBooking || targetBooking.transaction_id != null || touched.has(`payment:${targetBooking.remote_id}`)))) {
      review.entries.push(row.id);
      continue;
    }
    // The archive keeps the original link when the current site no longer has that client.
    const { id: _id, ...entry } = row;
    statements.push(insert("transactions", {
      ...entry, category_id: categoryFor(row.category_id),
      client_id: targetClient?.id ?? null,
      description: sourceClient && !targetClient ? null : row.description,
    }));
    if (targetBooking) statements.push({
      sql: "UPDATE appointments SET transaction_id=last_insert_rowid() WHERE id=$1 AND transaction_id IS NULL",
      params: [targetBooking.id], expectedRows: 1,
    });
  }

  function notes(table: "clients" | "appointments", local: (Client | Appointment)[], online: Map<string, Client | Appointment>, issues: number[]) {
    for (const row of local) {
      if (!row.notes) continue;
      const existing = row.remote_id ? online.get(row.remote_id) : undefined;
      if (existing?.notes === row.notes) continue;
      if (!existing || existing.notes || touched.has(`${table}:${row.remote_id}`)) {
        issues.push(row.id);
        continue;
      }
      statements.push({ sql: `UPDATE ${table} SET notes=$1 WHERE id=$2`, params: [row.notes, existing.id], expectedRows: 1 });
    }
  }
  notes("clients", source.clients, liveClients, review.clients);
  notes("appointments", source.appointments ?? [], liveAppointments, review.appointments);
  statements.push({ sql: "INSERT INTO ledger_imports VALUES ($1,$2)", params: [deviceId, JSON.stringify(review)] });
  db.batch(statements);
  return review;
}
