import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { test } from "node:test";
import initSqlJs from "sql.js";
import ts from "typescript";

// All database access below is to a disposable, in-memory SQLite instance.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SQL = await initSqlJs();
const rust = await readFile(path.join(root, "src-tauri/src/lib.rs"), "utf8");
const migrations = [...rust.matchAll(/version:\s*(\d+),[\s\S]*?sql:\s*r#"([\s\S]*?)"#/g)]
  .map((match) => ({ version: Number(match[1]), sql: match[2] }));
const normalize = (value) => JSON.parse(JSON.stringify(value));
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
  } finally {
    statement.free();
  }
}

function execute(sqlite, sql, params = []) {
  sqlite.run(sql, bindings(sql, params));
  return {
    rowsAffected: sqlite.getRowsModified(),
    lastInsertId: Number(select(sqlite, "SELECT last_insert_rowid() AS id")[0].id),
  };
}

function fixtureDatabase({ legacy = false } = {}) {
  const sqlite = new SQL.Database();
  sqlite.run("PRAGMA foreign_keys = ON");
  for (const migration of migrations.filter((item) => !legacy || item.version <= 5)) {
    sqlite.run(migration.sql);
  }
  let tail = Promise.resolve();
  const serialized = (operation) => {
    const next = tail.then(operation);
    tail = next.catch(() => {});
    return next;
  };
  let failStatement = null;
  const db = {
    select: (sql, params) => serialized(() => select(sqlite, sql, params)),
    execute: (sql, params) => serialized(() => {
      failStatement?.(sql, params);
      return execute(sqlite, sql, params);
    }),
    batch: (statements) => serialized(() => {
      sqlite.run("BEGIN");
      try {
        const result = statements.map((statement) => {
          failStatement?.(statement.sql, statement.params);
          return execute(sqlite, statement.sql, statement.params);
        });
        sqlite.run("COMMIT");
        return result;
      } catch (error) {
        sqlite.run("ROLLBACK");
        throw error;
      }
    }),
  };
  return {
    sqlite,
    db,
    setFailure: (callback) => { failStatement = callback; },
    select: (sql, params) => select(sqlite, sql, params),
    execute: (sql, params) => execute(sqlite, sql, params),
    close: () => sqlite.close(),
  };
}

async function application(fixture, entry = "src/lib/db.ts") {
  assert.equal(typeof vm.SourceTextModule, "function", "Run with node --experimental-vm-modules --test tests/integration-security.mjs");
  const context = vm.createContext({
    console,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    window: { __TAURI_INTERNALS__: {}, addEventListener() {}, removeEventListener() {} },
  });
  const native = async (command, args = {}) => {
    switch (command) {
      case "db_select": return fixture.db.select(args.sql, args.params);
      case "db_execute": return fixture.db.execute(args.sql, args.params);
      case "db_batch": return fixture.db.batch(args.statements);
      case "access_status": return { state: fixture.accessState ?? "online", device_id: "fixture", device_name: "Fixture", expires_at: 2_000_000_000, error: null };
      case "admin_request":
        if (fixture.adminRequest) return fixture.adminRequest(args);
        throw new Error("Fixture does not permit network access");
      default: throw new Error(`Unexpected native command: ${command}`);
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
      const module = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context, identifier });
      return module;
    }
    const source = await readFile(identifier, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      fileName: identifier,
    }).outputText;
    const module = new vm.SourceTextModule(compiled, {
      context,
      identifier,
      initializeImportMeta(meta) { meta.env = { DEV: false }; },
      async importModuleDynamically(specifier, referencing) {
        const dependency = await linker(specifier, referencing);
        if (dependency.status === "unlinked") await dependency.link(linker);
        if (dependency.status === "linked") await dependency.evaluate();
        return dependency;
      },
    });
    return module;
  }
  function load(identifier) {
    if (!cache.has(identifier)) cache.set(identifier, instantiate(identifier));
    return cache.get(identifier);
  }
  const linker = async (specifier, referencing) => {
    if (mocks[specifier]) return load(specifier);
    const local = specifier.startsWith("@/")
      ? path.join(root, "src", specifier.slice(2))
      : path.resolve(path.dirname(referencing.identifier), specifier);
    if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
      mocks[specifier] = await import(specifier);
      return load(specifier);
    }
    return load(path.extname(local) ? local : `${local}.ts`);
  };
  const module = await load(path.join(root, entry));
  await module.link(linker);
  await module.evaluate();
  return module.namespace;
}

