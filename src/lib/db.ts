import { invoke } from "@tauri-apps/api/core";
import { isBrowserFixture, isDesktop, requireOnlineAccess } from "./access";

export type TxType = "income" | "expense";

export interface Category {
  id: number;
  name: string;
  type: TxType;
  colour: string;
  /** Usual price, in pence. Prefills the amount on a new entry only — saved entries keep their own amount. */
  default_pence: number | null;
  service_id: string | null;
}

export interface Client {
  id: number;
  name: string;
  phone: string | null;
  notes: string | null;
  created_at: string;
  remote_id: string | null;
  account_id: string | null;
  email: string;
  cloud_revision: number;
  disabled: number;
  saved_address: string;
  saved_postcode: string;
}

export interface ClientWithStats extends Client {
  total_pence: number;
  visits: number;
  last_visit: string | null;
}

export interface Transaction {
  id: number;
  type: TxType;
  date: string;
  amount_pence: number;
  category_id: number | null;
  client_id: number | null;
  description: string | null;
  created_at: string;
}

export interface TransactionRow extends Transaction {
  category_name: string | null;
  category_colour: string | null;
  client_name: string | null;
}

export type TransactionInput = Omit<Transaction, "id" | "created_at">;

/** The shared booking lifecycle. Local payment is represented by transaction_id. */
export type AppointmentStatus = "pending" | "confirmed" | "rejected" | "cancelled" | "no_show";

/** Statuses that are still expected to be paid for — what "still to collect" counts. */
export const isOwed = (a: Pick<Appointment, "status" | "transaction_id"> & Partial<Pick<Appointment, "price_pence">>) => a.status === "confirmed" && a.transaction_id == null && a.price_pence !== 0;
export const isPaid = (a: Pick<Appointment, "transaction_id">) => a.transaction_id != null;

export interface Appointment {
  id: number;
  date: string; // yyyy-MM-dd
  start_time: string; // HH:mm, 24-hour
  duration_min: number;
  client_id: number | null;
  category_id: number | null;
  /** What it's expected to cost. Becomes the amount of the entry when marked paid. */
  price_pence: number | null;
  notes: string | null;
  status: AppointmentStatus;
  /** The income entry this appointment created. Null until it's marked paid. */
  transaction_id: number | null;
  /** Shared by every occurrence of a repeating booking. Null for a one-off. */
  series_id: string | null;
  created_at: string;
  remote_id: string | null;
  service_id: string | null;
  service_name: string;
  customer_notes: string;
  cloud_revision: number;
  proposed_date: string | null;
  proposed_start_time: string | null;
  proposed_time_confirmed: number | null;
  time_confirmed: number;
  is_remote: number;
  visit_address: string;
  visit_postcode: string;
  base_price_pence: number | null;
  discount_percent: number;
}

export interface AppointmentRow extends Appointment {
  client_name: string | null;
  category_name: string | null;
  category_colour: string | null;
  account_email: string | null;
  paid_amount_pence: number | null;
}

export type AppointmentInput = Pick<Appointment, "date" | "start_time" | "duration_min" | "client_id" | "category_id" | "price_pence" | "notes"> &
  Partial<Pick<Appointment, "service_id" | "customer_notes" | "visit_address" | "visit_postcode" | "base_price_pence" | "discount_percent">> & {
    time_confirmed?: boolean | number;
    is_remote?: boolean | number;
    save_visit_address?: boolean;
  };

export interface Statement { sql: string; params?: unknown[] }
export interface DbResult { rowsAffected: number; lastInsertId?: number }

export interface Db {
  select<T>(sql: string, params?: unknown[]): Promise<T>;
  execute(sql: string, params?: unknown[]): Promise<DbResult>;
  batch(statements: Statement[]): Promise<DbResult[]>;
}

let dbPromise: Promise<Db> | null = null;

export const isTauri = isDesktop;

export function getDb(): Promise<Db> {
  if (!dbPromise) {
    if (import.meta.env.DEV && isBrowserFixture() && !isTauri()) {
      dbPromise = import("./devdb").then((m) => m.createDevDb());
    } else if (isTauri()) {
      dbPromise = Promise.resolve({
        select: <T>(sql: string, params: unknown[] = []) => invoke<T>("db_select", { sql, params }),
        execute: (sql: string, params: unknown[] = []) => invoke<DbResult>("db_execute", { sql, params }),
        batch: (statements: Statement[]) => invoke<DbResult[]>("db_batch", {
          statements: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })),
        }),
      });
    } else {
      return Promise.reject(new Error("Business data is available only in the paired desktop app."));
    }
  }
  return dbPromise;
}

// ---------- Categories ----------

export async function listCategories(type?: TxType): Promise<Category[]> {
  const db = await getDb();
  return type
    ? db.select<Category[]>("SELECT * FROM categories WHERE type = $1 ORDER BY id", [type])
    : db.select<Category[]>("SELECT * FROM categories ORDER BY type DESC, id");
}

export async function createCategory(c: Omit<Category, "id" | "service_id"> & { service_id?: string | null }) {
  const db = await getDb();
  await db.execute("INSERT INTO categories (name, type, colour, default_pence, service_id) VALUES ($1, $2, $3, $4, $5)", [
    c.name,
    c.type,
    c.colour,
    c.default_pence,
    c.service_id ?? null,
  ]);
}

export async function updateCategory(c: Category) {
  const db = await getDb();
  await db.execute("UPDATE categories SET name = $1, colour = $2, default_pence = $3, service_id = $4 WHERE id = $5", [
    c.name,
    c.colour,
    c.default_pence,
    c.service_id ?? null,
    c.id,
  ]);
}

export async function deleteCategory(id: number): Promise<DeletedSnapshot> {
  const db = await getDb();
  const [cat] = await db.select<Category[]>("SELECT * FROM categories WHERE id = $1", [id]);
  const links = await clearedLinks(db, "category_id", id);
  await db.batch([
    { sql: "UPDATE transactions SET category_id = NULL WHERE category_id = $1", params: [id] },
    { sql: "UPDATE appointments SET category_id = NULL WHERE category_id = $1", params: [id] },
    { sql: "DELETE FROM categories WHERE id = $1", params: [id] },
  ]);
  return snapshot(cat?.name ?? "Category", { categories: cat ? [cat] : [], links });
}

