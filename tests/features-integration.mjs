import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { test } from "node:test";
import initSqlJs from "sql.js";
import ts from "typescript";

// Tests use actual desktop modules and migrations against disposable memory only.
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
  } finally { statement.free(); }
}

function fixtureDatabase({ through = Infinity } = {}) {
  const sqlite = new SQL.Database();
  sqlite.run("PRAGMA foreign_keys = ON");
  for (const migration of migrations.filter((item) => item.version <= through)) sqlite.run(migration.sql);
  let tail = Promise.resolve();
  let failure = null;
  const serialized = (operation) => {
    const next = tail.then(operation);
    tail = next.catch(() => {});
    return next;
  };
  const execute = (sql, params = []) => {
    failure?.(sql, params);
    sqlite.run(sql, bindings(sql, params));
    return { rowsAffected: sqlite.getRowsModified(), lastInsertId: Number(select(sqlite, "SELECT last_insert_rowid() AS id")[0].id) };
  };
  const db = {
    select: (sql, params) => serialized(() => select(sqlite, sql, params)),
    readBatch: (statements) => serialized(() => statements.map((statement) => select(sqlite, statement.sql, statement.params))),
    execute: (sql, params) => serialized(() => execute(sql, params)),
    batch: (statements) => serialized(() => {
      sqlite.run("BEGIN");
      try {
        const result = statements.map((statement) => {
          const result = execute(statement.sql, statement.params);
          if (statement.expectedRows != null && result.rowsAffected !== statement.expectedRows) throw new Error("The record changed. Refresh before trying again.");
          return result;
        });
        sqlite.run("COMMIT");
        return result;
      } catch (error) { sqlite.run("ROLLBACK"); throw error; }
    }),
  };
  return {
    sqlite, db, execute,
    select: (sql, params) => select(sqlite, sql, params),
    setFailure: (callback) => { failure = callback; },
    close: () => sqlite.close(),
  };
}

async function application(fixture, entry = "src/lib/db.ts") {
  assert.equal(typeof vm.SourceTextModule, "function", "Run with node --experimental-vm-modules --test tests/features-integration.mjs");
  const context = vm.createContext({
    console, crypto: webcrypto, TextEncoder, TextDecoder, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    window: { __TAURI_INTERNALS__: {}, addEventListener() {}, removeEventListener() {} },
  });
  const native = async (command, args = {}) => {
    switch (command) {
      case "db_select": return fixture.db.select(args.sql, args.params);
      case "db_read_batch": return fixture.db.readBatch(args.statements);
      case "db_execute": return fixture.db.execute(args.sql, args.params);
      case "db_batch": return fixture.db.batch(args.statements.map((statement, index) => ({ ...statement, expectedRows: args.expectedRows?.[index] })));
      case "access_status": return { state: fixture.accessState ?? "online", device_id: "fixture", device_name: "Fixture", expires_at: 2_000_000_000, error: null };
      case "admin_request":
        if (fixture.adminRequest) return fixture.adminRequest(args);
        throw new Error("This fixture forbids network access");
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
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context, identifier });
    }
    const source = await readFile(identifier, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX }, fileName: identifier,
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
  const module = await load(path.join(root, entry));
  await module.link(linker);
  await module.evaluate();
  return module.namespace;
}

const clientId = "00000000-0000-4000-8000-000000000101";
const appointmentId = "00000000-0000-4000-8000-000000000301";
const now = "2026-10-01T10:00:00Z";
function sharedRecords() {
  return {
    client: { id: clientId, account_id: "00000000-0000-4000-8000-000000000501", merged_into: null, name: "Feature Customer", email: "features@example.invalid", phone: "07000000000", saved_address: "1 Fixture Road\nLondon", saved_postcode: "SW1A 1AA", disabled: false, revision: 1, updated_at: now },
    service: { id: "feature-service", name: "Feature Tan", description: "Disposable fixture", duration_min: 45, price_pence: 2750, discount_percent: 20, booking_price_pence: 2200, active: true, revision: 1 },
    appointment: { id: appointmentId, client_id: clientId, service_id: "feature-service", service_name: "Feature Tan", date: "2026-10-10", start_time: "00:00", time_confirmed: false, duration_min: 45, price_pence: 2200, base_price_pence: 2750, discount_percent: 20, is_remote: true, visit_address: "2 One-off Road\nLondon", visit_postcode: "SW1A 2AA", notes: "Customer instruction", status: "confirmed", revision: 1, proposed_date: null, proposed_start_time: null, proposed_time_confirmed: null, series_id: null, created_at: now, updated_at: now },
  };
}
function snapshot({ clients = [], appointments = [], services = [], cursor = 1 } = {}) {
  return { snapshot: { clients, appointments, services, blocks: [], settings: { booking_enabled: true, timezone: "Europe/London", slot_minutes: 30, horizon_days: 90, opening_hours: [], revision: 1 }, cursor }, changes: [], cursor, has_more: false };
}

