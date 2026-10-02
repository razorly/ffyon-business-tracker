/**
 * DEV-ONLY: an in-browser SQLite (sql.js) so the UI can be previewed in a normal
 * browser with the explicit fixture flag. The real app uses guarded native SQL commands.
 * Schema is read straight from the Rust migrations so there's a single source of truth.
 */
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import rustSource from "../../src-tauri/src/lib.rs?raw";
import type { Db, DbResult, Statement } from "./db";
import { isBrowserFixture } from "./access";

export async function createDevDb(): Promise<Db> {
  if (!isBrowserFixture()) throw new Error("Disposable browser fixtures are disabled.");
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const db = new SQL.Database();
  db.exec("PRAGMA foreign_keys=ON");
  // Migrations must use a Rust raw string (r#"…"#) so they are picked up here too.
  for (const m of rustSource.matchAll(/sql: r#"([\s\S]*?)"#/g)) db.exec(m[1]);

  const bind = (params: unknown[] = []) =>
    Object.fromEntries(params.map((p, i) => [`$${i + 1}`, p ?? null])) as Record<string, never>;

  const execute = (sql: string, params?: unknown[]): DbResult => {
    db.run(sql, bind(params));
    const id = db.exec("SELECT last_insert_rowid()")[0].values[0][0] as number;
    return { rowsAffected: db.getRowsModified(), lastInsertId: id };
  };
  const select = <T>(sql: string, params?: unknown[]): T => {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(bind(params));
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows as T;
    } finally { stmt.free(); }
  };
  return {
    async select<T>(sql: string, params?: unknown[]) {
      return select<T>(sql, params);
    },
    async readBatch<T extends unknown[]>(statements: Statement[]) {
      db.exec("BEGIN");
      try {
        const result = statements.map((s) => select(s.sql, s.params)) as T;
        db.exec("COMMIT");
        return result;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    async execute(sql: string, params?: unknown[]) {
      return execute(sql, params);
    },
    async batch(statements: Statement[]) {
      db.exec("BEGIN");
      try {
        const result = statements.map((s) => {
          const result = execute(s.sql, s.params);
          if (s.expectedRows !== undefined && result.rowsAffected !== s.expectedRows) throw new Error("The record changed. Refresh before trying again.");
          return result;
        });
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