export async function categoryUsage(id: number): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM transactions WHERE category_id = $1",
    [id],
  );
  return rows[0]?.n ?? 0;
}

// ---------- Clients ----------

export async function listClients(): Promise<ClientWithStats[]> {
  const db = await getDb();
  return db.select<ClientWithStats[]>(`
    SELECT c.*,
      COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_pence END), 0) AS total_pence,
      COUNT(CASE WHEN t.type = 'income' THEN 1 END) AS visits,
      MAX(t.date) AS last_visit
    FROM clients c
    LEFT JOIN transactions t ON t.client_id = c.id
    GROUP BY c.id
    ORDER BY c.name COLLATE NOCASE
  `);
}

export async function createClient(c: { name: string; email?: string; phone?: string | null; notes?: string | null; saved_address?: string; saved_postcode?: string }) {
  const db = await getDb();
  const remoteId = crypto.randomUUID();
  const committed = await sharedMutation("clients", "POST", { id: remoteId, name: c.name.trim(), email: c.email ?? "", phone: c.phone ?? "", saved_address: c.saved_address ?? "", saved_postcode: c.saved_postcode ?? "" });
  const [client] = await db.select<Client[]>("SELECT * FROM clients WHERE remote_id = $1", [committed.id]);
  if (!client) throw new Error("Client saved online. Refresh the site connection before continuing.");
  if (c.notes) await db.execute("UPDATE clients SET notes = $1 WHERE id = $2", [c.notes, client.id]);
  return client.id;
}

export async function updateClient(c: Pick<Client, "id" | "name" | "phone" | "notes"> & Partial<Pick<Client, "email" | "disabled" | "cloud_revision" | "saved_address" | "saved_postcode">>) {
  const db = await getDb();
  const [before] = await db.select<Client[]>("SELECT * FROM clients WHERE id = $1", [c.id]);
  if (!before) throw new Error("Client not found");
  if (before.remote_id && (c.name.trim() !== before.name || (c.phone ?? "") !== (before.phone ?? "") || (c.email != null && c.email !== before.email) || (c.disabled != null && c.disabled !== before.disabled) || (c.saved_address !== undefined && c.saved_address !== before.saved_address) || (c.saved_postcode !== undefined && c.saved_postcode !== before.saved_postcode))) {
    await sharedMutation("clients", "PATCH", {
      id: before.remote_id, revision: c.cloud_revision ?? before.cloud_revision, name: c.name.trim(),
      email: c.email ?? before.email, phone: c.phone ?? "", disabled: Boolean(c.disabled ?? before.disabled),
      saved_address: c.saved_address ?? before.saved_address ?? "", saved_postcode: c.saved_postcode ?? before.saved_postcode ?? "",
    });
  }
  await db.execute(
    before.remote_id ? "UPDATE clients SET notes = $1 WHERE id = $2" : "UPDATE clients SET notes = $1, name = $3, phone = $4, email = $5, saved_address=$6, saved_postcode=$7 WHERE id = $2",
    before.remote_id ? [c.notes || null, c.id] : [c.notes || null, c.id, c.name.trim(), c.phone || null, c.email ?? before.email, c.saved_address ?? before.saved_address ?? "", c.saved_postcode ?? before.saved_postcode ?? ""],
  );
}

export async function deleteClient(id: number): Promise<DeletedSnapshot> {
  const db = await getDb();
  await resolveUnfinishedImport(db, [id], []);
  const [client] = await db.select<Client[]>("SELECT * FROM clients WHERE id = $1", [id]);
  if (client?.remote_id) {
    await sharedMutation("clients", "DELETE", { id: client.remote_id, revision: client.cloud_revision });
    return snapshot("Customer", { undoable: false, message: "Customer and bookings deleted. Recorded payments retained without customer details." });
  }
  await db.batch([
    { sql: "UPDATE transactions SET client_id=NULL, description = NULL WHERE id IN (SELECT transaction_id FROM appointments WHERE client_id=$1)", params: [id] },
    { sql: "UPDATE transactions SET client_id = NULL, description = NULL WHERE client_id = $1", params: [id] },
    { sql: "DELETE FROM appointments WHERE client_id = $1", params: [id] },
    { sql: "DELETE FROM clients WHERE id = $1", params: [id] },
  ]);
  return snapshot("Customer", { undoable: false, message: "Customer and bookings deleted. Recorded payments retained without customer details." });
}

// ---------- Transactions ----------

const TX_SELECT = `
  SELECT t.*, cat.name AS category_name, cat.colour AS category_colour, cl.name AS client_name
  FROM transactions t
  LEFT JOIN categories cat ON cat.id = t.category_id
  LEFT JOIN clients cl ON cl.id = t.client_id
`;

export async function listTransactions(opts: {
  from?: string;
  to?: string;
  clientId?: number;
  limit?: number;
} = {}): Promise<TransactionRow[]> {
  const db = await getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.from) {
    params.push(opts.from);
    where.push(`t.date >= $${params.length}`);
  }
  if (opts.to) {
    params.push(opts.to);
    where.push(`t.date <= $${params.length}`);
  }
  if (opts.clientId != null) {
    params.push(opts.clientId);
    where.push(`t.client_id = $${params.length}`);
  }
  let sql = TX_SELECT;
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += " ORDER BY t.date DESC, t.id DESC";
  if (opts.limit) sql += ` LIMIT ${Math.floor(opts.limit)}`;
  return db.select<TransactionRow[]>(sql, params);
}

export async function getTransaction(id: number): Promise<TransactionRow | null> {
  const db = await getDb();
  const rows = await db.select<TransactionRow[]>(`${TX_SELECT} WHERE t.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function createTransaction(t: TransactionInput) {
  const db = await getDb();
  const res = await db.execute(
    `INSERT INTO transactions (type, date, amount_pence, category_id, client_id, description)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [t.type, t.date, t.amount_pence, t.category_id, t.client_id, t.description || null],
  );
  return res.lastInsertId as number;
}

