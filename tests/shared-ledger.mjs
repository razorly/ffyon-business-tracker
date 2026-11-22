import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLedger } from "../pwa/ledger.mjs";
import { backupFixture, ledgerFixture, mergeLegacyLedger, seedLedger } from "./support/ledger-fixture.mjs";

test("two legacy devices merge distinct finance and private notes while duplicate entries stay single", async () => {
  const desktop = ledgerFixture();
  desktop.exec(`INSERT INTO clients(id, name, remote_id) VALUES (50, 'Test client', 'site-client');
    INSERT INTO transactions(id,type,date,amount_pence,description,created_at) VALUES
    (6,'income','2026-11-10',2500,'Original income','2026-11-10 09:00:00');`);
  const phone = ledgerFixture();
  phone.exec(`INSERT INTO clients(id, name, remote_id, notes) VALUES (82, 'Test client', 'site-client', 'Preferred shade');
    INSERT INTO transactions(id,type,date,amount_pence,description,created_at) VALUES
    (17,'income','2026-11-10',2500,'Original income','2026-11-10 09:00:00'),
    (18,'expense','2026-11-11',1900,'Supplies','2026-11-11 10:00:00');`);
  const shared = ledgerFixture();
  await seedLedger(shared, desktop, "desktop");
  const backup = backupFixture(phone);
  assert.deepEqual(mergeLegacyLedger(shared, backup, "phone"), { entries: [], clients: [], appointments: [] });
  assert.deepEqual(shared.select("SELECT amount_pence FROM transactions ORDER BY date").map(row => row.amount_pence), [2500, 1900]);
  assert.equal(shared.select("SELECT notes FROM clients")[0].notes, "Preferred shade");

  shared.exec("DELETE FROM transactions WHERE amount_pence=2500; UPDATE clients SET notes=NULL");
  assert.deepEqual(mergeLegacyLedger(shared, backup, "late-copy"), { entries: [17], clients: [82], appointments: [] });
  assert.deepEqual(shared.select("SELECT amount_pence FROM transactions").map(row => row.amount_pence), [1900]);
  assert.equal(shared.select("SELECT notes FROM clients")[0].notes, null);
  assert.equal(phone.select("SELECT COUNT(*) AS n FROM transactions")[0].n, 2);
  assert.equal(phone.select("SELECT notes FROM clients")[0].notes, "Preferred shade");

  for (const db of [desktop, phone, shared]) db.close();
});

test("ambiguous edits and removed payments stay in the original device with a review entry", async () => {
  const app = ledgerFixture();
  app.exec(`INSERT INTO transactions(id,type,date,amount_pence,created_at) VALUES
    (18,'income','2026-11-11',1900,'2026-11-11 10:00:00');
    INSERT INTO appointments(id,date,start_time,remote_id,status,transaction_id) VALUES
    (52,'2026-11-11','09:00','booked','confirmed',18);`);
  const shared = ledgerFixture();
  await seedLedger(shared, app, "first");
  shared.exec("UPDATE transactions SET amount_pence=2000; UPDATE appointments SET transaction_id=NULL; DELETE FROM transactions;");
  assert.deepEqual(mergeLegacyLedger(shared, backupFixture(app), "late"), { entries: [18], clients: [], appointments: [] });
  assert.equal(shared.select("SELECT transaction_id FROM appointments")[0].transaction_id, null);
  assert.deepEqual(shared.select("SELECT id FROM transactions"), []);
  app.close();
  shared.close();
});

test("durable revisions serialize writers and make retrying an uncertain save idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffyon-ledger-"));
  const key = randomBytes(32);
  const db = ledgerFixture();
  try {
    db.exec("INSERT INTO clients(name,notes) VALUES ('Test','private-note-for-test')");
    const content = Buffer.from(db.export()).toString("base64");
    const initial = { ledger_id: null, revision: 0, operation_id: randomUUID(), content };
    const other = { ...initial, operation_id: randomUUID() };
    const service = createLedger(directory, key);
    const [first, stale] = await Promise.all([service.put("desktop", initial), service.put("phone", other)]);
    assert.equal(first.status, 200);
    assert.equal(stale.status, 409);
    const revision = { ledger_id: first.body.ledger_id, revision: 1, operation_id: randomUUID(), content };
    assert.equal((await service.put("phone", revision)).body.applied_revision, 2);
    assert.equal((await service.put("desktop", initial)).body.applied_revision, 1);
    const raw = await readFile(join(directory, "ledger.v1"));
    assert.equal(raw.includes(Buffer.from("private-note-for-test")), false);
    assert.equal(raw.includes(Buffer.from(content)), false);
    const restarted = createLedger(directory, key);
    assert.deepEqual(await restarted.get("2"), { ledger_id: first.body.ledger_id, revision: 2, content: null });
    assert.equal((await restarted.get()).content, content);
    assert.equal((await restarted.put("phone", revision)).body.applied_revision, 2);
  } finally {
    db.close();
    await rm(join(directory, "ledger.v1"), { force: true });
    await rm(join(directory, "ledger-replica.v1"), { force: true });
    await rmdir(directory);
  }
});