test("feature schema upgrades preserve pre-feature quotes and payment links", () => {
  const fixture = fixtureDatabase({ through: 6 });
  try {
    fixture.execute("INSERT INTO clients(id,name,notes) VALUES (101,'Existing customer','Private note')");
    fixture.execute("INSERT INTO transactions(id,type,date,amount_pence,client_id,category_id,description) VALUES (201,'income','2026-10-10',2500,101,1,'Existing receipt')");
    fixture.execute("INSERT INTO appointments(id,date,start_time,duration_min,client_id,category_id,price_pence,status,transaction_id) VALUES (301,'2026-10-10','10:00',45,101,1,2750,'confirmed',201)");
    assert.ok(migrations.some((migration) => migration.version > 6), "Feature migration must follow v6");
    for (const migration of migrations.filter((item) => item.version > 6)) fixture.sqlite.run(migration.sql);
    const row = fixture.select("SELECT id,date,start_time,duration_min,price_pence,transaction_id FROM appointments WHERE id=301")[0];
    assert.deepEqual(row, { id: 301, date: "2026-10-10", start_time: "10:00", duration_min: 45, price_pence: 2750, transaction_id: 201 });
    assert.equal(fixture.select("SELECT amount_pence FROM transactions WHERE id=201")[0].amount_pence, 2500);
    const defaults = fixture.select("SELECT time_confirmed,is_remote,visit_address,visit_postcode,base_price_pence,discount_percent FROM appointments WHERE id=301")[0];
    assert.deepEqual(defaults, { time_confirmed: 1, is_remote: 0, visit_address: "", visit_postcode: "", base_price_pence: 2750, discount_percent: 0 });
    assert.deepEqual(fixture.select("PRAGMA foreign_key_check"), []);
  } finally { fixture.close(); }
});

test("discounts round integer pence once and preserve every existing quote", async () => {
  const fixture = fixtureDatabase();
  try {
    const sync = await application(fixture, "src/lib/sync.ts");
    assert.equal(typeof sync.serviceDiscountPrice, "function");
    for (const [base, percent, expected] of [[2750, 20, 2200], [2751, 20, 2201], [1, 50, 1], [3, 50, 2], [2999, 33, 2009], [2750, 0, 2750], [2750, 100, 0]]) {
      assert.equal(sync.serviceDiscountPrice(base, percent), expected, `${base}p discounted ${percent}%`);
    }
    const { client, service, appointment } = sharedRecords();
    await sync.applySyncResponse(snapshot({ clients: [client], appointments: [appointment], services: [service] }));
    const before = fixture.select("SELECT service_name,duration_min,price_pence,base_price_pence,discount_percent FROM appointments")[0];
    await sync.applySyncResponse({ snapshot: null, changes: [{ sequence: 2, entity: "service", id: service.id, record: { ...service, price_pence: 4000, discount_percent: 50, booking_price_pence: 2000, duration_min: 60, revision: 2 } }], cursor: 2, has_more: false });
    assert.deepEqual(fixture.select("SELECT service_name,duration_min,price_pence,base_price_pence,discount_percent FROM appointments")[0], before);
    assert.equal((await sync.listServices())[0].booking_price_pence, 2000);
  } finally { fixture.close(); }
});

test("fully discounted appointments are never listed as money still owed", async () => {
  const fixture = fixtureDatabase();
  try {
    const app = await application(fixture);
    assert.equal(app.isOwed({ status: "confirmed", transaction_id: null, price_pence: 0 }), false);
    assert.equal(app.isOwed({ status: "confirmed", transaction_id: null, price_pence: null }), true);
    fixture.execute("INSERT INTO clients(id,name) VALUES (101,'Free fixture customer')");
    fixture.execute("INSERT INTO appointments(id,date,start_time,duration_min,client_id,price_pence,status,base_price_pence,discount_percent) VALUES (301,'2026-10-01','10:00',45,101,0,'confirmed',2750,100), (302,'2026-10-01','12:00',45,101,NULL,'confirmed',NULL,0)");
    assert.deepEqual(normalize(await app.unpaidBefore("2026-10-02")).map(row => row.id), [302]);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM transactions")[0].n, 0);
  } finally { fixture.close(); }
});

