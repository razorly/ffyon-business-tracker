import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export function encryptedJson(directory, name, key) {
  const path = join(directory, name);
  return {
    async read() {
      let data;
      try { data = await readFile(path); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
      if (data.length < 28) throw new Error("The encrypted file is incomplete.");
      const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12), { authTagLength: 16 }).setAuthTag(data.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]));
    },
    async write(value) {
      const temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(Buffer.concat([iv, cipher.getAuthTag(), data])); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, path);
        // Persist the directory entry as well as the file on the Linux server.
        if (process.platform === "linux") {
          const parent = await open(directory, "r");
          try { await parent.sync(); } finally { await parent.close(); }
        }
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    },
  };
}