export async function updateTransaction(id: number, t: TransactionInput) {
  const db = await getDb();
  if (t.type !== "income") {
    const linked = await db.select<{ id: number }[]>("SELECT id FROM appointments WHERE transaction_id=$1", [id]);
    if (linked.length) throw new Error("A recorded appointment payment must remain an income entry. Mark it unpaid before changing its type.");
  }
  await db.execute(
    `UPDATE transactions SET type = $1, date = $2, amount_pence = $3, category_id = $4,
       client_id = $5, description = $6 WHERE id = $7`,
    [t.type, t.date, t.amount_pence, t.category_id, t.client_id, t.description || null, id],
  );
}

export async function deleteTransaction(id: number): Promise<DeletedSnapshot> {
  const db = await getDb();
  const [tx] = await db.select<Transaction[]>("SELECT * FROM transactions WHERE id = $1", [id]);
  // An appointment whose entry has been deleted goes back to unpaid, so the
  // money it was worth leaves the totals with it.
  const wasPaying = await db.select<{ id: number; status: AppointmentStatus }[]>(
    "SELECT id, status FROM appointments WHERE transaction_id = $1",
    [id],
  );
  await db.batch([
    { sql: "UPDATE appointments SET transaction_id = NULL WHERE transaction_id = $1", params: [id] },
    { sql: "DELETE FROM transactions WHERE id = $1", params: [id] },
  ]);
  return snapshot("Entry", {
    transactions: tx ? [tx] : [],
    unpaid: wasPaying.map((a) => ({ id: a.id, status: a.status, transaction_id: id })),
  });
}

// ---------- Appointments ----------

/**
 * Appointments are the diary, not the money. Booking one writes nothing to
 * `transactions`, so an unpaid or upcoming appointment never appears in any
 * total, chart or export. Marking one paid is what creates its income entry.
 */

const APPT_SELECT = `
  SELECT a.*, cl.name AS client_name, cl.email AS account_email,
    COALESCE(NULLIF(a.service_name, ''), cat.name) AS category_name, cat.colour AS category_colour,
    paid.amount_pence AS paid_amount_pence
  FROM appointments a
  LEFT JOIN clients cl ON cl.id = a.client_id
  LEFT JOIN categories cat ON cat.id = a.category_id
  LEFT JOIN transactions paid ON paid.id = a.transaction_id
`;

export async function listAppointments(opts: { from?: string; to?: string; clientId?: number } = {}) {
  const db = await getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.from) {
    params.push(opts.from);
    where.push(`a.date >= $${params.length}`);
  }
  if (opts.to) {
    params.push(opts.to);
    where.push(`a.date <= $${params.length}`);
  }
  if (opts.clientId != null) {
    params.push(opts.clientId);
    where.push(`a.client_id = $${params.length}`);
  }
  let sql = APPT_SELECT;
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += " ORDER BY a.date, a.time_confirmed, a.start_time, a.id";
  return db.select<AppointmentRow[]>(sql, params);
}