test("remote one-off addresses and saved addresses remain separate through mirror and backup", async () => {
  const fixture = fixtureDatabase();
  try {
    const { client, service, appointment } = sharedRecords();
    const sync = await application(fixture, "src/lib/sync.ts");
    const app = await application(fixture);
    await sync.applySyncResponse(snapshot({ clients: [client], appointments: [appointment], services: [service] }));
    const [row] = await app.listAppointments();
    const [customer] = await app.listClients();
    assert.equal(row.is_remote, 1);
    assert.equal(row.visit_address, appointment.visit_address);
    assert.equal(row.visit_postcode, appointment.visit_postcode);
    assert.equal(customer.saved_address, client.saved_address);
    assert.equal(customer.saved_postcode, client.saved_postcode);
    const backup = normalize(await app.exportAll());
    assert.equal(app.validateBackup(backup), true);
    const restored = normalize(app.normalizeBackup(backup));
    assert.equal(restored.appointments[0].visit_address, appointment.visit_address);
    assert.equal(restored.appointments[0].time_confirmed, 0);
    assert.equal(restored.appointments[0].base_price_pence, 2750);
    assert.equal(restored.appointments[0].discount_percent, 20);
    assert.equal(restored.clients[0].saved_address, client.saved_address);
    assert.equal(app.validateBackup({ ...backup, appointments: [{ ...backup.appointments[0], is_remote: 1, visit_postcode: "", visit_address: "" }] }), false, "A remote backup entry must retain a valid address");
  } finally { fixture.close(); }
});

test("confirmed date-only manual bookings never enter the requests inbox", async () => {
  const fixture = fixtureDatabase();
  try {
    const { client, service, appointment } = sharedRecords();
    const records = { clients: [client], appointments: [], services: [service] };
    const calls = [];
    let cursor = 1;
    fixture.adminRequest = ({ operation, method, body }) => {
      if (operation === "sync") return snapshot({ ...records, cursor });
      if (operation === "appointments" && method === "POST") {
        calls.push(normalize(body));
        records.appointments.push({ ...appointment, ...body, status: "confirmed" });
        cursor++;
        return { appointment: records.appointments[0] };
      }
      throw new Error(`Unexpected manual fixture request: ${operation}`);
    };
    const sync = await application(fixture, "src/lib/sync.ts");
    await sync.applySyncResponse(snapshot(records));
    const app = await application(fixture);
    const [customer] = await app.listClients();
    const id = await app.createAppointment({ date: appointment.date, start_time: "00:00", time_confirmed: false, duration_min: 45, client_id: customer.id, category_id: null, service_id: service.id, price_pence: 2200, base_price_pence: 2750, discount_percent: 20, notes: "Private admin instruction", customer_notes: "Shared instruction", is_remote: true, visit_address: appointment.visit_address, visit_postcode: appointment.visit_postcode });
    const row = await app.getAppointment(id);
    assert.equal(row.status, "confirmed");
    assert.equal(row.time_confirmed, 0);
    assert.equal(row.start_time, "00:00");
    assert.equal(row.is_remote, 1);
    assert.equal(calls[0].notes, "Shared instruction", "Private admin notes must not be uploaded");
    assert.equal(calls[0].status, "confirmed", "Manual wire requests must be explicitly confirmed");
    assert.equal(calls[0].time_confirmed, false);
    assert.equal(calls[0].visit_address, appointment.visit_address);
    assert.equal(calls[0].discount_percent, 20);
    assert.deepEqual(normalize(await sync.listPendingAppointments()), []);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM transactions")[0].n, 0);
  } finally { fixture.close(); }
});

test("requests contain customer pending bookings and proposals, not untimed confirmed diary entries", async () => {
  const fixture = fixtureDatabase();
  try {
    const { client, service, appointment } = sharedRecords();
    const entries = [
      appointment,
      { ...appointment, id: "00000000-0000-4000-8000-000000000302", status: "pending" },
      { ...appointment, id: "00000000-0000-4000-8000-000000000303", time_confirmed: true, start_time: "12:00", proposed_date: "2026-10-11", proposed_start_time: "00:00", proposed_time_confirmed: false },
      { ...appointment, id: "00000000-0000-4000-8000-000000000304", status: "cancelled" },
    ];
    const sync = await application(fixture, "src/lib/sync.ts");
    await sync.applySyncResponse(snapshot({ clients: [client], appointments: entries, services: [service] }));
    const inbox = normalize(await sync.listPendingAppointments());
    assert.deepEqual(inbox.map(row => row.remote_id), [entries[1].id, entries[2].id]);
    assert.equal(inbox[1].proposed_time_confirmed, 0);
  } finally { fixture.close(); }
});

async function paidMirror(fixture) {
  const records = sharedRecords();
  const sync = await application(fixture, "src/lib/sync.ts");
  await sync.applySyncResponse(snapshot({ clients: [records.client], appointments: [records.appointment], services: [records.service] }));
  const [client] = fixture.select("SELECT id FROM clients WHERE remote_id=?", [clientId]);
  const [appointment] = fixture.select("SELECT id FROM appointments WHERE remote_id=?", [appointmentId]);
  fixture.execute("UPDATE clients SET notes='Private customer detail' WHERE id=?", [client.id]);
  fixture.execute("UPDATE appointments SET notes='Private visit detail' WHERE id=?", [appointment.id]);
  fixture.execute("INSERT INTO transactions(id,type,date,amount_pence,client_id,category_id,description) VALUES (201,'income','2026-10-10',2100,?,1,'Private generated visit detail')", [client.id]);
  fixture.execute("INSERT INTO transactions(id,type,date,amount_pence,client_id,category_id,description) VALUES (202,'expense','2026-10-10',900,NULL,4,'Unrelated supplies')");
  fixture.execute("UPDATE appointments SET transaction_id=201 WHERE id=?", [appointment.id]);
  return { ...records, clientLocalId: client.id, appointmentLocalId: appointment.id, sync };
}