function seedAppointment(fixture, { status = "confirmed", price = 2500, paid = false } = {}) {
  fixture.execute("INSERT INTO clients(id, name, phone, notes) VALUES (101, 'Fixture Customer', '01234', 'Private client note')");
  if (paid) fixture.execute("INSERT INTO transactions(id, type, date, amount_pence, client_id, category_id, description) VALUES (201, 'income', '2026-09-30', 2500, 101, 1, 'Actual receipt')");
  fixture.execute("INSERT INTO appointments(id, date, start_time, duration_min, client_id, category_id, price_pence, notes, status, transaction_id, series_id) VALUES (301, '2026-09-30', '10:00', 30, 101, 1, ?, 'Private appointment note', ?, ?, 'fixture-series')", [price, status, paid ? 201 : null]);
  return 301;
}

function sharedFixture(fixture) {
  const clientId = "00000000-0000-4000-8000-000000000101";
  const appointmentId = "00000000-0000-4000-8000-000000000301";
  seedAppointment(fixture, { paid: true });
  fixture.execute("UPDATE clients SET remote_id = ? WHERE id = 101", [clientId]);
  fixture.execute("UPDATE appointments SET remote_id = ? WHERE id = 301", [appointmentId]);
  fixture.execute("UPDATE categories SET service_id = 'fixture-service' WHERE id = 1");
  const appointment = {
    id: appointmentId, client_id: clientId, service_id: "fixture-service", service_name: "Booked treatment",
    date: "2026-09-30", start_time: "10:00", duration_min: 30, price_pence: 2500,
    notes: "Customer requested a natural finish", status: "confirmed", revision: 1,
    proposed_date: null, proposed_start_time: null, series_id: "fixture-series",
    created_at: "2026-09-20T10:00:00Z", updated_at: "2026-09-20T10:00:00Z",
  };
  const service = { id: "fixture-service", name: "Current treatment name", description: "Fixture", duration_min: 45, price_pence: 4000, active: true, revision: 1 };
  const response = {
    snapshot: {
      clients: [{ id: clientId, account_id: null, name: "Shared customer name", email: "fixture@example.test", phone: "01234", disabled: false, revision: 1, updated_at: "2026-09-20T10:00:00Z" }],
      appointments: [appointment], services: [service], blocks: [],
      settings: { booking_enabled: false, timezone: "Europe/London", slot_minutes: 30, horizon_days: 90, opening_hours: [], revision: 1 },
      cursor: 1,
    },
    changes: [], cursor: 1, has_more: false,
  };
  return { appointment, service, response };
}

test("upgrade retains diary identities, private notes and actual income", () => {
  const fixture = fixtureDatabase({ legacy: true });
  try {
    seedAppointment(fixture, { status: "paid", paid: true });
    fixture.execute("INSERT INTO appointments(id, date, start_time, duration_min, client_id, category_id, price_pence, notes, status) VALUES (302, '2026-10-01', '10:00', 30, 101, 1, 3000, 'Unpaid booking', 'booked')");
    fixture.execute("INSERT INTO appointments(id, date, start_time, duration_min, client_id, status) VALUES (303, '2026-10-01', '11:00', 30, 101, 'cancelled'), (304, '2026-10-01', '12:00', 30, 101, 'no_show')");
    assert.ok(migrations.some((item) => item.version >= 6), "A cloud migration must follow legacy schema v5");
    for (const migration of migrations.filter((item) => item.version > 5)) fixture.sqlite.run(migration.sql);
    const rows = fixture.select("SELECT id, status, transaction_id, notes, series_id FROM appointments ORDER BY id");
    assert.deepEqual(rows.map((row) => [row.id, row.status, row.transaction_id]), [[301, "confirmed", 201], [302, "confirmed", null], [303, "cancelled", null], [304, "no_show", null]]);
    assert.equal(rows[0].notes, "Private appointment note");
    assert.equal(rows[0].series_id, "fixture-series");
    assert.equal(fixture.select("SELECT amount_pence FROM transactions WHERE id = 201")[0].amount_pence, 2500);
    assert.deepEqual(fixture.select("PRAGMA foreign_key_check"), []);
  } finally { fixture.close(); }
});

