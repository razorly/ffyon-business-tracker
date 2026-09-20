import * as XLSX from "xlsx";
import { save, open } from "@tauri-apps/plugin-dialog";
import { readDir, remove, writeFile, writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { exportAll, isTauri, listClients, listTransactions, monthlyTotals, restoreAll, validateBackup } from "./db";
import { isoDate, monthLabel, ukDate } from "./format";

/** Save bytes via the native dialog (or a browser download in dev preview). Returns false if cancelled. */
async function saveBytes(defaultName: string, filterName: string, ext: string, data: Uint8Array | string) {
  if (!isTauri()) {
    const blob = new Blob([data as BlobPart]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = defaultName;
    a.click();
    return true;
  }
  const path = await save({ defaultPath: defaultName, filters: [{ name: filterName, extensions: [ext] }] });
  if (!path) return false;
  if (typeof data === "string") await writeTextFile(path, data);
  else await writeFile(path, data);
  return true;
}

export async function exportSpreadsheet(from: string, to: string, bookType: "xlsx" | "csv") {
  const txs = (await listTransactions({ from, to })).reverse();
  const rows = txs.map((t) => ({
    Date: ukDate(t.date),
    Type: t.type === "income" ? "Income" : "Expense",
    Category: t.category_name ?? "",
    Client: t.client_name ?? "",
    Description: t.description ?? "",
    "Amount (£)": (t.type === "income" ? 1 : -1) * (t.amount_pence / 100),
  }));
  const income = txs.filter((t) => t.type === "income").reduce((s, t) => s + t.amount_pence, 0);
  const expense = txs.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount_pence, 0);

  const fileBase = `ffyon-${from}-to-${to}`;

  if (bookType === "csv") {
    const csv = XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(rows));
    return saveBytes(`${fileBase}.csv`, "CSV", "csv", csv);
  }

  const wb = XLSX.utils.book_new();
  const txSheet = XLSX.utils.json_to_sheet(rows);
  txSheet["!cols"] = [{ wch: 12 }, { wch: 10 }, { wch: 18 }, { wch: 20 }, { wch: 30 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, txSheet, "Transactions");

  const months = await monthlyTotals(from, to);
  const summary = [
    ...months.map((m) => ({
      Month: monthLabel(m.month),
      "Income (£)": m.income / 100,
      "Expenses (£)": m.expense / 100,
      "Profit (£)": (m.income - m.expense) / 100,
    })),
    {
      Month: "TOTAL",
      "Income (£)": income / 100,
      "Expenses (£)": expense / 100,
      "Profit (£)": (income - expense) / 100,
    },
  ];
  const sumSheet = XLSX.utils.json_to_sheet(summary);
  sumSheet["!cols"] = [{ wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, sumSheet, "Monthly summary");

  const clients = await listClients();
  const clientSheet = XLSX.utils.json_to_sheet(
    clients.map((c) => ({
      Client: c.name,
      Phone: c.phone ?? "",
      Visits: c.visits,
      "Total spent (£)": c.total_pence / 100,
      "Last visit": c.last_visit ? ukDate(c.last_visit) : "",
    })),
  );
  clientSheet["!cols"] = [{ wch: 20 }, { wch: 15 }, { wch: 8 }, { wch: 15 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, clientSheet, "Clients");

  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return saveBytes(`${fileBase}.xlsx`, "Excel", "xlsx", new Uint8Array(bytes));
}

export async function saveBackup() {
  const data = await exportAll();
  const stamp = new Date().toISOString().slice(0, 10);
  return saveBytes(`ffyon-backup-${stamp}.json`, "Ffyon backup", "json", JSON.stringify(data, null, 2));
}

/** Returns number of transactions restored, or null if cancelled. Throws on an invalid file. */
export async function loadBackup(): Promise<number | null> {
  if (!isTauri()) throw new Error("Restore is only available in the desktop app.");
  const path = await open({ multiple: false, filters: [{ name: "Ffyon backup", extensions: ["json"] }] });
  if (!path) return null;
  const parsed = JSON.parse(await readTextFile(path as string));
  if (!validateBackup(parsed)) throw new Error("That file isn't a Ffyon backup.");

  // Keep the current data so a failed restore can be rolled back.
  const previous = await exportAll();
  try {
    await restoreAll(parsed);
  } catch (e) {
    await restoreAll(previous);
    throw e;
  }
  return parsed.transactions.length;
}

// ---------- Automatic backups ----------

/**
 * A quiet daily copy of everything into a folder she picks — ideally one that
 * syncs, like OneDrive or iCloud Drive. The folder lives in local storage, not
 * the database, because it belongs to this computer and not to the data.
 */
const AUTO_KEY = "ffyon-autobackup";
const KEEP = 10;
const FILE_PREFIX = "ffyon-backup-";

export interface AutoBackup {
  dir: string;
  /** yyyy-MM-dd of the last successful copy, or null if it hasn't run yet. */
  lastRun: string | null;
}

export function readAutoBackup(): AutoBackup | null {
  try {
    const raw = localStorage.getItem(AUTO_KEY);
    const parsed = raw ? (JSON.parse(raw) as AutoBackup) : null;
    return parsed?.dir ? parsed : null;
  } catch {
    return null; // storage unavailable or corrupt — treat as off
  }
}

export function writeAutoBackup(v: AutoBackup | null) {
  try {
    if (v) localStorage.setItem(AUTO_KEY, JSON.stringify(v));
    else localStorage.removeItem(AUTO_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Asks for a folder and turns automatic backups on. Returns null if cancelled. */
export async function chooseAutoBackupFolder(): Promise<AutoBackup | null> {
  if (!isTauri()) throw new Error("Automatic backups are only available in the desktop app.");
  const dir = await open({ directory: true, multiple: false });
  if (!dir) return null;
  const next = { dir: dir as string, lastRun: null };
  writeAutoBackup(next);
  return next;
}

/** Windows accepts forward slashes too, so this is safe on both platforms. */
const inFolder = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, "")}/${name}`;

/**
 * Writes today's backup unless one has already been written today.
 * Returns the file written, or null if there was nothing to do.
 */
export async function runAutoBackup(force = false): Promise<string | null> {
  const cfg = readAutoBackup();
  if (!cfg || !isTauri()) return null;
  const today = isoDate(new Date());
  if (!force && cfg.lastRun === today) return null;

  const path = inFolder(cfg.dir, `${FILE_PREFIX}${today}.json`);
  await writeTextFile(path, JSON.stringify(await exportAll(), null, 2));
  writeAutoBackup({ ...cfg, lastRun: today });
  await pruneBackups(cfg.dir);
  return path;
}

/** Keeps the newest few backups in the folder and removes the rest. */
async function pruneBackups(dir: string) {
  try {
    const names = (await readDir(dir))
      .filter((e) => e.isFile && e.name.startsWith(FILE_PREFIX) && e.name.endsWith(".json"))
      .map((e) => e.name)
      .sort(); // the dated filenames sort oldest first
    for (const name of names.slice(0, Math.max(0, names.length - KEEP))) {
      await remove(inFolder(dir, name));
    }
  } catch (e) {
    console.error("Couldn't tidy old backups", e); // the backup itself still worked
  }
}