test("appointment tombstones physically remove booking details while preserving actual income", async () => {
  const fixture = fixtureDatabase();
  try {
    const { sync } = await paidMirror(fixture);
    await sync.applySyncResponse({ snapshot: null, changes: [{ sequence: 2, entity: "appointment", id: appointmentId, record: null }], cursor: 2, has_more: false });
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM appointments")[0].n, 0);
    assert.deepEqual(fixture.select("SELECT id,type,date,amount_pence,client_id,category_id,description FROM transactions WHERE id=201")[0], { id: 201, type: "income", date: "2026-10-10", amount_pence: 2100, client_id: null, category_id: 1, description: null });
    assert.equal(fixture.select("SELECT description FROM transactions WHERE id=202")[0].description, "Unrelated supplies");
    await sync.applySyncResponse(snapshot({ clients: [sharedRecords().client], services: [sharedRecords().service], cursor: 3 }));
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM appointments")[0].n, 0, "A snapshot must not resurrect the deleted booking");
    assert.deepEqual(fixture.select("PRAGMA foreign_key_check"), []);
  } finally { fixture.close(); }
});

test("account tombstones remove address, booking history and generated receipt details, not money", async () => {
  const fixture = fixtureDatabase();
  try {
    const { sync } = await paidMirror(fixture);
    fixture.execute("INSERT INTO sync_state(key,value) VALUES ('mutation-pending',?)", [JSON.stringify({ operation: "appointments", method: "PATCH", body: { client_id: clientId, id: appointmentId, notes: "Private pending customer detail", visit_address: "Private pending address" } })]);
    fixture.execute("INSERT INTO sync_state(key,value) VALUES ('import-pending',?)", [JSON.stringify({ selection: { clientIds: [1], appointmentIds: [1] }, body: { clients: [{ id: clientId, name: "Private pending customer detail" }], appointments: [{ id: appointmentId, client_id: clientId, visit_address: "Private pending address" }] } })]);
    fixture.execute("INSERT INTO sync_state(key,value) VALUES (?, '1'), (?, '1'), ('client-alias-private-guest', ?)", [`import-target-client-${clientId}`, `import-target-appointment-${appointmentId}`, clientId]);
    await sync.applySyncResponse({ snapshot: null, changes: [{ sequence: 2, entity: "client", id: clientId, record: null }, { sequence: 3, entity: "appointment", id: appointmentId, record: null }], cursor: 3, has_more: false });
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM clients")[0].n, 0);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM appointments")[0].n, 0);
    assert.deepEqual(fixture.select("SELECT amount_pence,date,client_id,category_id,description FROM transactions WHERE id=201")[0], { amount_pence: 2100, date: "2026-10-10", client_id: null, category_id: 1, description: null });
    assert.equal(fixture.select("SELECT description FROM transactions WHERE id=202")[0].description, "Unrelated supplies");
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM sync_state WHERE key='mutation-pending'")[0].n, 0);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM sync_state WHERE key='import-pending' OR key LIKE 'import-target-%' OR key='client-alias-private-guest'")[0].n, 0);
    const app = await application(fixture);
    const backup = JSON.stringify(await app.exportAll());
    for (const detail of ["Feature Customer", "features@example.invalid", "Fixture Road", "One-off Road", "Private customer detail", "Private visit detail"]) assert.equal(backup.includes(detail), false, detail);
    assert.deepEqual(fixture.select("PRAGMA foreign_key_check"), []);
  } finally { fixture.close(); }
});

test("restoring shared backup requires authoritative sync and failed fetch leaves every row unchanged", async () => {
  const fixture = fixtureDatabase();
  try {
    await paidMirror(fixture);
    const app = await application(fixture);
    const before = normalize(await app.exportAll());
    const replacement = normalize(before);
    replacement.clients[0].name = "Obsolete backup identity";
    fixture.adminRequest = ({ operation }) => {
      assert.equal(operation, "sync");
      throw new Error("Fixture authoritative snapshot unavailable");
    };
    await assert.rejects(app.restoreAll(replacement), /Fixture authoritative snapshot unavailable/);
    const after = normalize(await app.exportAll());
    delete before.exported_at;
    delete after.exported_at;
    assert.deepEqual(after, before);
    assert.equal(fixture.select("SELECT value FROM sync_state WHERE key='cursor'")[0].value, "1");
    fixture.accessState = "offline";
    await assert.rejects(app.restoreAll(replacement), /online/i);
    assert.equal(fixture.select("SELECT name FROM clients")[0].name, "Feature Customer");
  } finally { fixture.close(); }
});

