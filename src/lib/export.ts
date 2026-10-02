import { invoke } from "@tauri-apps/api/core";
import { isBrowserFixture, requireLocalAccess } from "./access";
import { exportAll, isTauri, listClients, listTransactions, monthlyTotals, restoreAll, validateBackup } from "./db";
import { isoDate, monthLabel, ukDate } from "./format";
import { transactionKind, transactionKindLabel, transactionLabel } from "./income-display";

/** Save bytes via the native dialog (or a browser download in dev preview). Returns false if cancelled. */
async function saveBytes(defaultName: string, filterName: string, ext: string, data: Uint8Array | string) {
  await requireLocalAccess();
  if (!isTauri()) {
    if (!isBrowserFixture()) throw new Error("Export requires the paired desktop app.");
    const blob = new Blob([data as BlobPart]);
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = defaultName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return true;
  }
  const path = await invoke<string | null>("protected_save_file", { defaultPath: defaultName, filters: [{ name: filterName, extensions: [ext] }] });
  if (!path) return false;
  if (typeof data === "string") await invoke("protected_write_text_file", { path, data });
  else await invoke("protected_write_file", { path, data: Array.from(data) });
  return true;
}

export async function exportSpreadsheet(from: string, to: string, bookType: "xlsx" | "csv") {
  const XLSX = await import("xlsx");
  const txs = (await listTransactions({ from, to })).reverse();
  const rows = txs.map((t) => ({
    Date: ukDate(t.date),
    Type: t.type === "income" ? "Income" : "Expense",
    "Income type": t.type === "income" ? transactionKindLabel(t) : "",
    Service: transactionKind(t) === "service" ? transactionLabel(t) : "",
    "Other / legacy income": t.type === "income" && transactionKind(t) !== "service" ? transactionLabel(t) : "",
    "Expense category": t.type === "expense" ? transactionLabel(t) : "",
    Client: t.client_name ?? "",
    Description: t.description ?? "",
    "Amount (£)": (t.type === "income" ? 1 : -1) * (t.amount_pence / 100),
  }));
  const income = txs.filter((t) => t.type === "income").reduce((s, t) => s + t.amount_pence, 0);
  const expense = txs.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount_pence, 0);

  const fileBase = `tanned-by-ffy-${from}-to-${to}`;

  if (bookType === "csv") {
    // CSV has no cell types: spreadsheet software may treat customer text as a formula.
    const safeRows = rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(value) ? `'${value}` : value,
    ])));
    const csv = XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(safeRows));
    return saveBytes(`${fileBase}.csv`, "CSV", "csv", csv);
  }

  const wb = XLSX.utils.book_new();
  const txSheet = XLSX.utils.json_to_sheet(rows);
  txSheet["!cols"] = [{ wch: 12 }, { wch: 10 }, { wch: 18 }, { wch: 22 }, { wch: 22 }, { wch: 20 }, { wch: 20 }, { wch: 30 }, { wch: 12 }];
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
  const stamp = isoDate(new Date());
  return saveBytes(`tanned-by-ffy-backup-${stamp}.json`, "Tanned by Ffy backup", "json", JSON.stringify(data, null, 2));
}

/** Returns number of transactions restored, or null if cancelled. Throws on an invalid file. */
export async function loadBackup(): Promise<number | null> {
  if (!isTauri()) throw new Error("Restore is only available in the desktop app.");
  const path = await invoke<string | null>("protected_pick_file", { filters: [{ name: "Tanned by Ffy backup", extensions: ["json"] }] });
  if (!path) return null;
  const parsed = JSON.parse(await invoke<string>("protected_read_text_file", { path }));
  if (!validateBackup(parsed)) throw new Error("That file isn't a Tanned by Ffy backup.");

  await restoreAll(parsed);
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
// Preserve the existing automatic-backup family and retention across the rebrand.
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
    return parsed && typeof parsed.dir === "string" && parsed.dir.trim()
      ? { dir: parsed.dir, lastRun: typeof parsed.lastRun === "string" ? parsed.lastRun : null } : null;
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
  const dir = await invoke<string | null>("protected_pick_directory");
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
  await invoke("protected_write_text_file", { path, data: JSON.stringify(await exportAll(), null, 2) });
  writeAutoBackup({ ...cfg, lastRun: today });
  await pruneBackups(cfg.dir);
  return path;
}

/** Keeps the newest few backups in the folder and removes the rest. */
async function pruneBackups(dir: string) {
  try {
    const names = (await invoke<{ name: string; isFile: boolean }[]>("protected_read_dir", { path: dir }))
      .filter((e) => e.isFile && isAutomaticBackupName(e.name))
      .map((e) => e.name)
      .sort(); // the dated filenames sort oldest first
    for (const name of names.slice(0, Math.max(0, names.length - KEEP))) {
      await invoke("protected_remove_file", { path: inFolder(dir, name) });
    }
  } catch (e) {
    console.error("Couldn't tidy old backups", e); // the backup itself still worked
  }
}

function isAutomaticBackupName(name: string): boolean {
  const match = /^ffyon-backup-(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
  if (!match || match[1].startsWith("0000-")) return false;
  const date = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1];
}
