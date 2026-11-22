import type { TransactionRow } from "@/lib/db";
import { useData } from "@/lib/data";
import { money, shortDate } from "@/lib/format";
import { transactionKind, transactionKindLabel, transactionLabel } from "@/lib/income-display";
import { cn } from "@/lib/utils";

/** What kind of entry it was, in her words. Income kept from before services existed is "Older income". */
export const entryKindLabel = (row: TransactionRow) => transactionKind(row) === "legacy" ? "Older income" : transactionKindLabel(row);

/**
 * One income or expense entry: who or what it was, a line of detail, and the amount.
 * Tapping it opens the entry, where it can be changed or deleted.
 */
export function TransactionItem({ row, showDate }: { row: TransactionRow; showDate?: boolean }) {
  const { openEditEntry } = useData();
  const income = row.type === "income";
  const label = transactionLabel(row);
  const detail = [showDate && shortDate(row.date), row.client_name ? label : entryKindLabel(row), row.description].filter(Boolean).join(" · ");
  return (
    <li>
      <button type="button" onClick={() => openEditEntry(row)} className="flex w-full min-w-0 cursor-pointer items-center gap-3 px-5 py-3 text-left text-body hover:bg-surface-2/60">
        <span className="min-w-0 flex-1">
          <span className="block break-words font-medium text-ink">{row.client_name ?? label}</span>
          <span className="block break-words text-small text-ink-2">{detail}</span>
        </span>
        <span className={cn("tabular shrink-0 font-semibold", income ? "text-good" : "text-ink")}>
          {income ? "+" : "−"}{money(row.amount_pence)}
        </span>
      </button>
    </li>
  );
}

/** A list of entries (Money, a client's history). Tap one to open it. */
export function TransactionList({ rows, showDate = true }: { rows: TransactionRow[]; showDate?: boolean }) {
  return <ul className="divide-y divide-line">{rows.map(row => <TransactionItem key={row.id} row={row} showDate={showDate} />)}</ul>;
}