test("restoring obsolete shared backup retains anonymized payments without restoring deleted identities", async () => {
  const fixture = fixtureDatabase();
  try {
    await paidMirror(fixture);
    const app = await application(fixture);
    const backup = normalize(await app.exportAll());
    let requests = 0;
    fixture.adminRequest = ({ operation, query }) => {
      assert.equal(operation, "sync");
      assert.ok(query == null || query.cursor == null, "Restore must fetch a full snapshot rather than incremental changes");
      requests++;
      return snapshot({ cursor: 10 });
    };
    await app.restoreAll(backup);
    assert.ok(requests >= 1);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM clients")[0].n, 0);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM appointments")[0].n, 0);
    assert.deepEqual(fixture.select("SELECT amount_pence,date,category_id,client_id,description FROM transactions WHERE id=201")[0], { amount_pence: 2100, date: "2026-10-10", category_id: 1, client_id: null, description: null });
    assert.equal(fixture.select("SELECT description FROM transactions WHERE id=202")[0].description, "Unrelated supplies");
    assert.equal(fixture.select("SELECT value FROM sync_state WHERE key='cursor'")[0].value, "10");
    assert.deepEqual(fixture.select("PRAGMA foreign_key_check"), []);
  } finally { fixture.close(); }
});

test("authoritative backup restore reconciles and replaces in one transaction", async () => {
  const fixture = fixtureDatabase();
  try {
    await paidMirror(fixture);
    const app = await application(fixture);
    const before = normalize(await app.exportAll());
    fixture.adminRequest = () => snapshot({ cursor: 10 });
    fixture.setFailure(sql => { if (/INSERT\s+INTO\s+transactions/i.test(sql)) throw new Error("Fixture interrupted shared restore"); });
    await assert.rejects(app.restoreAll(before), /Fixture interrupted shared restore/);
    const after = normalize(await app.exportAll());
    delete before.exported_at;
    delete after.exported_at;
    assert.deepEqual(after, before);
    assert.equal(fixture.select("SELECT value FROM sync_state WHERE key='cursor'")[0].value, "1");
    assert.equal(fixture.select("SELECT description FROM transactions WHERE id=201")[0].description, "Private generated visit detail");
  } finally { fixture.close(); }
});

test("snapshot absence converges on destructive account deletion even after missed changefeed", async () => {
  const fixture = fixtureDatabase();
  try {
    const { sync } = await paidMirror(fixture);
    await sync.applySyncResponse(snapshot({ cursor: 10 }));
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM clients")[0].n, 0);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM appointments")[0].n, 0);
    assert.deepEqual(fixture.select("SELECT amount_pence,client_id,description FROM transactions WHERE id=201")[0], { amount_pence: 2100, client_id: null, description: null });
    assert.equal(fixture.select("SELECT description FROM transactions WHERE id=202")[0].description, "Unrelated supplies");
  } finally { fixture.close(); }
});

test("interrupted deletion mirror rolls back anonymization and row deletion together", async () => {
  const fixture = fixtureDatabase();
  try {
    const { sync } = await paidMirror(fixture);
    fixture.setFailure(sql => { if (/INSERT\s+INTO\s+sync_state/i.test(sql) && /cursor/.test(sql)) throw new Error("Fixture interrupted deletion cursor"); });
    await assert.rejects(sync.applySyncResponse({ snapshot: null, changes: [{ sequence: 2, entity: "appointment", id: appointmentId, record: null }], cursor: 2, has_more: false }), /Fixture interrupted deletion cursor/);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM appointments")[0].n, 1);
    assert.equal(fixture.select("SELECT description FROM transactions WHERE id=201")[0].description, "Private generated visit detail");
    assert.equal(fixture.select("SELECT value FROM sync_state WHERE key='cursor'")[0].value, "1");
  } finally { fixture.close(); }
});