export async function getAppointment(id: number): Promise<AppointmentRow | null> {
  const db = await getDb();
  const rows = await db.select<AppointmentRow[]>(`${APPT_SELECT} WHERE a.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function createAppointment(a: AppointmentInput, seriesId: string | null = null) {
  const db = await getDb();
  const remoteId = crypto.randomUUID();
  const input = await cloudAppointmentInput(a);
  const committed = await sharedMutation("appointments", "POST", { id: remoteId, ...input, status: "confirmed", series_id: seriesId });
  const [row] = await db.select<Appointment[]>("SELECT * FROM appointments WHERE remote_id = $1", [committed.id]);
  if (!row) throw new Error("Appointment saved online. Refresh the site connection before continuing.");
  await db.execute("UPDATE appointments SET notes = $1, category_id = $2 WHERE id = $3", [a.notes || null, a.category_id, row.id]);
  return row.id;
}

/** Books the same appointment on each date, tied together so the run can be managed as one. */
export async function createAppointmentSeries(a: AppointmentInput, dates: string[]) {
  const seriesId = crypto.randomUUID();
  const input = await cloudAppointmentInput(a);
  const committed = await sharedMutation("appointments/series", "POST", { id: crypto.randomUUID(), ...input, status: "confirmed", dates, series_id: seriesId });
  const db = await getDb();
  const rows = await db.select<{ id: number }[]>("SELECT id FROM appointments WHERE series_id = $1 ORDER BY date, start_time", [committed.series_id]);
  await db.execute("UPDATE appointments SET notes = $1, category_id = $2 WHERE series_id = $3", [a.notes || null, a.category_id, committed.series_id]);
  return rows.map((row) => row.id);
}

/** How many of a repeating booking are still to come from `fromDate` on. */
export async function seriesRemaining(seriesId: string, fromDate: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM appointments WHERE series_id = $1 AND date >= $2",
    [seriesId, fromDate],
  );
  return rows[0]?.n ?? 0;
}

/** Deletes diary records while retaining the payments already received. */
export async function deleteAppointmentSeries(seriesId: string, fromDate: string): Promise<DeletedSnapshot> {
  const db = await getDb();
  const before = await db.select<Appointment[]>("SELECT * FROM appointments WHERE series_id=$1 AND date >= $2", [seriesId, fromDate]);
  await resolveUnfinishedImport(db, [], before.map((appointment) => appointment.id));
  const rows = await db.select<Appointment[]>(
    "SELECT * FROM appointments WHERE series_id = $1 AND date >= $2",
    [seriesId, fromDate],
  );
  for (const row of rows) if (row.remote_id) await sharedMutation("appointments", "DELETE", { id: row.remote_id, revision: row.cloud_revision });
  await db.batch([
    { sql: "UPDATE transactions SET client_id=NULL, description=NULL WHERE id IN (SELECT transaction_id FROM appointments WHERE series_id=$1 AND date >= $2 AND remote_id IS NULL)", params: [seriesId, fromDate] },
    { sql: "DELETE FROM appointments WHERE series_id=$1 AND date >= $2 AND remote_id IS NULL", params: [seriesId, fromDate] },
  ]);
  return snapshot(`${rows.length} appointment${rows.length === 1 ? "" : "s"}`, {
    undoable: false,
    message: "Appointments deleted. Recorded payments retained.",
  });
}

/** Shared booking edits never rewrite money already recorded. */
export async function updateAppointment(id: number, a: AppointmentInput, expectedRevision?: number) {
  const db = await getDb();
  const before = await getAppointment(id);
  if (!before) throw new Error("Appointment not found");
  const details = bookingDetails(a, before);
  const beforeDetails = bookingDetails(before);
  const detailsChanged = Object.entries(details).some(([field, value]) => value !== beforeDetails[field as keyof typeof beforeDetails]);
  const changed = a.date !== before.date || a.start_time !== before.start_time || a.duration_min !== before.duration_min || a.client_id !== before.client_id || a.price_pence !== before.price_pence || (a.service_id !== undefined && a.service_id !== before.service_id) || (a.customer_notes !== undefined && a.customer_notes !== before.customer_notes) || detailsChanged || a.save_visit_address === true;
  if (before.remote_id && changed) {
    const patch: Record<string, unknown> = { id: before.remote_id, revision: expectedRevision ?? before.cloud_revision, action: "edit" };
    for (const field of ["date", "duration_min", "price_pence"] as const) if (a[field] !== before[field]) patch[field] = a[field];
    if (a.start_time !== before.start_time || details.time_confirmed !== beforeDetails.time_confirmed) patch.start_time = details.time_confirmed ? a.start_time : "00:00";
    for (const [field, value] of Object.entries(details)) if (value !== beforeDetails[field as keyof typeof beforeDetails]) patch[field] = value;
    if (a.save_visit_address) patch.save_visit_address = true;
    if (a.service_id !== undefined && a.service_id !== before.service_id) patch.service_id = a.service_id;
    if (a.customer_notes !== undefined && a.customer_notes !== before.customer_notes) patch.notes = a.customer_notes ?? "";
    if (a.client_id !== before.client_id) {
      const [client] = a.client_id == null ? [] : await db.select<Client[]>("SELECT * FROM clients WHERE id=$1", [a.client_id]);
      if (!client?.remote_id) throw new Error("Choose an explicitly linked shared customer.");
      patch.client_id = client.remote_id;
    }
    await sharedMutation("appointments", "PATCH", patch);
  } else if (!before.remote_id && changed) {
    await db.execute(`UPDATE appointments SET date=$1, start_time=$2, duration_min=$3, client_id=$4, price_pence=$5,
      service_id=$6, customer_notes=$7, time_confirmed=$8, is_remote=$9, visit_address=$10, visit_postcode=$11,
      base_price_pence=$12, discount_percent=$13 WHERE id=$14`, [a.date, details.time_confirmed ? a.start_time : "00:00", a.duration_min, a.client_id,
      a.price_pence, a.service_id ?? before.service_id, a.customer_notes ?? before.customer_notes ?? "", details.time_confirmed ? 1 : 0,
      details.is_remote ? 1 : 0, details.visit_address, details.visit_postcode, details.base_price_pence, details.discount_percent, id]);
    if (a.save_visit_address && details.is_remote && a.client_id != null) {
      const [client] = await db.select<Client[]>("SELECT * FROM clients WHERE id=$1", [a.client_id]);
      if (client) await updateClient({ ...client, saved_address: details.visit_address, saved_postcode: details.visit_postcode });
    }
  }
  await db.execute("UPDATE appointments SET notes = $1, category_id = $2 WHERE id = $3", [a.notes || null, a.category_id, id]);
}

/** Permanent deletion removes booking details, never the money received. */
export async function deleteAppointment(id: number): Promise<DeletedSnapshot> {
  const db = await getDb();
  await resolveUnfinishedImport(db, [], [id]);
  const [appt] = await db.select<Appointment[]>("SELECT * FROM appointments WHERE id = $1", [id]);
  if (appt?.remote_id) {
    await sharedMutation("appointments", "DELETE", { id: appt.remote_id, revision: appt.cloud_revision });
    return snapshot("Appointment", { undoable: false, message: "Appointment deleted. Recorded payments retained." });
  }
  await db.batch([
    { sql: "UPDATE transactions SET client_id=NULL, description=NULL WHERE id=(SELECT transaction_id FROM appointments WHERE id=$1)", params: [id] },
    { sql: "DELETE FROM appointments WHERE id = $1", params: [id] },
  ]);
  return snapshot("Appointment", { undoable: false, message: "Appointment deleted. Recorded payments retained." });
}

async function resolveUnfinishedImport(db: Db, clientIds: number[], appointmentIds: number[]) {
  const rows = await db.select<{ key: string; value: string }[]>("SELECT key,value FROM sync_state WHERE key='import-pending' OR key LIKE 'import-target-%'");
  const mappings = rows.filter((row) => row.key.startsWith("import-target-client-") ? clientIds.includes(Number(row.value)) : row.key.startsWith("import-target-appointment-") && appointmentIds.includes(Number(row.value)));
  const saved = rows.find((row) => row.key === "import-pending");
  let selection: import("./sync").ImportSelection | null = null;
  if (saved) {
    try {
      selection = (JSON.parse(saved.value) as { selection: import("./sync").ImportSelection }).selection;
      if (!selection || !Array.isArray(selection.clientIds) || !Array.isArray(selection.appointmentIds)) throw new Error("Invalid import selection");
    }
    catch { throw new Error("Resolve the reviewed import in site connection settings before deleting this record."); }
  }
  const selected = selection && (selection.clientIds.some((id) => clientIds.includes(id)) || selection.appointmentIds.some((id) => appointmentIds.includes(id)));
  if (!selected && !mappings.length) return;
  try {
    await requireOnlineAccess();
    const sync = await import("./sync");
    if (saved && selection) {
      await sync.importLegacyRecords(selection);
    } else {
      const response = await sync.adminRequest<import("./sync").SyncResponse>("sync", "GET");
      if (!response.snapshot || response.has_more || response.changes.length) throw new Error("A complete site snapshot is required.");
      await sync.applySyncResponse(response);
      const remoteIds = new Set([...response.snapshot.clients, ...response.snapshot.appointments].map((row) => row.id));
      const obsolete = mappings.filter((row) => !remoteIds.has(row.key.replace(/^import-target-(client|appointment)-/, "")));
      if (obsolete.length) await db.batch(obsolete.map((row) => ({ sql: "DELETE FROM sync_state WHERE key=$1", params: [row.key] })));
    }
  } catch {
    throw new Error("Reconnect and retry the reviewed import before permanently deleting this record. Nothing was deleted.");
  }
}

async function linkedTransactionId(id: number): Promise<number | null> {
  const db = await getDb();
  const rows = await db.select<{ transaction_id: number | null }[]>(
    "SELECT transaction_id FROM appointments WHERE id = $1",
    [id],
  );
  return rows[0]?.transaction_id ?? null;
}

/** The money moment: the appointment gets an income entry and starts counting. */
export async function markAppointmentPaid(id: number, amountPence?: number) {
  const db = await getDb();
  const a = await getAppointment(id);
  if (!a) throw new Error("Appointment not found");
  if (a.transaction_id != null) return; // already paid — never create a second entry
  if (a.status !== "confirmed") throw new Error("Only a confirmed appointment can be marked paid.");
  const amount = amountPence ?? a.price_pence;
  if (amount == null || !Number.isSafeInteger(amount) || amount <= 0) throw new Error("Add the amount received before marking this paid");
  await db.batch([
    { sql: `INSERT INTO transactions (type, date, amount_pence, category_id, client_id, description)
      SELECT 'income', date, $1, category_id, client_id, notes FROM appointments
      WHERE id = $2 AND transaction_id IS NULL AND status = 'confirmed'`, params: [amount, id] },
    { sql: "UPDATE appointments SET transaction_id = last_insert_rowid() WHERE id = $1 AND transaction_id IS NULL AND changes() > 0", params: [id] },
  ]);
}

/** Lifecycle changes preserve local payments. */
export async function setAppointmentStatus(id: number, status: AppointmentStatus, expectedRevision?: number) {
  const db = await getDb();
  const a = await getAppointment(id);
  if (!a) throw new Error("Appointment not found");
  if (a.remote_id) {
    const action = status === "confirmed" ? (a.status === "pending" ? "accept" : "restore") : status === "rejected" ? "reject" : status === "cancelled" ? "cancel" : status === "no_show" ? "no_show" : null;
    if (!action) throw new Error("A confirmed booking cannot be changed back into a request.");
    await sharedMutation("appointments", "PATCH", { id: a.remote_id, revision: expectedRevision ?? a.cloud_revision, action });
  } else {
    await db.execute("UPDATE appointments SET status = $1 WHERE id = $2", [status, id]);
  }
}

/** Undoes a payment: the income entry is removed, so the money leaves the totals again. */
export async function markAppointmentUnpaid(id: number) {
  const db = await getDb();
  const txId = await linkedTransactionId(id);
  if (txId == null) return;
  await db.batch([
    { sql: "UPDATE appointments SET transaction_id = NULL WHERE id = $1", params: [id] },
    { sql: "DELETE FROM transactions WHERE id = $1", params: [txId] },
  ]);
}

/** Past appointments still waiting to be marked paid — money she hasn't collected. */
export async function unpaidBefore(date: string): Promise<AppointmentRow[]> {
  const db = await getDb();
  return db.select<AppointmentRow[]>(
    `${APPT_SELECT} WHERE a.status = 'confirmed' AND a.transaction_id IS NULL AND (a.price_pence IS NULL OR a.price_pence>0) AND a.date < $1 ORDER BY a.date, a.time_confirmed, a.start_time`,
    [date],
  );
}

/** A client's appointments from `from` onwards, cancellations aside. */
export async function upcomingForClient(clientId: number, from: string): Promise<AppointmentRow[]> {
  const db = await getDb();
  return db.select<AppointmentRow[]>(
    `${APPT_SELECT} WHERE a.client_id = $1 AND a.date >= $2 AND a.status IN ('pending', 'confirmed')
     ORDER BY a.date, a.start_time`,
    [clientId, from],
  );
}

async function sharedMutation(operation: string, method: string, body: Record<string, unknown>) {
  await requireOnlineAccess();
  const sync = await import("./sync");
  return sync.mutateAndSync(operation, method, body);
}

async function cloudAppointmentInput(a: AppointmentInput) {
  const db = await getDb();
  const [client] = a.client_id == null ? [] : await db.select<Client[]>("SELECT * FROM clients WHERE id = $1", [a.client_id]);
  if (!client?.remote_id) throw new Error("Choose a shared customer, or review and import this legacy client first.");
  const [category] = a.category_id == null ? [] : await db.select<Category[]>("SELECT * FROM categories WHERE id = $1", [a.category_id]);
  const serviceId = a.service_id === undefined ? category?.service_id : a.service_id;
  if (!serviceId) throw new Error("Choose a website service for this booking.");
  if (a.price_pence == null || !Number.isSafeInteger(a.price_pence) || a.price_pence < 0) throw new Error("Enter the agreed booking price.");
  const details = bookingDetails(a);
  return { client_id: client.remote_id, service_id: serviceId, date: a.date, start_time: details.time_confirmed ? a.start_time : "00:00", duration_min: a.duration_min, price_pence: a.price_pence, notes: a.customer_notes ?? "", ...details, save_visit_address: a.save_visit_address === true };
}

function bookingDetails(a: AppointmentInput, before?: Appointment) {
  const flag = (value: boolean | number | undefined, fallback: boolean) => {
    if (value === undefined) return fallback;
    if (value !== true && value !== false && value !== 0 && value !== 1) throw new Error("Invalid booking option.");
    return Boolean(value);
  };
  const time_confirmed = flag(a.time_confirmed, before?.time_confirmed !== 0);
  const is_remote = flag(a.is_remote, Boolean(before?.is_remote));
  const visit_address = is_remote ? (a.visit_address ?? before?.visit_address ?? "").trim() : "";
  const visit_postcode = is_remote ? (a.visit_postcode ?? before?.visit_postcode ?? "").trim().toUpperCase().replace(/\s+/g, " ") : "";
  if (is_remote && (!visit_address || !visit_postcode)) throw new Error("A travelling appointment needs an address and postcode.");
  if (visit_address.length > 500 || visit_postcode.length > 20) throw new Error("The visit address or postcode is too long.");
  const base_price_pence = a.base_price_pence === undefined ? before?.base_price_pence ?? a.price_pence : a.base_price_pence;
  const discount_percent = a.discount_percent ?? before?.discount_percent ?? 0;
  if (base_price_pence != null && (!Number.isSafeInteger(base_price_pence) || base_price_pence < 0)) throw new Error("Invalid undiscounted booking price.");
  if (!Number.isSafeInteger(discount_percent) || discount_percent < 0 || discount_percent > 100) throw new Error("Discount must be a whole percentage from 0 to 100.");
  return { time_confirmed, is_remote, visit_address, visit_postcode, base_price_pence, discount_percent };
}

// ---------- Aggregates ----------

export interface MonthTotal {
  month: string; // yyyy-MM
  income: number;
  expense: number;
}

export async function monthlyTotals(from: string, to: string): Promise<MonthTotal[]> {
  const db = await getDb();
  return db.select<MonthTotal[]>(
    `SELECT strftime('%Y-%m', date) AS month,
       COALESCE(SUM(CASE WHEN type = 'income' THEN amount_pence END), 0) AS income,
       COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_pence END), 0) AS expense
     FROM transactions WHERE date >= $1 AND date <= $2
     GROUP BY month ORDER BY month`,
    [from, to],
  );
}

export interface DayTotal {
  date: string;
  income: number;
  expense: number;
}

export async function dailyTotals(from: string, to: string): Promise<DayTotal[]> {
  const db = await getDb();
  return db.select<DayTotal[]>(
    `SELECT date,
       COALESCE(SUM(CASE WHEN type = 'income' THEN amount_pence END), 0) AS income,
       COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_pence END), 0) AS expense
     FROM transactions WHERE date >= $1 AND date <= $2
     GROUP BY date ORDER BY date`,
    [from, to],
  );
}

export interface CategoryTotal {
  id: number | null;
  name: string;
  colour: string;
  total: number;
}

export async function categoryTotals(type: TxType, from: string, to: string): Promise<CategoryTotal[]> {
  const db = await getDb();
  return db.select<CategoryTotal[]>(
    `SELECT cat.id AS id, COALESCE(cat.name, 'Uncategorised') AS name,
       COALESCE(cat.colour, '#a88a7d') AS colour, SUM(t.amount_pence) AS total
     FROM transactions t LEFT JOIN categories cat ON cat.id = t.category_id
     WHERE t.type = $1 AND t.date >= $2 AND t.date <= $3
     GROUP BY cat.id ORDER BY total DESC`,
    [type, from, to],
  );
}

export async function distinctClients(from: string, to: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>(
    `SELECT COUNT(DISTINCT client_id) AS n FROM transactions
     WHERE type = 'income' AND client_id IS NOT NULL AND date >= $1 AND date <= $2`,
    [from, to],
  );
  return rows[0]?.n ?? 0;
}

// ---------- Undo ----------

/**
 * Everything a delete took away, so it can be put straight back. Deleted rows
 * keep their original ids — the tables are AUTOINCREMENT, so an id is never
 * handed out twice and re-inserting one can't collide with anything newer.
 */
export interface DeletedSnapshot {
  /** What went, for the message on screen: "Entry", "Sarah Jones", "3 appointments". */
  label: string;
  categories: Category[];
  clients: Client[];
  transactions: Transaction[];
  appointments: Appointment[];
  /** A client_id or category_id cleared on a row that survived the delete. */
  links: { table: "transactions" | "appointments"; column: "client_id" | "category_id"; id: number; value: number }[];
  /** An appointment knocked back to unpaid because the entry it created went. */
  unpaid: { id: number; status: AppointmentStatus; transaction_id: number }[];
  undoable?: boolean;
  message?: string;
}

function snapshot(label: string, parts: Partial<DeletedSnapshot> = {}): DeletedSnapshot {
  return {
    label,
    categories: [],
    clients: [],
    transactions: [],
    appointments: [],
    links: [],
    unpaid: [],
    ...parts,
  };
}

/** The rows about to have `column` cleared, noted down so the link can be put back. */
async function clearedLinks(db: Db, column: "client_id" | "category_id", value: number) {
  const links: DeletedSnapshot["links"] = [];
  // Both names come from this file's own literals, never from anything typed in.
  for (const table of ["transactions", "appointments"] as const) {
    const rows = await db.select<{ id: number }[]>(`SELECT id FROM ${table} WHERE ${column} = $1`, [value]);
    for (const r of rows) links.push({ table, column, id: r.id, value });
  }
  return links;
}

/** Puts back exactly what a delete took away. Parents first, so the links land on rows that exist. */
export async function undoDelete(s: DeletedSnapshot) {
  if (s.undoable === false) throw new Error("Shared decisions can only be restored with an online, conflict-checked action.");
  const db = await getDb();
  const statements: Statement[] = [
    ...s.categories.map(categoryStatement), ...s.clients.filter((c) => !c.remote_id).map(clientStatement),
    ...s.transactions.map(transactionStatement), ...s.appointments.filter((a) => !a.remote_id).map(appointmentStatement),
  ];
  for (const l of s.links) {
    statements.push({ sql: `UPDATE ${l.table} SET ${l.column} = $1 WHERE id = $2`, params: [l.value, l.id] });
  }
  for (const u of s.unpaid) {
    statements.push({ sql: "UPDATE appointments SET transaction_id = $1 WHERE id = $2", params: [u.transaction_id, u.id] });
  }
  await db.batch(statements);
}

// Row-for-row inserts, keeping the id. Used by undo and by restoring a backup.

function categoryStatement(c: Category): Statement {
  return { sql: "INSERT INTO categories (id, name, type, colour, default_pence, service_id) VALUES ($1, $2, $3, $4, $5, $6)", params: [
    c.id,
    c.name,
    c.type,
    c.colour,
    c.default_pence ?? null,
    c.service_id ?? null,
  ] };
}

function clientStatement(c: Client): Statement {
  return { sql: "INSERT INTO clients (id, name, phone, notes, created_at, remote_id, account_id, email, cloud_revision, disabled, saved_address, saved_postcode) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)", params: [
    c.id,
    c.name,
    c.phone,
    c.notes,
    c.created_at,
    c.remote_id ?? null, c.account_id ?? null, c.email ?? "", c.cloud_revision ?? 0, c.disabled ?? 0,
    c.saved_address ?? "", c.saved_postcode ?? "",
  ] };
}

function transactionStatement(t: Transaction): Statement {
  return { sql: `INSERT INTO transactions (id, type, date, amount_pence, category_id, client_id, description, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    params: [t.id, t.type, t.date, t.amount_pence, t.category_id, t.client_id, t.description, t.created_at] };
}

