import * as XLSX from "xlsx";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { exportAll, isTauri, listClients, listTransactions, monthlyTotals, restoreAll, validateBackup } from "./db";
import { monthLabel, ukDate } from "./format";

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