async function lostImportFixture(fixture) {
  const { service } = sharedRecords();
  fixture.execute("INSERT INTO clients(id,name,phone,notes) VALUES (101,'Legacy privacy customer','07000000000','Private customer instruction')");
  fixture.execute("INSERT INTO cloud_services(id,data) VALUES (?,?)", [service.id, JSON.stringify(service)]);
  fixture.execute("INSERT INTO transactions(id,type,date,amount_pence,client_id,category_id,description) VALUES (201,'income','2026-10-10',2100,101,1,'Private generated legacy visit')");
  fixture.execute("INSERT INTO appointments(id,date,start_time,duration_min,client_id,category_id,price_pence,notes,status,transaction_id,series_id) VALUES (301,'2026-10-10','10:00',45,101,1,2200,'Private legacy visit','confirmed',201,'legacy-privacy-series')");
  const imports = [];
  const deletions = [];
  let fail = true;
  let failReplay = "";
  let cursor = 1;
  const records = { clients: [], appointments: [], services: [service] };
  fixture.adminRequest = ({ operation, method, body }) => {
    if (operation === "import") {
      imports.push(normalize(body));
      if (failReplay) throw new Error(failReplay);
      records.clients = body.clients.map(client => ({ ...client, saved_address: "", saved_postcode: "", account_id: null, merged_into: null, disabled: false, revision: 1, updated_at: now }));
      records.appointments = body.appointments.map(appointment => ({ ...appointment, service_name: service.name, time_confirmed: true, is_remote: false, visit_address: "", visit_postcode: "", base_price_pence: 2200, discount_percent: 0, status: "confirmed", revision: 1, proposed_date: null, proposed_start_time: null, proposed_time_confirmed: null, created_at: now, updated_at: now }));
      cursor++;
      if (fail) { fail = false; throw new Error("Fixture lost committed import response"); }
      return { ok: true };
    }
    if (operation === "sync") return snapshot({ ...records, cursor });
    if (method === "DELETE" && operation === "clients") {
      deletions.push({ operation, body: normalize(body) });
      records.clients = records.clients.filter(client => client.id !== body.id);
      records.appointments = records.appointments.filter(appointment => appointment.client_id !== body.id);
      cursor++;
      return { ok: true };
    }
    if (method === "DELETE" && operation === "appointments") {
      deletions.push({ operation, body: normalize(body) });
      records.appointments = records.appointments.filter(appointment => appointment.id !== body.id);
      cursor++;
      return { ok: true };
    }
    throw new Error(`Unexpected legacy deletion request: ${operation} ${method}`);
  };
  const sync = await application(fixture, "src/lib/sync.ts");
  const app = await application(fixture);
  await app.resolveLegacyIncomeCategory(1, service.id);
  await assert.rejects(sync.importLegacyRecords({ clientIds: [101], appointmentIds: [301] }), /Fixture lost committed import response/);
  return { sync, imports, deletions, records, failReplay: (message = "Fixture import reconciliation unavailable") => { failReplay = message; } };
}

for (const scope of ["client", "appointment", "series"]) test(`legacy ${scope} deletion resolves a lost import before deleting the stable shared identity`, async () => {
  const fixture = fixtureDatabase();
  try {
    const { sync, imports, deletions, records } = await lostImportFixture(fixture);
    const app = await application(fixture);
    if (scope === "client") await app.deleteClient(101);
    else if (scope === "appointment") await app.deleteAppointment(301);
    else await app.deleteAppointmentSeries("legacy-privacy-series", "2026-10-10");
    assert.equal(imports.length, 2, "Deletion must first resolve the committed import response");
    assert.deepEqual(imports[1], imports[0], "Reconciliation must reuse all stable UUIDs and operation IDs");
    assert.equal(deletions.length, 1);
    assert.equal(deletions[0].operation, scope === "client" ? "clients" : "appointments");
    assert.equal(deletions[0].body.id, scope === "client" ? imports[0].clients[0].id : imports[0].appointments[0].id);
    assert.equal(records.appointments.length, 0);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM appointments")[0].n, 0);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM clients")[0].n, scope === "client" ? 0 : 1);
    assert.deepEqual(fixture.select("SELECT amount_pence,date,category_id,client_id,description FROM transactions WHERE id=201")[0], { amount_pence: 2100, date: "2026-10-10", category_id: 1, client_id: null, description: null });
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM sync_state WHERE key='import-pending' OR key LIKE 'import-target-%'")[0].n, 0);
    await sync.syncNow();
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM appointments")[0].n, 0, "Later sync must not resurrect the deleted legacy visit");
  } finally { fixture.close(); }
});

test("offline or failed reconciliation blocks local deletion after an uncertain committed import", async () => {
  const fixture = fixtureDatabase();
  try {
    const { failReplay, deletions } = await lostImportFixture(fixture);
    const app = await application(fixture);
    fixture.accessState = "offline";
    await assert.rejects(app.deleteClient(101), /Reconnect and retry the reviewed import/);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM clients")[0].n, 1);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM appointments")[0].n, 1);
    fixture.accessState = "online";
    failReplay();
    await assert.rejects(app.deleteAppointment(301), /Reconnect and retry the reviewed import/);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM appointments")[0].n, 1);
    assert.equal(fixture.select("SELECT description FROM transactions WHERE id=201")[0].description, "Private generated legacy visit");
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM sync_state WHERE key='import-pending'")[0].n, 1, "Uncertain committed import must remain reconcilable");
    assert.deepEqual(deletions, []);
  } finally { fixture.close(); }
});

