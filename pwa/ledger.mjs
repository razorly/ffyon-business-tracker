import { createHash, randomUUID } from "node:crypto";
import { encryptedJson } from "./encrypted-json.mjs";

export const ledgerLimit = 16 * 1024 * 1024;
const signature = Buffer.from("SQLite format 3\0");

function validContent(content) {
  if (typeof content !== "string" || content.length >= ledgerLimit || content.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) return false;
  const header = Buffer.from(content.slice(0, 136), "base64");
  if (header.length < 100 || !header.subarray(0, 16).equals(signature)) return false;
  const pageSize = header.readUInt16BE(16) === 1 ? 65536 : header.readUInt16BE(16);
  const length = content.length / 4 * 3 - (content.endsWith("==") ? 2 : Number(content.endsWith("=")));
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0 || length < pageSize || length % pageSize !== 0) return false;
  const pages = header.readUInt32BE(28);
  return pages === 0 || header.readUInt32BE(24) !== header.readUInt32BE(92) || pages * pageSize === length;
}

async function readCopy(store) {
  const record = await store.read();
  if (record && (typeof record.ledger_id !== "string" || !record.ledger_id || !Number.isSafeInteger(record.revision) ||
      record.revision < 1 || !Array.isArray(record.receipts) || !validContent(record.content))) {
    throw new Error("Invalid saved ledger.");
  }
  return record;
}

export function createLedger(directory, key) {
  const store = encryptedJson(directory, "ledger.v1", key);
  const replica = encryptedJson(directory, "ledger-replica.v1", key);
  let loaded;
  let queue = Promise.resolve();

  async function recover() {
    const [primary, secondary] = await Promise.allSettled([readCopy(store), readCopy(replica)]);
    const first = primary.value;
    const second = secondary.value;
    if (!first && !second) {
      if (primary.status === "rejected" || secondary.status === "rejected") throw new Error("Neither shared ledger copy could be recovered.");
      return null;
    }
    if (first && second && (first.ledger_id !== second.ledger_id ||
        (first.revision === second.revision && (first.content !== second.content || JSON.stringify(first.receipts) !== JSON.stringify(second.receipts))))) {
      throw new Error("The shared ledger copies disagree.");
    }
    const latest = !first || (second && second.revision > first.revision) ? second : first;
    if (first?.revision !== latest.revision) await store.write(latest);
    if (second?.revision !== latest.revision) await replica.write(latest);
    return latest;
  }

  function read() {
    return loaded ??= recover().catch(error => { loaded = undefined; throw error; });
  }
  const summary = (record) => record ? { ledger_id: record.ledger_id, revision: record.revision } : { ledger_id: null, revision: 0 };

  async function write(device, input) {
    const current = await read();
    if (!Number.isSafeInteger(input?.revision) || input.revision < 0 || input.revision >= Number.MAX_SAFE_INTEGER ||
        !/^[0-9a-f-]{36}$/.test(input?.operation_id ?? "") || !validContent(input.content)) {
      return { status: 400, body: { error: "Invalid ledger snapshot." } };
    }
    const operation = `${device}:${input.operation_id}`;
    const digest = createHash("sha256").update(input.content).digest("hex");
    const prior = current?.receipts.find(receipt => receipt[0] === operation);
    if (prior) {
      if (prior[1] !== input.revision + 1 || (input.ledger_id ?? null) !== (input.revision ? current.ledger_id : null) ||
          (prior[2] && digest !== prior[2])) return { status: 409, body: { error: "The save identifier was already used with different records." } };
      return { status: 200, body: { ...summary(current), applied_revision: prior[1] } };
    }
    if (input.revision !== (current?.revision ?? 0) || (input.ledger_id ?? null) !== (current?.ledger_id ?? null)) {
      return { status: 409, body: { error: "The shared ledger changed on another device. Refresh and try again." } };
    }
    const revision = input.revision + 1;
    const next = {
      ledger_id: current?.ledger_id ?? randomUUID(), revision, content: input.content,
      receipts: [...(current?.receipts ?? []).slice(-127), [operation, revision, digest]],
    };
    try {
      await store.write(next);
      await replica.write(next);
    } catch (error) {
      // Either rename can have succeeded. Re-read both before handling a retry.
      loaded = undefined;
      throw error;
    }
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
