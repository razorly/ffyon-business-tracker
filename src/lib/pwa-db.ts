import { openBrowserSqlite } from "./browser-sqlite";
import type { Db } from "./db";
import { pwaDatabaseKey } from "./pwa-access";

interface Snapshot {
  iv: Uint8Array<ArrayBuffer>;
  content: ArrayBuffer;
}

let opened: Promise<IDBDatabase> | undefined;
function storage() {
  return opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("ffyon-pwa", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("ledgers");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); opened = undefined; };
      resolve(db);
    };
  }).catch((error) => { opened = undefined; throw error; });
}

async function snapshot(id: string, updated?: Snapshot): Promise<Snapshot | undefined> {
  const db = await storage();
  return new Promise((resolve, reject) => {
    const tx = updated ? db.transaction("ledgers", "readwrite", { durability: "strict" }) : db.transaction("ledgers", "readonly");
    const ledger = tx.objectStore("ledgers");
    const request = updated ? ledger.put(updated, id) : ledger.get(id);
    tx.oncomplete = () => resolve(updated ? undefined : request.result);
    tx.onabort = () => reject(tx.error || new Error("Could not save the ledger on this device."));
  });
}

async function withLedger<T>(write: boolean, action: (db: Awaited<ReturnType<typeof openBrowserSqlite>>) => T) {
  const { id } = await pwaDatabaseKey();
  // Hold the lock through decryption, SQLite and the IndexedDB commit.
  return navigator.locks.request(`ffyon-ledger-${id}`, { mode: write ? "exclusive" : "shared" }, async () => {
    const active = await pwaDatabaseKey();
    if (active.id !== id) throw new Error("The approved session changed. Try again.");
    const { key } = active;
    const saved = await snapshot(id);
    const bytes = saved ? new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: saved.iv }, key, saved.content)) : undefined;
    const db = await openBrowserSqlite(bytes);
    try {
      const result = action(db);
      if (write) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const content = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, Uint8Array.from(db.export()));
        if ((await pwaDatabaseKey()).id !== id) throw new Error("The approved session changed. Try again.");
        await snapshot(id, { iv, content });
      }
      return result;
    } finally { db.close(); }
  });
}

export const pwaDb: Db = {
  select: (sql, params) => withLedger(false, db => db.select(sql, params)),
  readBatch: (statements) => withLedger(false, db => db.readBatch(statements)),
  execute: (sql, params) => withLedger(true, db => db.execute(sql, params)),
  batch: (statements) => withLedger(true, db => db.batch(statements)),
};