function appointmentStatement(a: Appointment): Statement {
  return { sql: `INSERT INTO appointments (id, date, start_time, duration_min, client_id, category_id, price_pence,
       notes, status, transaction_id, series_id, created_at, remote_id, service_id, service_name, customer_notes,
       cloud_revision, proposed_date, proposed_start_time, time_confirmed, proposed_time_confirmed, is_remote,
       visit_address, visit_postcode, base_price_pence, discount_percent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
    params: [
      a.id,
      a.date,
      a.time_confirmed === 0 ? "00:00" : a.start_time,
      a.duration_min,
      a.client_id,
      a.category_id,
      a.price_pence,
      a.notes,
      a.status,
      a.transaction_id,
      a.series_id ?? null,
      a.created_at,
      a.remote_id ?? null, a.service_id ?? null, a.service_name ?? "", a.customer_notes ?? "",
      a.cloud_revision ?? 0, a.proposed_date ?? null, a.proposed_start_time ?? null,
      a.time_confirmed ?? 1, a.proposed_time_confirmed ?? null, a.is_remote ?? 0,
      a.is_remote ? a.visit_address ?? "" : "", a.is_remote ? a.visit_postcode ?? "" : "",
      a.base_price_pence ?? a.price_pence, a.discount_percent ?? 0,
    ] };
}

// ---------- Backup / restore ----------

export interface Backup {
  app: "ffyon-business-tracker";
  /** 1 = before the schedule existed, so it carries no appointments. */
  version: number;
  exported_at: string;
  categories: Category[];
  clients: Client[];
  transactions: Transaction[];
  appointments?: Appointment[];
}

export async function exportAll(): Promise<Backup> {
  const db = await getDb();
  const [categories, clients, transactions, appointments] = await Promise.all([
    db.select<Category[]>("SELECT * FROM categories ORDER BY id"),
    db.select<Client[]>("SELECT * FROM clients ORDER BY id"),
    db.select<Transaction[]>("SELECT * FROM transactions ORDER BY id"),
    db.select<Appointment[]>("SELECT * FROM appointments ORDER BY id"),
  ]);
  return {
    app: "ffyon-business-tracker",
    version: 3,
    exported_at: new Date().toISOString(),
    categories,
    clients,
    transactions,
    appointments,
  };
}

export function validateBackup(data: unknown): data is Backup {
  try { normalizeBackup(data); return true; } catch { return false; }
}

export function normalizeBackup(data: unknown): Backup {
  const b = data as Backup;
  if (!b || b.app !== "ffyon-business-tracker" || ![1, 2, 3].includes(b.version) || !Array.isArray(b.categories) || !Array.isArray(b.clients) || !Array.isArray(b.transactions) || (b.appointments !== undefined && !Array.isArray(b.appointments))) throw new Error("That file isn't a supported Ffyon backup.");
  const positiveId = (n: unknown) => Number.isSafeInteger(n) && Number(n) > 0;
  const nullableId = (n: unknown) => n === null || positiveId(n);
  const str = (v: unknown) => typeof v === "string";
  const optionalText = (v: unknown) => v == null || str(v);
  const pence = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
  const flag = (v: unknown) => v === undefined || v === true || v === false || v === 0 || v === 1;
  const unique = (rows: { id: number }[]) => new Set(rows.map((r) => r.id)).size === rows.length;
  const categories = b.categories.map((c) => {
    if (!positiveId(c.id) || !str(c.name) || !["income", "expense"].includes(c.type) || !str(c.colour) || (c.default_pence != null && !pence(c.default_pence)) || !optionalText(c.service_id)) throw new Error("Invalid category in backup.");
    return { id: c.id, name: c.name, type: c.type, colour: c.colour, default_pence: c.default_pence ?? null, service_id: c.type === "income" ? c.service_id ?? null : null };
  });
  const clients = b.clients.map((c) => {
    if (!positiveId(c.id) || !str(c.name) || !optionalText(c.phone) || !optionalText(c.notes) || !str(c.created_at) || !optionalText(c.remote_id) || !optionalText(c.account_id) || !optionalText(c.email) || !optionalText(c.saved_address) || !optionalText(c.saved_postcode) || (c.saved_address?.length ?? 0) > 500 || (c.saved_postcode?.length ?? 0) > 20 || (c.cloud_revision !== undefined && !pence(c.cloud_revision)) || (c.disabled !== undefined && ![0, 1].includes(c.disabled))) throw new Error("Invalid client in backup.");
    return { id: c.id, name: c.name, phone: c.phone ?? null, notes: c.notes ?? null, created_at: c.created_at,
      remote_id: b.version === 3 ? c.remote_id ?? null : null, account_id: b.version === 3 ? c.account_id ?? null : null,
      email: c.email ?? "", cloud_revision: 0, disabled: c.disabled ?? 0,
      saved_address: c.saved_address ?? "", saved_postcode: c.saved_postcode ?? "" };
  });
  const transactions = b.transactions.map((t) => {
    if (!positiveId(t.id) || !["income", "expense"].includes(t.type) || !str(t.date) || !/^\d{4}-\d{2}-\d{2}$/.test(t.date) || !pence(t.amount_pence) || !nullableId(t.category_id) || !nullableId(t.client_id) || !optionalText(t.description) || !str(t.created_at)) throw new Error("Invalid entry in backup.");
    return { id: t.id, type: t.type, date: t.date, amount_pence: t.amount_pence, category_id: t.category_id, client_id: t.client_id, description: t.description ?? null, created_at: t.created_at };
  });
  const appointments = (b.appointments ?? []).map((a) => {
    const originalStatus = String(a.status);
    const status: AppointmentStatus = originalStatus === "booked" || originalStatus === "paid" ? "confirmed" : a.status;
    if (!positiveId(a.id) || !str(a.date) || !/^\d{4}-\d{2}-\d{2}$/.test(a.date) || !str(a.start_time) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(a.start_time) || !Number.isSafeInteger(a.duration_min) || a.duration_min <= 0 || !nullableId(a.client_id) || !nullableId(a.category_id) || (a.price_pence != null && !pence(a.price_pence)) || !optionalText(a.notes) || !["pending", "confirmed", "rejected", "cancelled", "no_show"].includes(status) || !nullableId(a.transaction_id) || !optionalText(a.series_id) || !str(a.created_at) || !optionalText(a.remote_id) || !optionalText(a.service_id) || !optionalText(a.service_name) || !optionalText(a.customer_notes)) throw new Error("Invalid appointment in backup.");
    if (!flag(a.time_confirmed) || !flag(a.is_remote) || !optionalText(a.visit_address) || !optionalText(a.visit_postcode) || (a.visit_address?.length ?? 0) > 500 || (a.visit_postcode?.length ?? 0) > 20 || (a.base_price_pence != null && !pence(a.base_price_pence)) || (a.discount_percent !== undefined && (!Number.isSafeInteger(a.discount_percent) || a.discount_percent < 0 || a.discount_percent > 100))) throw new Error("Invalid booking options in backup.");
    const time_confirmed = a.time_confirmed === undefined ? 1 : Number(Boolean(a.time_confirmed));
    const is_remote = Number(Boolean(a.is_remote));
    if (is_remote && (!a.visit_address?.trim() || !a.visit_postcode?.trim())) throw new Error("A travelling booking in the backup needs its address and postcode.");
    return { id: a.id, date: a.date, start_time: time_confirmed ? a.start_time : "00:00", duration_min: a.duration_min, client_id: a.client_id, category_id: a.category_id,
      price_pence: a.price_pence ?? null, notes: a.notes ?? null, status, transaction_id: a.transaction_id, series_id: a.series_id ?? null,
      created_at: a.created_at, remote_id: b.version === 3 ? a.remote_id ?? null : null, service_id: a.service_id ?? null,
      service_name: a.service_name ?? "", customer_notes: b.version === 3 ? a.customer_notes ?? "" : "", cloud_revision: 0,
      proposed_date: null, proposed_start_time: null, proposed_time_confirmed: null,
      time_confirmed, is_remote, visit_address: is_remote ? a.visit_address ?? "" : "", visit_postcode: is_remote ? a.visit_postcode ?? "" : "",
      base_price_pence: a.base_price_pence === undefined ? a.price_pence ?? null : a.base_price_pence,
      discount_percent: a.discount_percent ?? 0 };
  });
  if (![categories, clients, transactions, appointments].every(unique)) throw new Error("Duplicate record IDs in backup.");
  const categoryIds = new Set(categories.map((r) => r.id));
  const clientIds = new Set(clients.map((r) => r.id));
  const txById = new Map(transactions.map((r) => [r.id, r]));
  const paymentIds = new Set<number>();
  for (const row of [...transactions, ...appointments]) if ((row.category_id != null && !categoryIds.has(row.category_id)) || (row.client_id != null && !clientIds.has(row.client_id))) throw new Error("Broken record link in backup.");
  for (const row of appointments) if (row.transaction_id != null) {
    if (txById.get(row.transaction_id)?.type !== "income" || paymentIds.has(row.transaction_id)) throw new Error("Invalid or duplicate appointment payment in backup.");
    paymentIds.add(row.transaction_id);
  }
  for (const rows of [clients, appointments]) {
    const ids = rows.map((r) => r.remote_id).filter((id) => id != null);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate shared identity in backup.");
  }
  return { app: "ffyon-business-tracker", version: 3, exported_at: str(b.exported_at) ? b.exported_at : new Date().toISOString(), categories, clients, transactions, appointments };
}

export async function wipeAll() {
  const db = await getDb();
  await db.batch(["DELETE FROM appointments", "DELETE FROM transactions", "DELETE FROM clients", "DELETE FROM sync_state"].map((sql) => ({ sql })));
  await rebuildMirrorIfOnline();
}

/** Replaces everything in the database with the backup's contents. */
export async function restoreAll(b: Backup) {
  const normalized = normalizeBackup(b);
  const db = await getDb();
  const [current] = await db.select<{ n: number }[]>("SELECT (SELECT COUNT(*) FROM clients WHERE remote_id IS NOT NULL) + (SELECT COUNT(*) FROM appointments WHERE remote_id IS NOT NULL) AS n");
  const hasSharedRecords = normalized.clients.some((client) => client.remote_id) || (normalized.appointments ?? []).some((appointment) => appointment.remote_id) || (current?.n ?? 0) > 0;
  const statements: Statement[] = [
    ...["DELETE FROM appointments", "DELETE FROM transactions", "DELETE FROM clients", "DELETE FROM categories", "DELETE FROM sync_state", "DELETE FROM cloud_services", "DELETE FROM cloud_blocks", "DELETE FROM cloud_settings"].map((sql) => ({ sql })),
    ...normalized.categories.map(categoryStatement), ...normalized.clients.map(clientStatement),
    ...normalized.transactions.map(transactionStatement), ...(normalized.appointments ?? []).map(appointmentStatement),
  ];
  if (hasSharedRecords) {
    await requireOnlineAccess();
    const sync = await import("./sync");
    const response = await sync.adminRequest<import("./sync").SyncResponse>("sync", "GET");
    if (!response.snapshot || response.has_more || response.changes.length) throw new Error("The site did not return a complete snapshot. The backup was not restored.");
    await sync.applySyncResponse(response, statements);
  } else {
    await db.batch(statements);
  }
}

async function rebuildMirrorIfOnline() {
  const { getAccessStatus } = await import("./access");
  if ((await getAccessStatus()).state === "online") {
    const { syncNow } = await import("./sync");
    await syncNow().catch(() => {});
  }
}