test("a deletion wins concurrent stale snapshots and terminal IDs cannot be recreated by later replay", async () => {
  const fixture = fixtureDatabase();
  try {
    const { sync, client, appointment, service } = await paidMirror(fixture);
    const deletion = { snapshot: null, changes: [{ sequence: 2, entity: "client", id: clientId, record: null }, { sequence: 3, entity: "appointment", id: appointmentId, record: null }], cursor: 3, has_more: false };
    const obsolete = snapshot({ clients: [client], appointments: [appointment], services: [service], cursor: 2 });
    await Promise.allSettled([sync.applySyncResponse(deletion), sync.applySyncResponse(obsolete)]);
    assert.equal(fixture.select("SELECT value FROM sync_state WHERE key='cursor'")[0].value, "3");
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM clients")[0].n, 0);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM appointments")[0].n, 0);
    await sync.applySyncResponse(snapshot({ clients: [client], appointments: [appointment], services: [service], cursor: 4 }));
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM clients")[0].n, 0, "Terminal customer IDs cannot be recreated by old receipts");
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM appointments")[0].n, 0);
    assert.deepEqual(fixture.select("SELECT amount_pence,client_id,description FROM transactions WHERE id=201")[0], { amount_pence: 2100, client_id: null, description: null });
  } finally { fixture.close(); }
});

test("an external tombstone resolves pending import targets even before local rows gain remote IDs", async () => {
  const fixture = fixtureDatabase();
  try {
    const { sync, imports, records } = await lostImportFixture(fixture);
    const imported = imports[0];
    records.clients = [];
    records.appointments = [];
    await sync.applySyncResponse({ snapshot: null, changes: [{ sequence: 2, entity: "client", id: imported.clients[0].id, record: null }, { sequence: 3, entity: "appointment", id: imported.appointments[0].id, record: null }], cursor: 3, has_more: false });
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM clients")[0].n, 0);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM appointments")[0].n, 0);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM sync_state WHERE key='import-pending' OR key LIKE 'import-target-%'")[0].n, 0);
    assert.deepEqual(fixture.select("SELECT amount_pence,client_id,description FROM transactions WHERE id=201")[0], { amount_pence: 2100, client_id: null, description: null });
    assert.deepEqual(fixture.select("PRAGMA foreign_key_check"), []);
  } finally { fixture.close(); }
});

test("ambiguous import conflict retains stable reconciliation identities instead of generating duplicates", async () => {
  const fixture = fixtureDatabase();
  try {
    const { sync, imports, failReplay } = await lostImportFixture(fixture);
    const before = fixture.select("SELECT key,value FROM sync_state WHERE key='import-pending' OR key LIKE 'import-target-%' ORDER BY key");
    failReplay("409: Fixture import conflict");
    await assert.rejects(sync.importLegacyRecords({ clientIds: [101], appointmentIds: [301] }), /409: Fixture import conflict/);
    assert.deepEqual(imports[1], imports[0]);
    assert.deepEqual(fixture.select("SELECT key,value FROM sync_state WHERE key='import-pending' OR key LIKE 'import-target-%' ORDER BY key"), before);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM clients")[0].n, 1);
    assert.equal(fixture.select("SELECT COUNT(*) AS n FROM appointments")[0].n, 1);
  } finally { fixture.close(); }
});

test("shared service bookings and payments need no income category and preserve snapshots after catalogue edits", async () => {
  const fixture = fixtureDatabase();
  try {
    const sync = await application(fixture, "src/lib/sync.ts");
    const app = await application(fixture);
    const { client, service, appointment } = sharedRecords();
    await sync.applySyncResponse(snapshot({ clients: [client], appointments: [appointment], services: [service] }));
    const [booked] = await app.listAppointments();
    assert.equal(booked.category_id, null);
    await app.markAppointmentPaid(booked.id, 2100);
    const [payment] = await app.listTransactions();
    assert.equal(payment.category_id, null);
    assert.equal(payment.service_id, service.id);
    assert.equal(payment.service_name, appointment.service_name);
    assert.equal(payment.income_kind, "service");
    assert.equal(payment.amount_pence, 2100);
    const renamed = { ...service, name: "Renamed catalogue treatment", price_pence: 4000, discount_percent: 30, revision: 2 };
    await sync.applySyncResponse(snapshot({ clients: [client], appointments: [appointment], services: [renamed], cursor: 2 }));
    await app.createTransaction({ type: "income", date: appointment.date, amount_pence: 2700, client_id: null, category_id: null, description: null, service_id: service.id, income_kind: "service" });
    const totals = await app.incomeTotals("2026-10-01", "2026-10-31");
    assert.equal(totals.length, 1, "Renaming a service must not split its report total");
    assert.equal(totals[0].total, 4800);
    const original = await app.getTransaction(payment.id);
    assert.equal(original.service_name, appointment.service_name);
    assert.equal(original.amount_pence, 2100);
    await sync.applySyncResponse(snapshot({ clients: [client], appointments: [appointment], services: [{ ...renamed, active: false, revision: 3 }], cursor: 3 }));
    assert.equal((await app.getTransaction(payment.id)).service_name, appointment.service_name);
    assert.equal((await app.getAppointment(booked.id)).price_pence, 2200);
    await sync.applySyncResponse({ snapshot: null, changes: [{ sequence: 4, entity: "client", id: client.id, record: null }], cursor: 4, has_more: false });
    const anonymized = await app.getTransaction(payment.id);
    assert.equal(anonymized.client_id, null);
    assert.equal(anonymized.description, null);
    assert.equal(anonymized.service_id, service.id);
    assert.equal(anonymized.service_name, appointment.service_name);
    assert.equal(anonymized.amount_pence, 2100);
  } finally { fixture.close(); }
});

