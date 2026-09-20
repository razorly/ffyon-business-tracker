import Database from "@tauri-apps/plugin-sql";

export type TxType = "income" | "expense";

export interface Category {
  id: number;
  name: string;
  type: TxType;
  colour: string;
  /** Usual price, in pence. Prefills the amount on a new entry only — saved entries keep their own amount. */
  default_pence: number | null;
}

export interface Client {
  id: number;
  name: string;
  phone: string | null;
  notes: string | null;
  created_at: string;
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

/**
 * 'booked' = in the diary only. 'paid' = it has an income entry in the money tracking.
 * 'cancelled' and 'no_show' keep the record without ever owing anything.
 */
export type AppointmentStatus = "booked" | "paid" | "cancelled" | "no_show";

/** Statuses that are still expected to be paid for — what "still to collect" counts. */
export const isOwed = (a: Pick<Appointment, "status">) => a.status === "booked";

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
}

export interface AppointmentRow extends Appointment {
  client_name: string | null;
  category_name: string | null;
  category_colour: string | null;
}

export type AppointmentInput = Omit<Appointment, "id" | "created_at" | "status" | "transaction_id" | "series_id">;

export interface Db {
  select<T>(sql: string, params?: unknown[]): Promise<T>;
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;
}

let dbPromise: Promise<Db> | null = null;

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function getDb(): Promise<Db> {
  if (!dbPromise) {
    if (import.meta.env.DEV && !isTauri()) {
      dbPromise = import("./devdb").then((m) => m.createDevDb());
    } else {
      dbPromise = Database.load("sqlite:ffyon.db") as Promise<Db>;
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

export async function createCategory(c: Omit<Category, "id">) {
  const db = await getDb();
  await db.execute("INSERT INTO categories (name, type, colour, default_pence) VALUES ($1, $2, $3, $4)", [
    c.name,
    c.type,
    c.colour,
    c.default_pence,
  ]);
}

export async function updateCategory(c: Category) {
  const db = await getDb();
  await db.execute("UPDATE categories SET name = $1, colour = $2, default_pence = $3 WHERE id = $4", [
    c.name,
    c.colour,
    c.default_pence,
    c.id,
  ]);
}

export async function deleteCategory(id: number) {
  const db = await getDb();
  await db.execute("UPDATE transactions SET category_id = NULL WHERE category_id = $1", [id]);
  await db.execute("UPDATE appointments SET category_id = NULL WHERE category_id = $1", [id]);
  await db.execute("DELETE FROM categories WHERE id = $1", [id]);
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

export async function createClient(c: { name: string; phone?: string | null; notes?: string | null }) {
  const db = await getDb();
  const res = await db.execute("INSERT INTO clients (name, phone, notes) VALUES ($1, $2, $3)", [
    c.name.trim(),
    c.phone || null,
    c.notes || null,
  ]);
  return res.lastInsertId as number;
}

export async function updateClient(c: Pick<Client, "id" | "name" | "phone" | "notes">) {
  const db = await getDb();
  await db.execute("UPDATE clients SET name = $1, phone = $2, notes = $3 WHERE id = $4", [
    c.name.trim(),
    c.phone || null,
    c.notes || null,
    c.id,
  ]);
}

export async function deleteClient(id: number) {
  const db = await getDb();
  await db.execute("UPDATE transactions SET client_id = NULL WHERE client_id = $1", [id]);
  await db.execute("UPDATE appointments SET client_id = NULL WHERE client_id = $1", [id]);
  await db.execute("DELETE FROM clients WHERE id = $1", [id]);
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
  await db.execute(
    `UPDATE transactions SET type = $1, date = $2, amount_pence = $3, category_id = $4,
       client_id = $5, description = $6 WHERE id = $7`,
    [t.type, t.date, t.amount_pence, t.category_id, t.client_id, t.description || null, id],
  );
  // If this entry came from an appointment, the appointment's price follows it.
  await db.execute("UPDATE appointments SET price_pence = $1 WHERE transaction_id = $2", [t.amount_pence, id]);
}

export async function deleteTransaction(id: number) {
  const db = await getDb();
  // An appointment whose entry has been deleted goes back to unpaid, so the
  // money it was worth leaves the totals with it.
  await db.execute(
    "UPDATE appointments SET status = 'booked', transaction_id = NULL WHERE transaction_id = $1",
    [id],
  );
  await db.execute("DELETE FROM transactions WHERE id = $1", [id]);
}

// ---------- Appointments ----------

/**
 * Appointments are the diary, not the money. Booking one writes nothing to
 * `transactions`, so an unpaid or upcoming appointment never appears in any
 * total, chart or export. Marking one paid is what creates its income entry.
 */

const APPT_SELECT = `
  SELECT a.*, cl.name AS client_name, cat.name AS category_name, cat.colour AS category_colour
  FROM appointments a
  LEFT JOIN clients cl ON cl.id = a.client_id
  LEFT JOIN categories cat ON cat.id = a.category_id
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
  sql += " ORDER BY a.date, a.start_time, a.id";
  return db.select<AppointmentRow[]>(sql, params);
}

export async function getAppointment(id: number): Promise<AppointmentRow | null> {
  const db = await getDb();
  const rows = await db.select<AppointmentRow[]>(`${APPT_SELECT} WHERE a.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function createAppointment(a: AppointmentInput, seriesId: string | null = null) {
  const db = await getDb();
  const res = await db.execute(
    `INSERT INTO appointments (date, start_time, duration_min, client_id, category_id, price_pence, notes, series_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [a.date, a.start_time, a.duration_min, a.client_id, a.category_id, a.price_pence, a.notes || null, seriesId],
  );
  return res.lastInsertId as number;
}

/** Books the same appointment on each date, tied together so the run can be managed as one. */
export async function createAppointmentSeries(a: AppointmentInput, dates: string[]) {
  const seriesId = crypto.randomUUID();
  const ids: number[] = [];
  for (const date of dates) ids.push(await createAppointment({ ...a, date }, seriesId));
  return ids;
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

/** Deletes this appointment and the rest of its run, with any entries they created. */
export async function deleteAppointmentSeries(seriesId: string, fromDate: string) {
  const db = await getDb();
  const rows = await db.select<{ transaction_id: number | null }[]>(
    "SELECT transaction_id FROM appointments WHERE series_id = $1 AND date >= $2",
    [seriesId, fromDate],
  );
  for (const r of rows) {
    if (r.transaction_id != null) await db.execute("DELETE FROM transactions WHERE id = $1", [r.transaction_id]);
  }
  await db.execute("DELETE FROM appointments WHERE series_id = $1 AND date >= $2", [seriesId, fromDate]);
  return rows.length;
}

/** Saves an appointment. A paid one owns its income entry, so the entry is kept in step. */
export async function updateAppointment(id: number, a: AppointmentInput) {
  const db = await getDb();
  await db.execute(
    `UPDATE appointments SET date = $1, start_time = $2, duration_min = $3, client_id = $4,
       category_id = $5, price_pence = $6, notes = $7 WHERE id = $8`,
    [a.date, a.start_time, a.duration_min, a.client_id, a.category_id, a.price_pence, a.notes || null, id],
  );
  const txId = await linkedTransactionId(id);
  if (txId != null && a.price_pence != null && a.price_pence > 0) {
    await updateTransaction(txId, {
      type: "income",
      date: a.date,
      amount_pence: a.price_pence,
      category_id: a.category_id,
      client_id: a.client_id,
      description: a.notes,
    });
  }
}

/** Deletes an appointment, and the income entry it created if it was paid. */
export async function deleteAppointment(id: number) {
  const db = await getDb();
  const txId = await linkedTransactionId(id);
  if (txId != null) await db.execute("DELETE FROM transactions WHERE id = $1", [txId]);
  await db.execute("DELETE FROM appointments WHERE id = $1", [id]);
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
export async function markAppointmentPaid(id: number) {
  const db = await getDb();
  const a = await getAppointment(id);
  if (!a) throw new Error("Appointment not found");
  if (a.transaction_id != null) return; // already paid — never create a second entry
  if (a.price_pence == null || a.price_pence <= 0) throw new Error("Add a price before marking this paid");
  const txId = await createTransaction({
    type: "income",
    date: a.date,
    amount_pence: a.price_pence,
    category_id: a.category_id,
    client_id: a.client_id,
    description: a.notes,
  });
  await db.execute("UPDATE appointments SET status = 'paid', transaction_id = $1 WHERE id = $2", [txId, id]);
}

/**
 * Moves an appointment to any status other than paid. Whatever it was, it stops
 * counting as money: an entry it had created is removed with it.
 */
export async function setAppointmentStatus(id: number, status: Exclude<AppointmentStatus, "paid">) {
  const db = await getDb();
  const txId = await linkedTransactionId(id);
  if (txId != null) await db.execute("DELETE FROM transactions WHERE id = $1", [txId]);
  await db.execute("UPDATE appointments SET status = $1, transaction_id = NULL WHERE id = $2", [status, id]);
}

/** Undoes a payment: the income entry is removed, so the money leaves the totals again. */
export const markAppointmentUnpaid = (id: number) => setAppointmentStatus(id, "booked");

/** Past appointments still waiting to be marked paid — money she hasn't collected. */
export async function unpaidBefore(date: string): Promise<AppointmentRow[]> {
  const db = await getDb();
  return db.select<AppointmentRow[]>(
    `${APPT_SELECT} WHERE a.status = 'booked' AND a.date < $1 ORDER BY a.date, a.start_time`,
    [date],
  );
}

/** A client's appointments from `from` onwards, cancellations aside. */
export async function upcomingForClient(clientId: number, from: string): Promise<AppointmentRow[]> {
  const db = await getDb();
  return db.select<AppointmentRow[]>(
    `${APPT_SELECT} WHERE a.client_id = $1 AND a.date >= $2 AND a.status IN ('booked', 'paid')
     ORDER BY a.date, a.start_time`,
    [clientId, from],
  );
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
    version: 2,
    exported_at: new Date().toISOString(),
    categories,
    clients,
    transactions,
    appointments,
  };
}

export function validateBackup(data: unknown): data is Backup {
  const b = data as Backup;
  return (
    !!b &&
    b.app === "ffyon-business-tracker" &&
    Array.isArray(b.categories) &&
    Array.isArray(b.clients) &&
    Array.isArray(b.transactions)
  );
}

export async function wipeAll() {
  const db = await getDb();
  await db.execute("DELETE FROM appointments");
  await db.execute("DELETE FROM transactions");
  await db.execute("DELETE FROM clients");
}

/** Replaces everything in the database with the backup's contents. */
export async function restoreAll(b: Backup) {
  const db = await getDb();
  await db.execute("DELETE FROM appointments");
  await db.execute("DELETE FROM transactions");
  await db.execute("DELETE FROM clients");
  await db.execute("DELETE FROM categories");
  for (const c of b.categories) {
    await db.execute(
      "INSERT INTO categories (id, name, type, colour, default_pence) VALUES ($1, $2, $3, $4, $5)",
      [c.id, c.name, c.type, c.colour, c.default_pence ?? null],
    );
  }
  for (const c of b.clients) {
    await db.execute(
      "INSERT INTO clients (id, name, phone, notes, created_at) VALUES ($1, $2, $3, $4, $5)",
      [c.id, c.name, c.phone, c.notes, c.created_at],
    );
  }
  for (const t of b.transactions) {
    await db.execute(
      `INSERT INTO transactions (id, type, date, amount_pence, category_id, client_id, description, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [t.id, t.type, t.date, t.amount_pence, t.category_id, t.client_id, t.description, t.created_at],
    );
  }
  // Backups made before the schedule existed simply have no appointments.
  for (const a of b.appointments ?? []) {
    await db.execute(
      `INSERT INTO appointments (id, date, start_time, duration_min, client_id, category_id, price_pence,
         notes, status, transaction_id, series_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        a.id,
        a.date,
        a.start_time,
        a.duration_min,
        a.client_id,
        a.category_id,
        a.price_pence,
        a.notes,
        a.status,
        a.transaction_id,
        a.series_id ?? null,
        a.created_at,
      ],
    );
  }
}
