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
  .map((match) => ({ version: Number(match[1]), sql: match[2] }));
const bindings = (sql, params) => /\$\d+\b/.test(sql)
  ? Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value ?? null]))
  : params.map((value) => value ?? null);

function select(sqlite, sql, params = []) {
  const statement = sqlite.prepare(sql);
  try {
    statement.bind(bindings(sql, params));
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally { statement.free(); }
}

function fixtureDatabase() {
  const sqlite = new SQL.Database();
  sqlite.run("PRAGMA foreign_keys = ON");
  for (const migration of migrations) sqlite.run(migration.sql);
  sqlite.run("INSERT INTO clients(id,name) VALUES (101,'Payment confirmation fixture')");
  let tail = Promise.resolve();
  const serialized = (operation) => {
    const next = tail.then(operation);
    tail = next.catch(() => {});
    return next;
  };
  const execute = (sql, params = []) => {
    sqlite.run(sql, bindings(sql, params));
    return { rowsAffected: sqlite.getRowsModified(), lastInsertId: Number(select(sqlite, "SELECT last_insert_rowid() AS id")[0].id) };
  };
  return {
    sqlite,
    calls: [],
    execute,
    select: (sql, params) => select(sqlite, sql, params),
    db: {
      select: (sql, params) => serialized(() => select(sqlite, sql, params)),
      execute: (sql, params) => serialized(() => execute(sql, params)),
      batch: (statements) => serialized(() => {
        sqlite.run("BEGIN");
        try {
          const result = statements.map((statement) => execute(statement.sql, statement.params));
          sqlite.run("COMMIT");
          return result;
        } catch (error) { sqlite.run("ROLLBACK"); throw error; }
      }),
    },
    close: () => sqlite.close(),
  };
}

// Load the production query and payment action, with native storage backed only by disposable SQLite.
async function application(fixture) {
  assert.equal(typeof vm.SourceTextModule, "function", "Run with node --experimental-vm-modules --test tests/payment-confirmations.mjs");
  const context = vm.createContext({
    console, crypto: webcrypto, TextEncoder, TextDecoder, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    window: { __TAURI_INTERNALS__: {}, addEventListener() {}, removeEventListener() {} },
  });
  const native = async (command, args = {}) => {
    fixture.calls.push(command);
    switch (command) {
      case "db_select": return fixture.db.select(args.sql, args.params);
      case "db_execute": return fixture.db.execute(args.sql, args.params);
      case "db_batch": return fixture.db.batch(args.statements);
      case "access_status": return { state: "online", device_id: "fixture", device_name: "Fixture", expires_at: 2_000_000_000, error: null };
      default: throw new Error(`Unexpected native command; network and customer emails are forbidden: ${command}`);
    }
  };
  const mocks = {
    "@tauri-apps/api/core": { invoke: native, isTauri: () => true },
    "@tauri-apps/api/event": { listen: async () => () => {}, emit: async () => {} },
    "@tauri-apps/plugin-sql": { default: { load: async () => fixture.db } },
  };
  const cache = new Map();
  async function instantiate(identifier) {
    if (mocks[identifier]) {
      const exports = mocks[identifier];
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context, identifier });
    }
    const source = await readFile(identifier, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, fileName: identifier,
    }).outputText;
    return new vm.SourceTextModule(compiled, {
      context, identifier,
      initializeImportMeta(meta) { meta.env = { DEV: false }; },
      async importModuleDynamically(specifier, referencing) {
        const dependency = await linker(specifier, referencing);
        if (dependency.status === "unlinked") await dependency.link(linker);
        if (dependency.status === "linked") await dependency.evaluate();
        return dependency;
      },
    });
  }
  const load = (identifier) => {
    if (!cache.has(identifier)) cache.set(identifier, instantiate(identifier));
    return cache.get(identifier);
  };
  const linker = async (specifier, referencing) => {
    if (mocks[specifier]) return load(specifier);
    const local = specifier.startsWith("@/") ? path.join(root, "src", specifier.slice(2)) : path.resolve(path.dirname(referencing.identifier), specifier);
    if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
      mocks[specifier] = await import(specifier);
      return load(specifier);
    }
    return load(path.extname(local) ? local : `${local}.ts`);
  };
  const module = await load(path.join(root, "src/lib/db.ts"));
  await module.link(linker);
  await module.evaluate();
  assert.equal(typeof module.namespace.listPaymentConfirmations, "function");
  return module.namespace;
}

