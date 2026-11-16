import initSqlJs, { type SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import rustSource from "../../src-tauri/src/lib.rs?raw";
import type { DbResult, Statement } from "./db";

let engine: Promise<SqlJsStatic> | undefined;
const migrations = [...rustSource.matchAll(/version:\s*(\d+),[\s\S]*?sql:\s*r#"([\s\S]*?)"#/g)];
const currentVersion = Number(migrations[migrations.length - 1][1]);

export async function openBrowserSqlite(bytes?: Uint8Array) {
  const SQL = await (engine ??= initSqlJs({ locateFile: () => wasmUrl }).catch((error) => {
    engine = undefined;
    throw error;
  }));
  const db = new SQL.Database(bytes);
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
  const atomic = <T>(action: () => T): T => {
    db.exec("BEGIN");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  try {
    db.exec("PRAGMA foreign_keys=ON");
    const version = Number(db.exec("PRAGMA user_version")[0].values[0][0]);
    if (version > currentVersion) throw new Error("Reload the app to use this newer ledger.");
    if (version < currentVersion) atomic(() => {
      for (const [, number, sql] of migrations) {
        if (Number(number) <= version) continue;
        db.exec(sql);
        db.exec(`PRAGMA user_version=${number}`);
      }
    });
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    select,
    execute,
    readBatch: <T extends unknown[]>(statements: Statement[]) => atomic(() => statements.map((s) => select(s.sql, s.params)) as T),
    batch: (statements: Statement[]) => atomic(() => statements.map((s) => {
      const result = execute(s.sql, s.params);
      if (s.expectedRows !== undefined && result.rowsAffected !== s.expectedRows) throw new Error("The record changed. Refresh before trying again.");
      return result;
    })),
    export: () => db.export(),
    changes: () => Number(db.exec("SELECT total_changes()")[0].values[0][0]),
    close: () => db.close(),
  };
}