test("legacy import reconciliation adds service identity without rewriting saved appointment or payment labels", async () => {
  const fixture = fixtureDatabase();
  try {
    const sync = await application(fixture, "src/lib/sync.ts");
    const { client, service, appointment } = sharedRecords();
    fixture.execute("INSERT INTO clients(id,name,remote_id) VALUES (101,'Legacy customer',?)", [client.id]);
    fixture.execute("INSERT INTO transactions(id,type,date,amount_pence,category_id,category_name_snapshot,income_kind) VALUES (201,'income','2026-10-10',2100,1,'Original legacy treatment','legacy')");
    fixture.execute("INSERT INTO appointments(id,date,start_time,price_pence,status,transaction_id,client_id,remote_id,service_id,service_name) VALUES (301,'2026-10-10','00:00',2200,'confirmed',201,101,?,?,'Original legacy treatment')", [appointment.id, service.id]);
    await sync.applySyncResponse(snapshot({ clients: [client], appointments: [appointment], services: [service] }));
    assert.equal(fixture.select("SELECT service_name FROM appointments WHERE id=301")[0].service_name, "Original legacy treatment");
    assert.deepEqual(fixture.select("SELECT service_id,service_name,income_kind,amount_pence FROM transactions WHERE id=201")[0], {
      service_id: service.id, service_name: "Original legacy treatment", income_kind: "service", amount_pence: 2100,
    });
    const before = fixture.select("SELECT * FROM transactions");
    fixture.setFailure(sql => { if (sql.includes("INSERT INTO sync_state (key,value) VALUES ('cursor'")) throw new Error("Fixture cursor failure"); });
    await assert.rejects(sync.applySyncResponse(snapshot({ clients: [client], appointments: [{ ...appointment, service_id: "changed-service", service_name: "Changed booking", revision: 2 }], services: [service], cursor: 2 })), /Fixture cursor failure/);
    assert.deepEqual(fixture.select("SELECT * FROM transactions"), before);
    assert.equal(fixture.select("SELECT service_name FROM appointments WHERE id=301")[0].service_name, "Original legacy treatment");
  } finally { fixture.close(); }
});

test("sync preserves a name-only booked source instead of inheriting an unrelated category service", async () => {
  const fixture = fixtureDatabase();
  try {
    const sync = await application(fixture, "src/lib/sync.ts");
    const { client, service, appointment } = sharedRecords();
    fixture.execute("UPDATE categories SET service_id='unrelated-service',income_kind='service' WHERE id=1");
    fixture.execute("INSERT INTO clients(id,name,remote_id) VALUES (101,'Historical customer',?)", [client.id]);
    fixture.execute("INSERT INTO transactions(id,type,date,amount_pence,category_id,category_name_snapshot,income_kind) VALUES (201,'income','2026-10-10',1537,1,'Saved payment label','legacy')");
    fixture.execute("INSERT INTO appointments(id,date,start_time,status,transaction_id,client_id,remote_id,service_name) VALUES (301,'2026-10-10','00:00','confirmed',201,101,?,'Name-only booked treatment')", [appointment.id]);
    await sync.applySyncResponse(snapshot({ clients: [client], appointments: [{ ...appointment, service_id: null, service_name: "Name-only booked treatment" }], services: [service] }));
    assert.deepEqual(fixture.select("SELECT service_id,service_name,income_kind,amount_pence FROM transactions WHERE id=201")[0], {
      service_id: null, service_name: "Saved payment label", income_kind: "service", amount_pence: 1537,
    });
    assert.equal(fixture.select("SELECT service_id FROM appointments WHERE id=301")[0].service_id, null);
  } finally { fixture.close(); }
});

test("payment display distinguishes services other income legacy and expenses without consulting current prices", async () => {
  const fixture = fixtureDatabase();
  try {
    const display = await application(fixture, "src/lib/income-display.ts");
    const examples = [
      [{ type: "income", service_id: "stable-service", service_name: "Booked treatment", category_name: "Wrong category" }, "Booked treatment", "service"],
      [{ type: "income", income_kind: "other", category_name_snapshot: "Tips", category_name: "Renamed" }, "Tips", "other"],
      [{ type: "income", income_kind: "legacy", category_name_snapshot: "Old treatment" }, "Old treatment", "legacy"],
      [{ type: "expense", category_name_snapshot: "Supplies", service_name: "Ignored service" }, "Supplies", "expense"],
    ];
    for (const [entry, label, kind] of examples) {
      assert.equal(display.transactionLabel(entry), label);
      assert.equal(display.transactionKind(entry), kind);
    }
  } finally { fixture.close(); }
});