test("payment is exactly once and changes no booking status", async () => {
  const fixture = fixtureDatabase();
  try {
    const id = seedAppointment(fixture);
    const app = await application(fixture);
    await Promise.all([app.markAppointmentPaid(id), app.markAppointmentPaid(id)]);
    const appointment = await app.getAppointment(id);
    assert.equal(appointment.status, "confirmed");
    assert.ok(appointment.transaction_id > 0);
    assert.equal(fixture.select("SELECT COUNT(*) AS count FROM transactions")[0].count, 1);
    assert.equal(fixture.select("SELECT amount_pence FROM transactions")[0].amount_pence, 2500);
  } finally { fixture.close(); }
});

test("an interrupted payment never leaves an unlinked income entry", async () => {
  const fixture = fixtureDatabase();
  try {
    const id = seedAppointment(fixture);
    const app = await application(fixture);
    fixture.setFailure((sql) => {
      if (/UPDATE\s+appointments/i.test(sql) && /transaction_id/i.test(sql)) throw new Error("Fixture interrupted payment link");
    });
    await assert.rejects(app.markAppointmentPaid(id), /Fixture interrupted payment link/);
    assert.equal(fixture.select("SELECT COUNT(*) AS count FROM transactions")[0].count, 0);
    assert.equal(fixture.select("SELECT transaction_id FROM appointments WHERE id = ?", [id])[0].transaction_id, null);
  } finally { fixture.close(); }
});

test("recorded income edits preserve the shared quote and unpaid preserves cancellation", async () => {
  const fixture = fixtureDatabase();
  try {
    const id = seedAppointment(fixture, { status: "cancelled", price: 3000, paid: true });
    const app = await application(fixture);
    await app.updateTransaction(201, { type: "income", date: "2026-09-30", amount_pence: 4200, category_id: 1, client_id: 101, description: "Corrected receipt" });
    assert.equal((await app.getAppointment(id)).price_pence, 3000);
    await assert.rejects(app.updateTransaction(201, { type: "expense", date: "2026-09-30", amount_pence: 4200, category_id: 1, client_id: 101, description: "Invalid payment conversion" }), /must remain an income entry/);
    assert.equal(fixture.select("SELECT type FROM transactions WHERE id=201")[0].type, "income");
    await app.markAppointmentUnpaid(id);
    const appointment = await app.getAppointment(id);
    assert.equal(appointment.status, "cancelled");
    assert.equal(appointment.transaction_id, null);
    assert.equal(fixture.select("SELECT COUNT(*) AS count FROM transactions")[0].count, 0);
  } finally { fixture.close(); }
});

test("only confirmed unpaid bookings are owed, regardless of quoted value", async () => {
  const fixture = fixtureDatabase();
  try {
    const app = await application(fixture);
    for (const status of ["pending", "rejected", "cancelled", "no_show"]) {
      assert.equal(app.isOwed({ status, transaction_id: null }), false, status);
    }
    assert.equal(app.isOwed({ status: "confirmed", transaction_id: null }), true);
    assert.equal(app.isOwed({ status: "confirmed", transaction_id: 201 }), false);
  } finally { fixture.close(); }
});

test("failed receipt deletion cannot turn a recorded appointment unpaid", async () => {
  const fixture = fixtureDatabase();
  try {
    const id = seedAppointment(fixture, { status: "cancelled", paid: true });
    const app = await application(fixture);
    fixture.setFailure((sql) => {
      if (/DELETE\s+FROM\s+transactions/i.test(sql)) throw new Error("Fixture interrupted receipt deletion");
    });
    await assert.rejects(app.deleteTransaction(201), /Fixture interrupted receipt deletion/);
    assert.equal((await app.getAppointment(id)).transaction_id, 201);
    assert.equal(fixture.select("SELECT amount_pence FROM transactions WHERE id = 201")[0].amount_pence, 2500);
  } finally { fixture.close(); }
});

