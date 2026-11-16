import { readFile } from "node:fs/promises";
import initSqlJs from "sql.js";
import ts from "typescript";

const SQL = await initSqlJs();
const source = await readFile(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
const migrations = [...source.matchAll(/version:\s*(\d+),[\s\S]*?sql:\s*r#"([\s\S]*?)"#/g)];
const mergeSource = await readFile(new URL("../../src/lib/ledger-merge.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(mergeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
export const { mergeLegacyLedger, seedLedger } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

export function ledgerFixture(bytes) {
  const database = new SQL.Database(bytes);
  if (!bytes) {
    for (const [, version, sql] of migrations) {
      database.exec(sql);
      database.exec(`PRAGMA user_version=${version}`);
    }
  }
  database.exec("PRAGMA foreign_keys=ON");
  const bind = params => Object.fromEntries((params ?? []).map((value, i) => [`$${i + 1}`, value ?? null]));
  const select = (sql, params) => database.exec(sql, bind(params)).flatMap(({ columns, values }) =>
    values.map(row => Object.fromEntries(columns.map((column, i) => [column, row[i]]))));
  return {
    select,
    readBatch: statements => statements.map(({ sql, params }) => select(sql, params)),
    batch(statements) {
      database.exec("BEGIN");
      try {
        for (const { sql, params, expectedRows } of statements) {
          database.run(sql, bind(params));
          if (expectedRows !== undefined && expectedRows !== database.getRowsModified()) throw new Error("Unexpected row count");
        }
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
    exec: sql => database.exec(sql),
    export: () => database.export(),
    close: () => database.close(),
  };
}

export function backupFixture(db) {
  const [categories, clients, transactions, appointments] = db.readBatch(["categories", "clients", "transactions", "appointments"].map(table => ({ sql: `SELECT * FROM ${table}` })));
  return { app: "ffyon-business-tracker", version: 4, categories, clients, transactions, appointments };
}
