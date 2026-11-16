import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const ledgerLimit = 16 * 1024 * 1024;
const signature = Buffer.from("SQLite format 3\0");

export function createLedger(directory, key) {
  const path = join(directory, "ledger.v1");
  let loaded;
  let queue = Promise.resolve();

  function encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }
  async function load() {
    let data;
    try { data = await readFile(path); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12)).setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]));
  }
  async function persist(record) {
    const temporary = join(directory, `.ledger-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(encrypt(record)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  function read() {
    return loaded ??= load().catch(error => { loaded = undefined; throw error; });
  }
  const summary = (record) => record ? { ledger_id: record.ledger_id, revision: record.revision } : { ledger_id: null, revision: 0 };

  async function write(device, input) {
    const current = await read();
    if (!Number.isSafeInteger(input?.revision) || input.revision < 0 ||
        !/^[0-9a-f-]{36}$/.test(input?.operation_id ?? "") || typeof input.content !== "string" ||
        input.content.length >= ledgerLimit || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.content) ||
        !Buffer.from(input.content.slice(0, 24), "base64").subarray(0, 16).equals(signature)) {
      return { status: 400, body: { error: "Invalid ledger snapshot." } };
    }
    const operation = `${device}:${input.operation_id}`;
    const prior = current?.receipts.find(receipt => receipt[0] === operation);
    if (prior) return { status: 200, body: { ...summary(current), applied_revision: prior[1] } };
    if (input.revision !== (current?.revision ?? 0) || (input.ledger_id ?? null) !== (current?.ledger_id ?? null)) {
      return { status: 409, body: { error: "The shared ledger changed on another device. Refresh and try again." } };
    }
    const revision = input.revision + 1;
    const next = {
      ledger_id: current?.ledger_id ?? randomUUID(), revision, content: input.content,
      receipts: [...(current?.receipts ?? []).slice(-127), [operation, revision]],
    };
    await persist(next);
    loaded = Promise.resolve(next);
    return { status: 200, body: { ...summary(next), applied_revision: revision } };
  }
  return {
    async get(known) {
      const record = await read();
      return { ...summary(record), content: record && known !== String(record.revision) ? record.content : null };
    },
    put(device, input) {
      const task = queue.then(() => write(device, input));
      queue = task.catch(() => {});
      return task;
    },
  };
}