function appointment(fixture, id, overrides = {}) {
  const row = {
    date: "2026-12-01", start_time: "10:00", duration_min: 45, status: "confirmed",
    time_confirmed: 1, price_pence: 2200, transaction_id: null, service_id: "fixture-service", service_name: "Booked treatment",
    ...overrides,
  };
  fixture.execute(`INSERT INTO appointments
    (id,date,start_time,duration_min,client_id,status,time_confirmed,price_pence,transaction_id,service_id,service_name)
    VALUES ($1,$2,$3,$4,101,$5,$6,$7,$8,$9,$10)`,
  [id, row.date, row.start_time, row.duration_min, row.status, row.time_confirmed, row.price_pence, row.transaction_id, row.service_id, row.service_name]);
}

const ids = async (app, now) => Array.from(await app.listPaymentConfirmations(new Date(now)), (row) => row.id);

test("payment confirmations wait until a confirmed appointment finishes, including same-day end boundaries", async () => {
  const fixture = fixtureDatabase();
  try {
    const app = await application(fixture);
    appointment(fixture, 301);
    appointment(fixture, 302, { start_time: "10:30" });
    appointment(fixture, 303, { date: "2026-12-02" });
    appointment(fixture, 304, { date: "2026-11-30" });
    assert.deepEqual(await ids(app, "2026-12-01T10:44:59Z"), [304]);
    assert.deepEqual(await ids(app, "2026-12-01T10:45:00Z"), [304, 301]);
    assert.deepEqual(await ids(app, "2026-12-01T11:15:00Z"), [304, 301, 302]);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM transactions")[0].n, 0, "Listing reminders must not record income");
  } finally { fixture.close(); }
});

test("only confirmed unpaid non-free appointments enter payment confirmations", async () => {
  const fixture = fixtureDatabase();
  try {
    const app = await application(fixture);
    fixture.execute("INSERT INTO transactions(id,type,date,amount_pence,client_id) VALUES (201,'income','2026-12-01',2200,101)");
    appointment(fixture, 301);
    appointment(fixture, 302, { status: "pending" });
    appointment(fixture, 303, { status: "rejected" });
    appointment(fixture, 304, { status: "cancelled" });
    appointment(fixture, 305, { status: "no_show" });
    appointment(fixture, 306, { transaction_id: 201 });
    appointment(fixture, 307, { price_pence: 0 });
    appointment(fixture, 308, { price_pence: null });
    assert.deepEqual((await ids(app, "2026-12-01T18:00:00Z")).sort((a, b) => a - b), [301, 308]);
    assert.deepEqual(fixture.select("PRAGMA foreign_key_check"), []);
  } finally { fixture.close(); }
});

test("confirmed date-only bookings become payment confirmations after the London calendar day ends", async () => {
  const fixture = fixtureDatabase();
  try {
    const app = await application(fixture);
    appointment(fixture, 301, { date: "2026-07-15", start_time: "00:00", time_confirmed: 0 });
    appointment(fixture, 302, { date: "2026-07-16", start_time: "00:00", time_confirmed: 0 });
    assert.deepEqual(await ids(app, "2026-07-15T22:59:59Z"), []);
    assert.deepEqual(await ids(app, "2026-07-15T23:00:00Z"), [301], "British summer midnight is 23:00 UTC");
    assert.deepEqual(await ids(app, "2026-07-16T15:00:00Z"), [301], "Today's date-only booking must remain out of reminders");
    appointment(fixture, 303, { date: "2026-12-01", start_time: "00:00", time_confirmed: 0 });
    assert.deepEqual(await ids(app, "2026-12-01T23:59:59Z"), [301, 302]);
    assert.deepEqual(await ids(app, "2026-12-02T00:00:00Z"), [301, 302, 303]);
  } finally { fixture.close(); }
});

