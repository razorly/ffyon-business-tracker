import { isBrowserFixture } from "./access";
import { openBrowserSqlite } from "./browser-sqlite";
import type { Db } from "./db";

export async function createDevDb(): Promise<Db> {
  if (!isBrowserFixture()) throw new Error("Disposable browser fixtures are disabled.");
  const db = await openBrowserSqlite();
  return {
    select: async <T>(sql: string, params?: unknown[]) => db.select<T>(sql, params),
    readBatch: async (statements) => db.readBatch(statements),
    execute: async (sql, params) => db.execute(sql, params),
    batch: async (statements) => db.batch(statements),
  };
}