test("one missing or damaged copy recovers the latest acknowledged ledger and repairs redundancy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffyon-ledger-recovery-"));
  const files = ["ledger.v1", "ledger-replica.v1"].map(name => join(directory, name));
  const key = randomBytes(32);
  const db = ledgerFixture();
  try {
    const service = createLedger(directory, key);
    const initial = { ledger_id: null, revision: 0, operation_id: randomUUID(), content: Buffer.from(db.export()).toString("base64") };
    const first = await service.put("desktop", initial);
    db.exec("INSERT INTO transactions (type,date,amount_pence) VALUES ('income','2026-11-10',3600)");
    const latest = { ledger_id: first.body.ledger_id, revision: 1, operation_id: randomUUID(), content: Buffer.from(db.export()).toString("base64") };
    assert.equal((await service.put("desktop", latest)).body.applied_revision, 2);
    const truncated = Buffer.from(latest.content, "base64").subarray(0, 4096).toString("base64");
    assert.equal((await service.put("desktop", { ...latest, revision: 2, operation_id: randomUUID(), content: truncated })).status, 400, "A truncated file must leave both copies intact");
    assert.equal((await service.put("desktop", { ...latest, content: initial.content })).status, 409, "An operation can only acknowledge the original snapshot");
    await rm(files[0]);
    assert.equal((await createLedger(directory, key).get()).content, latest.content);
    await writeFile(files[1], "interrupted storage");
    assert.equal((await createLedger(directory, key).get()).revision, 2);
    await writeFile(files[0], "interrupted primary storage");
    await writeFile(files[1], "interrupted replica storage");
    const damaged = createLedger(directory, key);
    await assert.rejects(damaged.put("desktop", initial), /Neither shared ledger copy/);
    assert.equal(await readFile(files[0], "utf8"), "interrupted primary storage");
  } finally {
    db.close();
    for (const file of files) await rm(file, { force: true });
    await rmdir(directory);
  }
});

test("interruption between the two saves recovers and acknowledges the exact original retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffyon-ledger-interrupt-"));
  const primary = join(directory, "ledger.v1");
  const replica = join(directory, "ledger-replica.v1");
  const key = randomBytes(32);
  const db = ledgerFixture();
  try {
    const service = createLedger(directory, key);
    const initial = { ledger_id: null, revision: 0, operation_id: randomUUID(), content: Buffer.from(db.export()).toString("base64") };
    const first = await service.put("desktop", initial);
    await rm(replica);
    await mkdir(replica);
    db.exec("INSERT INTO clients(name,notes) VALUES ('Test','Latest private note')");
    const next = { ledger_id: first.body.ledger_id, revision: 1, operation_id: randomUUID(), content: Buffer.from(db.export()).toString("base64") };
    await assert.rejects(service.put("desktop", next));
    await rmdir(replica);
    const restarted = createLedger(directory, key);
    assert.equal((await restarted.put("desktop", next)).body.applied_revision, 2);
    await rm(primary);
    assert.deepEqual(await createLedger(directory, key).get(), { ledger_id: first.body.ledger_id, revision: 2, content: next.content });
  } finally {
    db.close();
    await rm(primary, { force: true });
    const replicaInfo = await stat(replica).catch(() => null);
    if (replicaInfo?.isDirectory()) await rmdir(replica);
    else await rm(replica, { force: true });
    await rmdir(directory);
  }
});

test("parallel devices preserve every acknowledged finance entry across restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffyon-ledger-parallel-"));
  const primary = join(directory, "ledger.v1");
  const replica = join(directory, "ledger-replica.v1");
  const key = randomBytes(32);
  const expected = [];
  const initialDb = ledgerFixture();
  try {
    let service = createLedger(directory, key);
    assert.equal((await service.put("first", {
      ledger_id: null, revision: 0, operation_id: randomUUID(), content: Buffer.from(initialDb.export()).toString("base64"),
    })).status, 200);
    let conflicts = 0;
    for (let round = 0; round < 12; round++) {
      const amounts = Array.from({ length: 8 }, (_, device) => 1000 + round * 8 + device);
      expected.push(...amounts);
      await Promise.all(amounts.map(async (amount, device) => {
        for (let attempt = 0; attempt < amounts.length + 1; attempt++) {
          const { ledger_id, revision, content } = await service.get();
          const db = ledgerFixture(Buffer.from(content, "base64"));
          let saved;
          try {
            db.exec(`INSERT INTO transactions(type,date,amount_pence) VALUES ('income','2026-11-12',${amount})`);
            saved = await service.put(`device-${device}`, { ledger_id, revision, operation_id: randomUUID(), content: Buffer.from(db.export()).toString("base64") });
          } finally { db.close(); }
          if (saved.status === 200) return;
          assert.equal(saved.status, 409);
          conflicts++;
        }
        assert.fail("A device never committed its finance entry");
      }));
      if (round % 3 === 2) {
        await rm(round % 2 ? primary : replica);
        service = createLedger(directory, key);
      }
    }
    assert.ok(conflicts >= 12 * 7);
    const final = await service.get();
    const recovered = ledgerFixture(Buffer.from(final.content, "base64"));
    try {
      assert.equal(final.revision, expected.length + 1);
      assert.deepEqual(recovered.select("SELECT amount_pence FROM transactions ORDER BY amount_pence").map(row => row.amount_pence), expected);
      assert.deepEqual(recovered.select("PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
    } finally { recovered.close(); }
  } finally {
    initialDb.close();
    for (const path of [primary, replica]) await rm(path, { force: true });
    await rmdir(directory);
  }
});