test("payment-confirmation timing uses Europe/London summer and winter clocks rather than the device timezone", async () => {
  const fixture = fixtureDatabase();
  const previousTimezone = process.env.TZ;
  process.env.TZ = "Pacific/Honolulu";
  try {
    const app = await application(fixture);
    appointment(fixture, 301, { date: "2026-07-15", start_time: "14:00" });
    assert.deepEqual(await ids(app, "2026-07-15T13:44:59Z"), []);
    assert.deepEqual(await ids(app, "2026-07-15T13:45:00Z"), [301]);
    appointment(fixture, 302, { date: "2026-12-01", start_time: "14:00" });
    assert.deepEqual(await ids(app, "2026-12-01T14:44:59Z"), [301]);
    assert.deepEqual(await ids(app, "2026-12-01T14:45:00Z"), [301, 302]);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
    fixture.close();
  }
});

test("appointments spanning midnight do not need payment confirmation until their complete duration has elapsed", async () => {
  const fixture = fixtureDatabase();
  try {
    const app = await application(fixture);
    appointment(fixture, 301, { date: "2026-07-15", start_time: "23:45", duration_min: 30 });
    assert.deepEqual(await ids(app, "2026-07-15T22:59:59Z"), []);
    assert.deepEqual(await ids(app, "2026-07-15T23:00:00Z"), [], "The date changed, but the timed booking has not ended");
    assert.deepEqual(await ids(app, "2026-07-15T23:14:59Z"), []);
    assert.deepEqual(await ids(app, "2026-07-15T23:15:00Z"), [301]);
  } finally { fixture.close(); }
});

test("quick payment confirmation removes the reminder and records the booked price and service exactly once", async () => {
  const fixture = fixtureDatabase();
  try {
    const app = await application(fixture);
    appointment(fixture, 301);
    assert.deepEqual(await ids(app, "2026-12-01T18:00:00Z"), [301]);
    await Promise.all([app.markAppointmentPaid(301), app.markAppointmentPaid(301)]);
    await app.markAppointmentPaid(301, 9900);
    assert.deepEqual(await ids(app, "2026-12-01T18:00:00Z"), []);
    const payments = fixture.select("SELECT id,date,amount_pence,service_id,service_name,income_kind FROM transactions");
    assert.equal(payments.length, 1);
    assert.deepEqual({ ...payments[0], id: undefined }, { id: undefined, date: "2026-12-01", amount_pence: 2200, service_id: "fixture-service", service_name: "Booked treatment", income_kind: "service" });
    assert.equal(fixture.select("SELECT transaction_id FROM appointments WHERE id=301")[0].transaction_id, payments[0].id);
    assert.equal(fixture.calls.includes("admin_request"), false, "Payment confirmation must not update the website or send a customer email");
  } finally { fixture.close(); }
});

test("unknown quoted amounts need an explicit received amount before leaving payment confirmations", async () => {
  const fixture = fixtureDatabase();
  try {
    const app = await application(fixture);
    appointment(fixture, 301, { price_pence: null });
    assert.deepEqual(await ids(app, "2026-12-01T18:00:00Z"), [301]);
    await assert.rejects(app.markAppointmentPaid(301), /amount received/i);
    assert.deepEqual(await ids(app, "2026-12-01T18:00:00Z"), [301]);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM transactions")[0].n, 0);
    await app.markAppointmentPaid(301, 1800);
    assert.deepEqual(await ids(app, "2026-12-01T18:00:00Z"), []);
    assert.equal(fixture.select("SELECT amount_pence FROM transactions")[0].amount_pence, 1800);
  } finally { fixture.close(); }
});
