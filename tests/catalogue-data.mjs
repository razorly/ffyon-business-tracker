import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { test } from "node:test";
import initSqlJs from "sql.js";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SQL = await initSqlJs();
const rust = await readFile(path.join(root, "src-tauri/src/lib.rs"), "utf8");
const migrations = [...rust.matchAll(/version:\s*(\d+),[\s\S]*?sql:\s*r#"([\s\S]*?)"#/g)]
  .map((m) => ({ version: Number(m[1]), sql: m[2] }));
const plain = (value) => JSON.parse(JSON.stringify(value));
const bind = (params = []) => Object.fromEntries(params.map((value, i) => [`$${i + 1}`, value ?? null]));

function fixture(through = Infinity) {
  const sqlite = new SQL.Database();
  sqlite.run("PRAGMA foreign_keys=ON");
  for (const migration of migrations.filter((m) => m.version <= through)) sqlite.run(migration.sql);
  const select = (sql, params) => {
    const stmt = sqlite.prepare(sql);
    try {
      stmt.bind(bind(params));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally { stmt.free(); }
  };
  const execute = (sql, params) => {
    sqlite.run(sql, bind(params));
    return { rowsAffected: sqlite.getRowsModified(), lastInsertId: select("SELECT last_insert_rowid() AS id")[0].id };
  };
  let tail = Promise.resolve();
  const serialized = (f) => { const next = tail.then(f); tail = next.catch(() => {}); return next; };
  const db = {
    select: (sql, params) => serialized(() => select(sql, params)),
    execute: (sql, params) => serialized(() => execute(sql, params)),
    batch: (statements) => serialized(() => {
      sqlite.run("BEGIN");
      try { const results = statements.map((s) => execute(s.sql, s.params)); sqlite.run("COMMIT"); return results; }
      catch (e) { sqlite.run("ROLLBACK"); throw e; }
    }),
  };
  return { sqlite, db, select, execute, close: () => sqlite.close() };
}

async function application(f) {
  const context = vm.createContext({ console, crypto: webcrypto, TextEncoder, TextDecoder, URL,
    setTimeout, clearTimeout, setInterval, clearInterval,
    window: { __TAURI_INTERNALS__: {}, addEventListener() {}, removeEventListener() {} } });
  const native = async (command, args = {}) => {
    if (command === "db_select") return f.db.select(args.sql, args.params);
    if (command === "db_execute") return f.db.execute(args.sql, args.params);
    if (command === "db_batch") return f.db.batch(args.statements);
    if (command === "access_status") return { state: "online", expires_at: 2_000_000_000, device_id: "fixture", device_name: "Fixture", error: null };
    if (command === "admin_request") throw new Error("Network access is forbidden in catalogue data tests.");
    throw new Error(`Unexpected native command: ${command}`);
  };
  const mocks = {
    "@tauri-apps/api/core": { invoke: native, isTauri: () => true },
    "@tauri-apps/api/event": { listen: async () => () => {}, emit: async () => {} },
  };
  const cache = new Map();
  const load = async (id) => {
    if (!cache.has(id)) cache.set(id, (async () => {
      if (mocks[id]) {
        const exports = mocks[id];
        return new vm.SyntheticModule(Object.keys(exports), function () {
          for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context, identifier: id });
      }
      const source = await readFile(id, "utf8");
      const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: id }).outputText;
      return new vm.SourceTextModule(code, { context, identifier: id,
        initializeImportMeta(meta) { meta.env = { DEV: false }; },
        async importModuleDynamically(specifier, referencing) {
          const m = await linker(specifier, referencing);
          if (m.status === "unlinked") await m.link(linker);
          if (m.status === "linked") await m.evaluate();
          return m;
        },
      });
    })());
    return cache.get(id);
  };
  const linker = (specifier, referencing) => {
    if (mocks[specifier]) return load(specifier);
    const id = path.resolve(path.dirname(referencing.identifier), specifier);
    return load(path.extname(id) ? id : `${id}.ts`);
  };
  const m = await load(path.join(root, "src/lib/db.ts"));
  await m.link(linker); await m.evaluate(); return m.namespace;
}

function service(f, id, name, active = true) {
  f.execute("INSERT INTO cloud_services(id,data) VALUES ($1,$2) ON CONFLICT(id) DO UPDATE SET data=excluded.data", [id, JSON.stringify({ id, name, active, price_pence: 3000, duration_min: 30, discount_percent: 20 })]);
}
const input = (overrides = {}) => ({ type: "income", date: "2026-10-01", amount_pence: 2400, category_id: null, client_id: null, description: null, ...overrides });

test("catalogue migration uses explicit links and booked payment identity without guessing names", () => {
  const f = fixture(7);
  try {
    f.execute("UPDATE categories SET service_id='mapped' WHERE id=1");
    f.execute("INSERT INTO transactions(type,date,amount_pence,category_id) VALUES ('income','2026-09-30',2317,1)");
    f.execute("INSERT INTO transactions(type,date,amount_pence,category_id) VALUES ('income','2026-09-30',1777,2)");
    f.execute("INSERT INTO appointments(date,start_time,category_id,status,transaction_id,service_id,service_name) VALUES ('2026-09-30','09:00',1,'confirmed',1,'booked','Historical booked label')");
    f.execute("INSERT INTO transactions(type,date,amount_pence,category_id) VALUES ('income','2026-09-30',1800,1)");
    f.execute("INSERT INTO appointments(date,start_time,category_id,status,transaction_id,service_name) VALUES ('2026-09-30','10:00',1,'confirmed',3,'Historical name-only service')");
    f.sqlite.run(migrations.find((m) => m.version === 8).sql);
    assert.deepEqual(f.select("SELECT amount_pence,service_id,service_name,category_name_snapshot,income_kind FROM transactions ORDER BY id"), [
      { amount_pence: 2317, service_id: "booked", service_name: "Historical booked label", category_name_snapshot: "Spray Tan", income_kind: "service" },
      { amount_pence: 1777, service_id: null, service_name: "", category_name_snapshot: "Express Tan", income_kind: "legacy" },
      { amount_pence: 1800, service_id: null, service_name: "Historical name-only service", category_name_snapshot: "Spray Tan", income_kind: "service" },
    ]);
    assert.equal(f.select("SELECT service_id FROM appointments WHERE id=2")[0].service_id, null);
    f.execute("UPDATE categories SET service_id='mapped',income_kind='service' WHERE id=2");
    assert.equal(f.select("SELECT COUNT(*) AS n FROM categories WHERE service_id='mapped'")[0].n, 2);
  } finally { f.close(); }
});

test("explicit legacy review preserves money and labels and never overwrites an existing service", async () => {
  const f = fixture();
  try {
    const db = await application(f); service(f, "chosen", "New catalogue name");
    f.execute("INSERT INTO transactions(type,date,amount_pence,category_id,category_name_snapshot,income_kind) VALUES ('income','2026-09-30',1237,1,'Original label','legacy')");
    f.execute("INSERT INTO transactions(type,date,amount_pence,category_id,service_id,service_name,category_name_snapshot,income_kind) VALUES ('income','2026-09-30',987,1,'existing','Existing booked label','Original label','service')");
    f.execute("INSERT INTO appointments(date,start_time,category_id,service_name) VALUES ('2026-10-02','09:00',1,'Original appointment label')");
    f.execute("INSERT INTO appointments(date,start_time,category_id,remote_id,service_id,service_name) VALUES ('2026-10-02','10:00',1,'shared','existing','Existing shared label')");
    f.execute("INSERT INTO transactions(type,date,amount_pence,category_name_snapshot,income_kind) VALUES ('income','2026-09-30',599,'Detached payment label','legacy')");
    f.execute("INSERT INTO appointments(date,start_time,category_id,transaction_id,service_name) VALUES ('2026-10-02','11:00',1,3,'Detached appointment label')");
    assert.equal((await db.listLegacyIncomeCategories()).find((c) => c.id === 1).transaction_count, 2);
    await db.resolveLegacyIncomeCategory(1, "chosen");
    assert.deepEqual(f.select("SELECT amount_pence,service_id,service_name,income_kind FROM transactions ORDER BY id"), [
      { amount_pence: 1237, service_id: "chosen", service_name: "Original label", income_kind: "service" },
      { amount_pence: 987, service_id: "existing", service_name: "Existing booked label", income_kind: "service" },
      { amount_pence: 599, service_id: null, service_name: "Detached payment label", income_kind: "service" },
    ]);
    assert.deepEqual(f.select("SELECT service_id,service_name FROM appointments ORDER BY id"), [
      { service_id: null, service_name: "Original appointment label" },
      { service_id: "existing", service_name: "Existing shared label" },
      { service_id: null, service_name: "Detached appointment label" },
    ]);
    await assert.rejects(db.resolveLegacyIncomeCategory(1, "chosen"), /already been reviewed/);
    await db.resolveLegacyIncomeCategory(4, null);
    assert.deepEqual((await db.listOtherIncomeCategories()).map((c) => c.id), [4]);
    assert.equal((await db.listLegacyIncomeCategories()).some((c) => c.id === 1 || c.id === 4), false);
    await assert.rejects(db.resolveLegacyIncomeCategory(2, "missing"), /existing service/);
    assert.equal(f.select("SELECT income_kind FROM categories WHERE id=2")[0].income_kind, "legacy");
  } finally { f.close(); }
});

test("service payments snapshot once, keep edited amounts and reject new archived services", async () => {
  const f = fixture();
  try {
    const db = await application(f); service(f, "spray", "Original spray");
    const id = await db.createTransaction(input({ service_id: "spray", service_name: "stale label" }));
    service(f, "spray", "Renamed spray", false);
    await db.updateTransaction(id, input({ amount_pence: 2550, service_id: "spray", service_name: "Renamed spray" }));
    const row = plain(await db.getTransaction(id));
    assert.equal(row.amount_pence, 2550); assert.equal(row.service_name, "Original spray");
    assert.equal(row.category_id, null); assert.equal(row.category_name, "Original spray"); assert.equal(row.income_kind, "service");
    await assert.rejects(db.createTransaction(input({ service_id: "spray" })), /archived/);
    await assert.rejects(db.createTransaction(input({ service_id: "spray", category_id: 1 })), /do not need/);
    await db.createCategory({ name: "Tips", type: "income", colour: "#009944", default_pence: null });
    const [tips] = await db.listOtherIncomeCategories();
    const otherId = await db.createTransaction(input({ category_id: tips.id, amount_pence: 150 }));
    await db.updateCategory({ ...tips, name: "Gratuities" });
    await db.deleteCategory(tips.id);
    const other = await db.getTransaction(otherId);
    assert.equal(other.category_name, "Tips"); assert.equal(other.income_kind, "other"); assert.equal(other.amount_pence, 150);
    const unassigned = await db.createTransaction(input());
    await db.updateTransaction(unassigned, input({ income_kind: "other", category_name_snapshot: "Other income" }));
    assert.equal((await db.getTransaction(unassigned)).income_kind, "other");
    await db.updateTransaction(unassigned, input({ income_kind: null }));
    assert.equal((await db.getTransaction(unassigned)).income_kind, null);
  } finally { f.close(); }
});

test("appointment payment uses agreed service once and privacy cleanup retains its attribution", async () => {
  const f = fixture();
  try {
    const db = await application(f);
    f.execute("INSERT INTO clients(name) VALUES ('Disposable customer')");
    f.execute("INSERT INTO appointments(date,start_time,client_id,category_id,service_id,service_name,price_pence,notes) VALUES ('2026-10-01','09:00',1,1,'booked','Historical booked name',2300,'Private note')");
    await Promise.all([db.markAppointmentPaid(1), db.markAppointmentPaid(1)]);
    assert.equal(f.select("SELECT COUNT(*) AS n FROM transactions")[0].n, 1);
    const [payment] = f.select("SELECT * FROM transactions");
    assert.equal(payment.service_id, "booked"); assert.equal(payment.service_name, "Historical booked name"); assert.equal(payment.category_id, null);
    await assert.rejects(db.updateTransaction(payment.id, input({ type: "expense", amount_pence: 2300 })), /remain an income/);
    await assert.rejects(db.updateTransaction(payment.id, input({ amount_pence: 2300, income_kind: "other", service_id: null })), /keeps its booked service/);
    await db.deleteClient(1);
    const retained = await db.getTransaction(payment.id);
    assert.equal(retained.amount_pence, 2300); assert.equal(retained.service_name, "Historical booked name");
    assert.equal(retained.income_kind, "service"); assert.equal(retained.client_id, null); assert.equal(retained.description, null);
    assert.equal(f.select("SELECT COUNT(*) AS n FROM appointments")[0].n, 0);
  } finally { f.close(); }
});

test("service totals merge renamed catalogue identities and preserve detached Other labels", async () => {
  const f = fixture();
  try {
    const db = await application(f); service(f, "same", "Old name");
    await db.createTransaction(input({ service_id: "same", amount_pence: 1200 }));
    service(f, "same", "New name");
    await db.createTransaction(input({ service_id: "same", amount_pence: 1800 }));
    await db.createTransaction(input({ amount_pence: 100, income_kind: "other", category_name_snapshot: "Tips" }));
    const totals = plain(await db.incomeTotals("2026-10-01", "2026-10-31"));
    assert.equal(totals.filter((t) => t.service_id === "same").length, 1);
    const serviceTotal = totals.find((t) => t.service_id === "same");
    assert.deepEqual({ ...serviceTotal, colour: "stable" }, { id: null, service_id: "same", kind: "service", name: "New name", colour: "stable", total: 3000 });
    assert.equal(serviceTotal.colour, (await db.getTransaction(1)).category_colour);
    assert.equal(totals.find((t) => t.name === "Tips").kind, "other");
    assert.deepEqual(plain(await db.categoryTotals("income", "2026-10-01", "2026-10-31")), totals);
  } finally { f.close(); }
});

test("name-only booking snapshots stay authoritative through payment, v4 restore and legacy review", async () => {
  const f = fixture();
  try {
    const db = await application(f); service(f, "unrelated", "Unrelated service");
    f.execute("UPDATE categories SET service_id='unrelated',income_kind='service' WHERE id=1");
    f.execute("INSERT INTO appointments(date,start_time,category_id,service_name,price_pence) VALUES ('2026-10-01','09:00',1,'Saved historical treatment',1900)");
    await db.markAppointmentPaid(1);
    const payment = await db.getTransaction(1);
    assert.equal(payment.service_id, null); assert.equal(payment.service_name, "Saved historical treatment");
    assert.equal(payment.income_kind, "service"); assert.equal(payment.amount_pence, 1900);
    const backup = plain(await db.exportAll());
    const normalized = plain(db.normalizeBackup(backup));
    assert.equal(normalized.appointments[0].service_id, null);
    assert.equal(normalized.appointments[0].service_name, "Saved historical treatment");
    assert.equal(normalized.transactions[0].service_id, null);
    await db.restoreAll(backup);
    assert.equal((await db.getAppointment(1)).service_id, null);
    assert.equal((await db.getTransaction(1)).service_id, null);
    f.execute("UPDATE categories SET service_id=NULL,income_kind='legacy' WHERE id=1");
    f.execute("UPDATE transactions SET service_name='',income_kind='legacy',category_id=1 WHERE id=1");
    service(f, "chosen", "Chosen service");
    await db.resolveLegacyIncomeCategory(1, "chosen");
    assert.equal((await db.getAppointment(1)).service_id, null);
    assert.equal((await db.getTransaction(1)).service_id, null);
    assert.equal((await db.getTransaction(1)).service_name, "Spray Tan");
    assert.equal((await db.getTransaction(1)).income_kind, "service");
    const old = { ...backup, version: 3, transactions: backup.transactions.map(({ service_id, service_name, category_name_snapshot, income_kind, ...t }) => t) };
    const oldNormalized = plain(db.normalizeBackup(old));
    assert.equal(oldNormalized.appointments[0].service_id, null);
    assert.equal(oldNormalized.transactions[0].service_id, null);
    assert.equal(oldNormalized.transactions[0].service_name, "Saved historical treatment");
  } finally { f.close(); }
});

test("backup v4 and undo retain catalogue snapshots while old backups normalize without repricing", async () => {
  const f = fixture();
  try {
    const db = await application(f); service(f, "same", "Snapshot name");
    const id = await db.createTransaction(input({ service_id: "same", amount_pence: 1999 }));
    const undo = await db.deleteTransaction(id); await db.undoDelete(undo);
    assert.equal((await db.getTransaction(id)).service_name, "Snapshot name");
    const backup = plain(await db.exportAll());
    assert.equal(backup.version, 4);
    await db.restoreAll(backup);
    assert.equal((await db.getTransaction(id)).service_name, "Snapshot name");
    assert.equal((await db.getTransaction(id)).amount_pence, 1999);
    assert.equal((await db.getTransaction(id)).income_kind, "service");
    for (const version of [1, 2, 3]) {
      const old = { app: "ffyon-business-tracker", version, exported_at: "2026-10-01", categories: [{ id: 1, name: "Legacy name", type: "income", colour: "#009944", service_id: "explicit" }], clients: [],
        transactions: [{ id: 1, type: "income", date: "2026-09-30", amount_pence: 1237, category_id: 1, client_id: null, description: null, created_at: "2026-09-30" }] };
      const normalized = plain(db.normalizeBackup(old));
      assert.equal(normalized.version, 4); assert.equal(normalized.transactions[0].amount_pence, 1237);
      assert.equal(normalized.transactions[0].service_id, "explicit"); assert.equal(normalized.transactions[0].service_name, "Legacy name");
      if (version >= 2) {
        old.appointments = [{ id: 1, date: "2026-09-30", start_time: "09:00", duration_min: 30, client_id: null, category_id: 1,
          price_pence: 1237, notes: null, status: "paid", transaction_id: 1, created_at: "2026-09-30" }];
        const withBooking = plain(db.normalizeBackup(old));
        assert.equal(withBooking.appointments[0].service_id, "explicit");
        assert.equal(withBooking.appointments[0].service_name, "Legacy name");
        assert.equal(withBooking.transactions[0].service_id, "explicit");
      }
    }
    const invalid = structuredClone(backup); invalid.transactions[0].income_kind = "other";
    assert.equal(db.validateBackup(invalid), false);
  } finally { f.close(); }
});
