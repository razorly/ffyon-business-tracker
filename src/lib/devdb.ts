/**
 * DEV-ONLY: an in-browser SQLite (sql.js) so the UI can be previewed in a normal
 * browser with `npm run dev`. The real app always uses the Tauri SQL plugin.
 * Schema is read straight from the Rust migrations so there's a single source of truth.
 */
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import rustSource from "../../src-tauri/src/lib.rs?raw";
import type { Db } from "./db";

export async function createDevDb(): Promise<Db> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const db = new SQL.Database();
  // Migrations must use a Rust raw string (r#"…"#) so they are picked up here too.
  for (const m of rustSource.matchAll(/sql: r#"([\s\S]*?)"#/g)) db.exec(m[1]);

  const bind = (params: unknown[] = []) =>
    Object.fromEntries(params.map((p, i) => [`$${i + 1}`, p ?? null])) as Record<string, never>;

  return {
    async select<T>(sql: string, params?: unknown[]) {
      const stmt = db.prepare(sql);
      stmt.bind(bind(params));
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows as T;
    },
    async execute(sql: string, params?: unknown[]) {
      db.run(sql, bind(params));
      const id = db.exec("SELECT last_insert_rowid()")[0].values[0][0] as number;
      return { rowsAffected: db.getRowsModified(), lastInsertId: id };
    },
  };
}
