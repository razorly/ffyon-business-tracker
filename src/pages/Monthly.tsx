import { useMemo, useState } from "react";
import { addMonths, eachDayOfInterval, endOfMonth, format, isSameMonth, startOfMonth, subMonths } from "date-fns";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, CalendarDays, ChevronLeft, ChevronRight, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { dailyTotals, deleteTransaction, listTransactions, type TransactionRow } from "@/lib/db";
import { useData, useLoad } from "@/lib/data";
import { monthRange } from "@/lib/dates";
import { isoDate, money, ukDate } from "@/lib/format";
import { themedColour } from "@/lib/palette";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/Layout";
import { Button, Card, CardHeader, ConfirmModal, EmptyState, Input, Segmented, Swatch } from "@/components/ui";
import { DailyBars, Legend } from "@/components/charts";

type Filter = "all" | "income" | "expense";
type SortKey = "date" | "amount";

export function Monthly() {
  const { openNewEntry, openEditEntry, refresh } = useData();
  const { dark } = useTheme();
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "date", desc: true });
  const [toDelete, setToDelete] = useState<TransactionRow | null>(null);

  const range = monthRange(month);
  const [rows] = useLoad(() => listTransactions(range), [range.from], []);
  const [days] = useLoad(() => dailyTotals(range.from, range.to), [range.from], []);

  const income = rows.filter((r) => r.type === "income").reduce((s, r) => s + r.amount_pence, 0);
  const expense = rows.filter((r) => r.type === "expense").reduce((s, r) => s + r.amount_pence, 0);
  const clientVisits = rows.filter((r) => r.type === "income" && r.client_id).length;

  const dayMap = new Map(days.map((d) => [d.date, d]));
  const dailySeries = eachDayOfInterval({ start: month, end: endOfMonth(month) }).map((d) => {
    const key = isoDate(d);
    return {
      day: format(d, "d"),
      label: format(d, "EEEE d MMMM"),
      income: dayMap.get(key)?.income ?? 0,
      expense: dayMap.get(key)?.expense ?? 0,
    };
  });

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => filter === "all" || r.type === filter)
      .filter(
        (r) =>
          !q ||
          [r.client_name, r.category_name, r.description].some((f) => f?.toLowerCase().includes(q)),
      )
      .sort((a, b) => {
        const d =
          sort.key === "date"
            ? a.date.localeCompare(b.date) || a.id - b.id
            : a.amount_pence - b.amount_pence;
        return sort.desc ? -d : d;
      });
  }, [rows, filter, search, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: true }));

  const isCurrent = isSameMonth(month, new Date());

  return (
    <>
      <PageHeader title="Monthly view" subtitle="Every entry for the month, with totals">
        <div className="flex items-center gap-1 rounded-xl border border-line bg-surface p-1">
          <Button variant="ghost" size="icon" onClick={() => setMonth((m) => subMonths(m, 1))} aria-label="Previous month">
            <ChevronLeft size={16} />
          </Button>
          <span className="w-36 text-center text-sm font-semibold">{format(month, "MMMM yyyy")}</span>
          <Button variant="ghost" size="icon" onClick={() => setMonth((m) => addMonths(m, 1))} aria-label="Next month">
            <ChevronRight size={16} />
          </Button>
        </div>
        {!isCurrent && (
          <Button size="md" onClick={() => setMonth(startOfMonth(new Date()))}>
            Today
          </Button>
        )}
      </PageHeader>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Money in" value={money(income)} tone="good" />
        <Stat label="Money out" value={money(expense)} />
        <Stat label="Profit" value={money(income - expense)} tone={income - expense < 0 ? "bad" : undefined} strong />
        <Stat label="Client appointments" value={String(clientVisits)} />
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Day by day"
          action={
            <Legend
              items={[
                { label: "Income", colour: "var(--series-income)" },
                { label: "Expenses", colour: "var(--series-expense)" },
              ]}
            />
          }
        />
        <div className="px-2 pb-3">
          <DailyBars data={dailySeries} />
        </div>
      </Card>

      <Card className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "income", label: "Money in" },
              { value: "expense", label: "Money out" },
            ]}
          />
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <Input
                className="w-56 pl-8"
                placeholder="Search client, category, note"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Button variant="primary" onClick={() => openNewEntry()}>
              <Plus size={15} /> Add
            </Button>
          </div>
        </div>

        {visible.length === 0 ? (
          <EmptyState icon={<CalendarDays size={20} />} title={rows.length ? "No matching entries" : "Nothing this month"}>
            {rows.length ? "Try a different filter or search." : "Entries you add for this month will show here."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="border-y border-line bg-surface-2/50 text-left text-[12px] uppercase tracking-wide text-muted">
                  <SortTh label="Date" active={sort.key === "date"} desc={sort.desc} onClick={() => toggleSort("date")} className="pl-5" />
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Client</th>
                  <th className="px-3 py-2 font-medium">Note</th>
                  <SortTh label="Amount" active={sort.key === "amount"} desc={sort.desc} onClick={() => toggleSort("amount")} className="text-right" />
                  <th className="w-20 pr-5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {visible.map((r) => (
                  <tr key={r.id} className="group hover:bg-surface-2/50">
                    <td className="tabular py-2.5 pl-5 pr-3 text-ink-2">{ukDate(r.date)}</td>
                    <td className="px-3 py-2.5">
                      <span className="inline-flex items-center gap-2">
                        {r.category_colour && <Swatch colour={themedColour(r.category_colour, dark)} />}
                        {r.category_name ?? <span className="text-muted">Uncategorised</span>}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">{r.client_name ?? <span className="text-muted">—</span>}</td>
                    <td className="max-w-[240px] truncate px-3 py-2.5 text-ink-2">{r.description}</td>
                    <td
                      className={cn(
                        "tabular px-3 py-2.5 text-right font-semibold",
                        r.type === "income" ? "text-good" : "text-ink",
                      )}
                    >
                      {r.type === "income" ? "+" : "−"}
                      {money(r.amount_pence)}
                    </td>
                    <td className="pr-5 text-right">
                      <div className="flex justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <Button variant="ghost" size="icon" onClick={() => openEditEntry(r)} aria-label="Edit">
                          <Pencil size={14} />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => setToDelete(r)} aria-label="Delete">
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="h-2" />
      </Card>

      <ConfirmModal
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete entry?"
        message={
          toDelete && (
            <>
              This will remove the {toDelete.type} of <b>{money(toDelete.amount_pence)}</b> on {ukDate(toDelete.date)}.
            </>
          )
        }
        onConfirm={async () => {
          if (!toDelete) return;
          await deleteTransaction(toDelete.id);
          toast.success("Entry deleted");
          refresh();
        }}
      />
    </>
  );
}

function Stat({ label, value, tone, strong }: { label: string; value: string; tone?: "good" | "bad"; strong?: boolean }) {
  return (
    <Card className={cn("px-5 py-4", strong && "bg-gradient-to-br from-accent-soft to-surface")}>
      <div className="text-[13px] font-medium text-ink-2">{label}</div>
      <div className={cn("mt-1 text-[22px] font-semibold tracking-tight", tone === "good" && "text-good", tone === "bad" && "text-bad")}>
        {value}
      </div>
    </Card>
  );
}

function SortTh({
  label,
  active,
  desc,
  onClick,
  className,
}: {
  label: string;
  active: boolean;
  desc: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <th className={cn("px-3 py-2 font-medium", className)}>
      <button onClick={onClick} className={cn("inline-flex items-center gap-1 uppercase cursor-pointer", active && "text-ink")}>
        {label}
        {active && (desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
      </button>
    </th>
  );
}