test("cloud cancellation and service archival preserve identities, quotes and recorded money", async () => {
  const fixture = fixtureDatabase();
  try {
    const { appointment, service, response } = sharedFixture(fixture);
    const sync = await application(fixture, "src/lib/sync.ts");
    await sync.applySyncResponse(response);
    assert.equal(fixture.select("SELECT COUNT(*) AS count FROM clients")[0].count, 1);
    assert.equal(fixture.select("SELECT COUNT(*) AS count FROM appointments")[0].count, 1);
    assert.equal(fixture.select("SELECT notes FROM clients WHERE id = 101")[0].notes, "Private client note");
    await sync.applySyncResponse({ snapshot: null, changes: [{ sequence: 2, entity: "service", id: service.id, record: { ...service, name: "Renamed treatment", duration_min: 60, price_pence: 6000, active: false, revision: 2 } }], cursor: 2, has_more: false });
    const quoted = fixture.select("SELECT service_name, duration_min, price_pence FROM appointments WHERE id = 301")[0];
    assert.deepEqual(quoted, { service_name: "Booked treatment", duration_min: 30, price_pence: 2500 });
    await sync.applySyncResponse({ snapshot: null, changes: [{ sequence: 3, entity: "appointment", id: appointment.id, record: { ...appointment, status: "cancelled", revision: 2 } }], cursor: 3, has_more: false });
    const row = fixture.select("SELECT id, client_id, notes, customer_notes, status, transaction_id FROM appointments WHERE id = 301")[0];
    assert.deepEqual(row, { id: 301, client_id: 101, notes: "Private appointment note", customer_notes: appointment.notes, status: "cancelled", transaction_id: 201 });
    assert.equal(fixture.select("SELECT amount_pence FROM transactions WHERE id = 201")[0].amount_pence, 2500);
    assert.equal((await sync.listServices())[0].active, false);
  } finally { fixture.close(); }
});

test("a failed mirror cursor commit rolls back every downloaded change", async () => {
  const fixture = fixtureDatabase();
  try {
    const { appointment, response } = sharedFixture(fixture);
    const sync = await application(fixture, "src/lib/sync.ts");
    await sync.applySyncResponse(response);
    fixture.setFailure((sql) => {
      if (/INSERT\s+INTO\s+sync_state/i.test(sql)) throw new Error("Fixture interrupted cursor commit");
    });
    await assert.rejects(sync.applySyncResponse({ snapshot: null, changes: [{ sequence: 2, entity: "appointment", id: appointment.id, record: { ...appointment, status: "cancelled", revision: 2 } }], cursor: 2, has_more: false }), /Fixture interrupted cursor commit/);
    assert.equal(fixture.select("SELECT status FROM appointments WHERE id = 301")[0].status, "confirmed");
    assert.equal(fixture.select("SELECT value FROM sync_state WHERE key = 'cursor'")[0].value, "1");
  } finally { fixture.close(); }
});

