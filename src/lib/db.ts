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
  await db.execute(
    `INSERT INTO transactions (type, date, amount_pence, category_id, client_id, description)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [t.type, t.date, t.amount_pence, t.category_id, t.client_id, t.description || null],
  );
}

export async function updateTransaction(id: number, t: TransactionInput) {
  const db = await getDb();
  await db.execute(
    `UPDATE transactions SET type = $1, date = $2, amount_pence = $3, category_id = $4,
       client_id = $5, description = $6 WHERE id = $7`,
    [t.type, t.date, t.amount_pence, t.category_id, t.client_id, t.description || null, id],
  );
}

export async function deleteTransaction(id: number) {
  const db = await getDb();
  await db.execute("DELETE FROM transactions WHERE id = $1", [id]);
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
  version: 1;
  exported_at: string;
  categories: Category[];
  clients: Client[];
  transactions: Transaction[];
}

export async function exportAll(): Promise<Backup> {
  const db = await getDb();
  const [categories, clients, transactions] = await Promise.all([
    db.select<Category[]>("SELECT * FROM categories ORDER BY id"),
    db.select<Client[]>("SELECT * FROM clients ORDER BY id"),
    db.select<Transaction[]>("SELECT * FROM transactions ORDER BY id"),
  ]);
  return {
    app: "ffyon-business-tracker",
    version: 1,
    exported_at: new Date().toISOString(),
    categories,
    clients,
    transactions,
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
  await db.execute("DELETE FROM transactions");
  await db.execute("DELETE FROM clients");
}

/** Replaces everything in the database with the backup's contents. */
export async function restoreAll(b: Backup) {
  const db = await getDb();
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
}
