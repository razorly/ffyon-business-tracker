import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import type { TransactionRow } from "@/lib/db";
import { useData } from "@/lib/data";
import { money, shortDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Compact list of entries (dashboard recent, client history). Click to edit. */
export function TransactionList({ rows, showDate = true }: { rows: TransactionRow[]; showDate?: boolean }) {
  const { openEditEntry } = useData();
  return (
    <ul className="divide-y divide-line">
      {rows.map((t) => {
        const income = t.type === "income";
        return (
          <li key={t.id}>
            <button
              onClick={() => openEditEntry(t)}
              className="flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-surface-2/60 cursor-pointer"
            >
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                  income ? "bg-accent-soft text-ink" : "bg-surface-2 text-rose",
                )}
              >
                {income ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium">
                  {t.client_name ?? t.category_name ?? (income ? "Income" : "Expense")}
                </span>
                <span className="block truncate text-[12px] text-muted">
                  {[showDate && shortDate(t.date), t.client_name ? t.category_name : null, t.description]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className={cn("tabular text-[13.5px] font-semibold", income ? "text-good" : "text-ink")}>
                {income ? "+" : "−"}
                {money(t.amount_pence)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