test("a lost account-link response reconciles local history through sync only, once", async () => {
  const fixture = fixtureDatabase();
  try {
    const { appointment, response } = sharedFixture(fixture);
    const source = { ...response.snapshot.clients[0], merged_into: null };
    const targetId = "00000000-0000-4000-8000-000000000102";
    const accountId = "00000000-0000-4000-8000-000000000501";
    const target = { ...source, id: targetId, account_id: accountId, name: "Account customer", email: "account@example.test", merged_into: null };
    fixture.execute("INSERT INTO clients(id, remote_id, account_id, name, email, notes) VALUES (102, ?, ?, 'Account customer', 'account@example.test', 'Account-side private note')", [targetId, accountId]);
    response.snapshot.clients = [source, target];
    const initial = await application(fixture, "src/lib/sync.ts");
    await initial.applySyncResponse(response);

    const mergedSource = { ...source, disabled: true, merged_into: targetId, revision: 2 };
    const mergedTarget = { ...target, revision: 2 };
    const movedAppointment = { ...appointment, client_id: targetId, revision: 2 };
    let linkCalls = 0;
    fixture.adminRequest = ({ operation }) => {
      if (operation === "clients/link") {
        linkCalls += 1;
        throw new Error("Fixture lost the committed account-link response");
      }
      if (operation === "sync") return {
        snapshot: null,
        changes: [
          { sequence: 2, entity: "client", id: source.id, record: mergedSource },
          { sequence: 3, entity: "appointment", id: appointment.id, record: movedAppointment },
          { sequence: 4, entity: "client", id: targetId, record: mergedTarget },
        ],
        cursor: 4, has_more: false,
      };
      throw new Error(`Unexpected fixture admin operation: ${operation}`);
    };
    await assert.rejects(initial.linkClientAccount(101, accountId), /Fixture lost the committed account-link response/);

    const reopened = await application(fixture, "src/lib/sync.ts");
    await reopened.syncNow();
    assert.equal(linkCalls, 1, "The durable changefeed must resolve a lost link without receipt replay");
    assert.equal(fixture.select("SELECT client_id FROM transactions WHERE id=201")[0].client_id, 102);
    assert.deepEqual(fixture.select("SELECT id, client_id, transaction_id, notes FROM appointments WHERE id=301")[0], { id: 301, client_id: 102, transaction_id: 201, notes: "Private appointment note" });
    const linkedNotes = fixture.select("SELECT notes FROM clients WHERE id=102")[0].notes;
    assert.ok(linkedNotes.includes("Account-side private note"));
    assert.equal(linkedNotes.split("Private client note").length - 1, 1);

    const rebuilt = { ...response, cursor: 4, snapshot: { ...response.snapshot, cursor: 4, clients: [mergedSource, mergedTarget], appointments: [movedAppointment] } };
    await reopened.applySyncResponse(rebuilt);
    await reopened.applySyncResponse(rebuilt);
    assert.equal(fixture.select("SELECT notes FROM clients WHERE id=102")[0].notes, linkedNotes, "Repeated snapshots must not append linked notes again");
    assert.equal(fixture.select("SELECT COUNT(*) AS count FROM clients WHERE remote_id=?", [source.id])[0].count, 0, "A permanent cloud alias must not recreate a split customer record");
    assert.equal(fixture.select("SELECT COUNT(*) AS count FROM transactions")[0].count, 1);
  } finally { fixture.close(); }
});

test("lost import responses retry the same operation and retain paid local identities", async () => {
  const fixture = fixtureDatabase();
  try {
    seedAppointment(fixture, { paid: true });
    fixture.execute("UPDATE categories SET service_id = 'fixture-service' WHERE id = 1");
    fixture.execute("INSERT INTO cloud_services(id, data) VALUES ('fixture-service', ?)", [JSON.stringify({ id: "fixture-service", name: "Booked treatment", description: "Fixture", duration_min: 30, price_pence: 2500, active: true, revision: 1 })]);
    const imports = [];
    let lost = true;
    fixture.adminRequest = ({ operation, body }) => {
      if (operation === "import") {
        imports.push(normalize(body));
        if (lost) { lost = false; throw new Error("Fixture lost the committed import response"); }
        return { ok: true };
      }
      if (operation === "sync") {
        const imported = imports[0];
        return {
          snapshot: {
            clients: imported.clients.map((row) => ({ ...row, account_id: null, email: row.email ?? "", disabled: false, revision: 1, updated_at: "2026-10-01T10:00:00Z" })),
            appointments: imported.appointments.map((row) => ({ ...row, service_name: "Booked treatment", status: "confirmed", revision: 1, proposed_date: null, proposed_start_time: null, created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-01T10:00:00Z" })),
            services: [], blocks: [], settings: { booking_enabled: false, timezone: "Europe/London", slot_minutes: 30, horizon_days: 90, opening_hours: [], revision: 1 }, cursor: 1,
          },
          changes: [], cursor: 1, has_more: false,
        };
      }
      throw new Error(`Unexpected fixture admin operation: ${operation}`);
    };
    const sync = await application(fixture, "src/lib/sync.ts");
    const selection = { clientIds: [101], appointmentIds: [301] };
    await assert.rejects(sync.importLegacyRecords(selection), /Fixture lost the committed import response/);
    assert.equal(fixture.select("SELECT transaction_id FROM appointments WHERE id = 301")[0].transaction_id, 201);
    await sync.importLegacyRecords(selection);
    assert.equal(imports.length, 2);
    assert.deepEqual(imports[1], imports[0], "Retry must reuse every committed UUID and operation ID");
    assert.equal(imports[0].clients[0].email, "", "Legacy clients may have no email");
    assert.equal(imports[0].appointments[0].notes, "", "Staff notes must not be uploaded");
    assert.equal(fixture.select("SELECT COUNT(*) AS count FROM clients")[0].count, 1);
    assert.equal(fixture.select("SELECT COUNT(*) AS count FROM appointments")[0].count, 1);
    assert.equal(fixture.select("SELECT remote_id FROM clients WHERE id = 101")[0].remote_id, imports[0].clients[0].id);
    assert.equal(fixture.select("SELECT remote_id FROM appointments WHERE id = 301")[0].remote_id, imports[0].appointments[0].id);
    assert.equal(fixture.select("SELECT transaction_id, notes FROM appointments WHERE id = 301")[0].transaction_id, 201);
    assert.equal(fixture.select("SELECT transaction_id, notes FROM appointments WHERE id = 301")[0].notes, "Private appointment note");
  } finally { fixture.close(); }
});

test("offline accounting remains available while shared changes are refused", async () => {
  const fixture = fixtureDatabase();
  try {
    fixture.accessState = "offline";
    const id = seedAppointment(fixture);
    const app = await application(fixture);
    await app.markAppointmentPaid(id, 1800);
    assert.equal((await app.getAppointment(id)).price_pence, 2500);
    assert.equal((await app.getAppointment(id)).paid_amount_pence, 1800);
    await assert.rejects(app.createClient({ name: "Offline customer" }), /online connection/i);
    assert.equal(fixture.select("SELECT COUNT(*) AS count FROM clients")[0].count, 1);
  } finally { fixture.close(); }
});

test("a shared create survives reopening without duplicate IDs or uploaded private notes", async () => {
  const fixture = fixtureDatabase();
  try {
    const calls = [];
    let lost = true;
    fixture.adminRequest = ({ operation, body }) => {
      if (operation === "clients") {
        calls.push(normalize(body));
        if (lost) { lost = false; throw new Error("Fixture lost the committed customer response"); }
        return { client: { ...body, account_id: null, disabled: false, revision: 1 } };
      }
      if (operation === "sync") {
        const created = calls[0];
        return {
          snapshot: {
            clients: [{ id: created.id, account_id: null, name: created.name, email: created.email, phone: created.phone, disabled: false, revision: 1, updated_at: "2026-10-01T10:00:00Z" }],
            appointments: [], services: [], blocks: [],
            settings: { booking_enabled: false, timezone: "Europe/London", slot_minutes: 30, horizon_days: 90, opening_hours: [], revision: 1 }, cursor: 1,
          },
          changes: [], cursor: 1, has_more: false,
        };
      }
      throw new Error(`Unexpected fixture admin operation: ${operation}`);
    };
    const input = { name: "Fixture new customer", email: "new@example.test", phone: "01234", notes: "Staff-only customer note" };
    const initial = await application(fixture);
    await assert.rejects(initial.createClient(input), /Fixture lost the committed customer response/);
    assert.equal(fixture.select("SELECT COUNT(*) AS count FROM clients")[0].count, 0);
    assert.equal(fixture.select("SELECT COUNT(*) AS count FROM sync_state WHERE key='mutation-pending'")[0].count, 1);
    await assert.rejects(initial.createClient({ ...input, name: "Different customer" }), /Retry the previous shared change/);
    assert.equal(calls.length, 1, "An unrelated create cannot overwrite an unresolved operation");

    const reopened = await application(fixture);
    const localId = await reopened.createClient(input);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0], "Reopening must reuse the exact remote ID and operation ID");
    assert.equal("notes" in calls[0], false, "Private notes must stay outside the cloud mutation");
    assert.equal(fixture.select("SELECT COUNT(*) AS count FROM clients")[0].count, 1);
    assert.equal(fixture.select("SELECT remote_id, notes FROM clients WHERE id=?", [localId])[0].remote_id, calls[0].id);
    assert.equal(fixture.select("SELECT remote_id, notes FROM clients WHERE id=?", [localId])[0].notes, input.notes);
    assert.equal(fixture.select("SELECT COUNT(*) AS count FROM sync_state WHERE key='mutation-pending'")[0].count, 0);
  } finally { fixture.close(); }
});

test("backups export only business data and accept legacy payment linkage safely", async () => {
  const fixture = fixtureDatabase();
  try {
    seedAppointment(fixture, { paid: true });
    const app = await application(fixture);
    const backup = normalize(await app.exportAll());
    assert.equal(backup.version, 3);
    assert.deepEqual(Object.keys(backup).sort(), ["app", "appointments", "categories", "clients", "exported_at", "transactions", "version"]);
    assert.equal(app.validateBackup(backup), true, "The app's own exported data must be restorable");
    const legacy = { ...backup, version: 2, appointments: backup.appointments.map((row) => ({ ...row, status: "paid" })) };
    const normalized = normalize(app.normalizeBackup(legacy));
    assert.equal(normalized.appointments[0].status, "confirmed");
    assert.equal(normalized.appointments[0].transaction_id, 201);
    assert.equal(normalized.appointments[0].notes, "Private appointment note");
    assert.equal(normalized.clients[0].notes, "Private client note");
    assert.equal(app.validateBackup({ ...backup, version: 99 }), false);
    assert.equal(app.validateBackup({ ...backup, transactions: [{ ...backup.transactions[0], amount_pence: -1 }] }), false);
    assert.equal(app.validateBackup({ ...backup, appointments: [{ ...backup.appointments[0], transaction_id: 999999 }] }), false);
    assert.equal(app.validateBackup({ ...backup, appointments: [backup.appointments[0], { ...backup.appointments[0], id: 302 }] }), false, "One receipt cannot pay two appointments");
    assert.equal(app.validateBackup({ ...backup, transactions: [{ ...backup.transactions[0], type: "expense" }] }), false, "An expense is not an appointment payment");
  } finally { fixture.close(); }
});

test("restoring an invalid backup leaves current data intact", async () => {
  const fixture = fixtureDatabase();
  try {
    seedAppointment(fixture, { paid: true });
    const app = await application(fixture);
    const before = normalize(await app.exportAll());
    await assert.rejects(app.restoreAll({ ...before, clients: [{ ...before.clients[0], id: -5 }] }));
    const after = normalize(await app.exportAll());
    delete before.exported_at;
    delete after.exported_at;
    assert.deepEqual(after, before);
  } finally { fixture.close(); }
});

test("an interrupted valid restore rolls back its deletes and replacement rows", async () => {
  const fixture = fixtureDatabase();
  try {
    seedAppointment(fixture, { paid: true });
    const app = await application(fixture);
    const before = normalize(await app.exportAll());
    const replacement = normalize(before);
    replacement.clients[0].name = "Replacement customer";
    replacement.transactions[0].amount_pence = 9900;
    fixture.setFailure((sql) => {
      if (/INSERT\s+INTO\s+transactions/i.test(sql)) throw new Error("Fixture interrupted backup receipt restore");
    });
    await assert.rejects(app.restoreAll(replacement), /Fixture interrupted backup receipt restore/);
    const after = normalize(await app.exportAll());
    delete before.exported_at;
    delete after.exported_at;
    assert.deepEqual(after, before);
    assert.deepEqual(fixture.select("PRAGMA foreign_key_check"), []);
  } finally { fixture.close(); }
});

test("official frontend has no direct business SQL or filesystem capabilities", async () => {
  const capability = JSON.parse(await readFile(path.join(root, "src-tauri/capabilities/default.json"), "utf8"));
  const forbidden = capability.permissions.filter((permission) => /^(sql|fs):/.test(typeof permission === "string" ? permission : permission.identifier));
  assert.deepEqual(forbidden, [], "Business data must cross the native authorization guard");
});
