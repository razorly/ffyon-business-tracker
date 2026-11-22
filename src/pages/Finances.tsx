import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { addMonths, eachDayOfInterval, endOfMonth, format, isSameMonth, startOfMonth, subMonths } from "date-fns";
import { CalendarDays, ChevronLeft, ChevronRight, Download, Plus, Search } from "lucide-react";
import { dailyTotals, incomeTotals, listTransactions, monthlyTotals, type MonthTotal, type TransactionRow } from "@/lib/db";
import { useData, useLoad } from "@/lib/data";
import { lastMonths, monthRange, taxYear, useBusinessNow } from "@/lib/dates";
import { isoDate, money, monthLabel, shortDate } from "@/lib/format";
import { transactionKind, transactionKindLabel, transactionLabel, type TransactionKind } from "@/lib/income-display";
import { useInbox } from "@/lib/inbox";
import { themedColour } from "@/lib/palette";
import { useTheme } from "@/lib/theme";
import { PageHeader } from "@/components/Layout";
import { PaymentRow, useNeedsYou } from "@/components/NeedsYou";
import { ExportDialog } from "@/components/ExportDialog";
import { entryKindLabel, TransactionItem } from "@/components/TransactionList";
import { useNarrow } from "@/components/useNarrow";
import { Button, Card, CardHeader, EmptyState, ErrorText, Input, LoadError, Loading, SectionHeading, Segmented, Select, Stat } from "@/components/ui";
import { CategoryDonut, DailyBars, IncomeExpenseChart, Legend, ProfitBars } from "@/components/charts";

type View = "month" | "tax";
type Filter = "all" | "income" | "expense";

const seriesLegend = [
  { label: "Income", colour: "var(--series-income)" },
  { label: "Expenses", colour: "var(--series-expense)" },
];

/** Everything about money in one place: what is owed, the month, and the tax year. */
export function Finances() {
  const { openNewEntry, openEditAppointment } = useData();
  // The business month follows the London clock, not the computer's timezone.
  const now = useBusinessNow();
  const narrow = useNarrow();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>("month");
  const [month, setMonth] = useState(() => startOfMonth(now));
  // Settings links here with ?export=1 so Export opens straight away.
  const [exporting, setExporting] = useState(() => params.get("export") === "1");
  const closeExport = () => {
    setExporting(false);
    if (params.has("export")) setParams(current => { current.delete("export"); return current; }, { replace: true });
  };

  const { payments } = useInbox();
  const { busy, error, confirmPayment } = useNeedsYou();
  const owed = payments.reduce((sum, row) => sum + (row.price_pence ?? 0), 0);
  // A long list would push the figures off the screen; the first few are shown until she asks for the rest.
  const [allOwed, setAllOwed] = useState(false);
  const shownPayments = allOwed ? payments : payments.slice(0, 3);

  const viewControls = <>
    <Segmented<View> label="Show" className="w-full sm:w-52" value={view} onChange={setView}
      options={[{ value: "month", label: "Month" }, { value: "tax", label: "Tax year" }]} />
    {view === "month" && <div className="flex w-full items-center rounded-xl border border-line bg-surface sm:w-auto">
      <Button variant="ghost" size="icon" onClick={() => setMonth(m => subMonths(m, 1))} aria-label="Previous month"><ChevronLeft size={18} aria-hidden /></Button>
      <span className="tabular min-w-0 flex-1 text-center font-medium sm:w-36 sm:flex-none" aria-live="polite">{format(month, "MMMM yyyy")}</span>
      <Button variant="ghost" size="icon" onClick={() => setMonth(m => addMonths(m, 1))} aria-label="Next month"><ChevronRight size={18} aria-hidden /></Button>
    </div>}
    {view === "month" && !isSameMonth(month, now) && <Button onClick={() => setMonth(startOfMonth(now))}>This month</Button>}
  </>;

  return (
    <>
      <PageHeader title="Money">
        {!narrow && viewControls}
        <Button onClick={() => setExporting(true)}><Download size={16} aria-hidden /> Export</Button>
        <Button variant="primary" onClick={() => openNewEntry()}><Plus size={18} aria-hidden /> Add</Button>
      </PageHeader>
      {narrow && <div className="mb-6 flex flex-wrap items-center gap-2">{viewControls}</div>}

      <div className="flex min-w-0 flex-col gap-6">
        {payments.length > 0 && <Card role="region" aria-labelledby="collect-heading">
          <SectionHeading id="collect-heading" title="Still to collect" className="px-5 pb-2 pt-4"
            action={owed > 0 ? <span className="tabular text-heading font-semibold">{money(owed)}</span> : undefined} />
          {error && <ErrorText className="px-5 pb-3">{error}</ErrorText>}
          <ul className="divide-y divide-line border-t border-line">
            {shownPayments.map(row => <PaymentRow key={row.id} row={row} busy={busy} onOpen={() => openEditAppointment(row)} onConfirm={amount => void confirmPayment(row, amount)} />)}
          </ul>
          {payments.length > 3 && <button type="button" aria-expanded={allOwed} onClick={() => setAllOwed(value => !value)}
            className="flex min-h-11 w-full cursor-pointer items-center gap-1 border-t border-line px-5 py-3 text-left text-small font-medium text-ink-2 hover:text-ink">
            {allOwed ? "Show fewer" : `Show all ${payments.length}`}
          </button>}
        </Card>}

        {view === "month" ? <MonthView month={month} /> : <TaxYearView now={now} />}

        <Link to="/settings?section=money" className="flex min-h-11 items-center gap-1 self-start text-small font-medium text-ink-2 hover:text-ink">
          Manage categories <ChevronRight size={16} aria-hidden />
        </Link>
      </div>

      <ExportDialog open={exporting} onClose={closeExport} />
    </>
  );
}

// ---------- One month ----------

function MonthView({ month }: { month: Date }) {
  const { refresh } = useData();
  const [filter, setFilter] = useState<Filter>("all");
  const [incomeKind, setIncomeKind] = useState<"all" | Exclude<TransactionKind, "expense">>("all");
  const [search, setSearch] = useState("");

  const range = monthRange(month);
  const [rows, loading, loadError] = useLoad(() => listTransactions(range), [range.from], []);
  const [days, daysLoading, daysError] = useLoad(() => dailyTotals(range.from, range.to), [range.from], []);

  const income = rows.filter(r => r.type === "income").reduce((s, r) => s + r.amount_pence, 0);
  const expense = rows.filter(r => r.type === "expense").reduce((s, r) => s + r.amount_pence, 0);
  const clientVisits = rows.filter(r => r.type === "income" && r.client_id).length;

  const dayMap = new Map(days.map(d => [d.date, d]));
  const dailySeries = eachDayOfInterval({ start: month, end: endOfMonth(month) }).map(d => {
    const key = isoDate(d);
    return { day: format(d, "d"), label: format(d, "EEEE d MMMM"), income: dayMap.get(key)?.income ?? 0, expense: dayMap.get(key)?.expense ?? 0 };
  });

  // Newest first, a day at a time.
  const byDay = useMemo(() => {
    const q = search.trim().toLowerCase();
    const visible = rows
      .filter(r => filter === "all" || r.type === filter)
      .filter(r => filter !== "income" || incomeKind === "all" || transactionKind(r) === incomeKind)
      .filter(r => !q || [r.client_name, transactionLabel(r), transactionKindLabel(r), entryKindLabel(r), r.description].some(f => f?.toLowerCase().includes(q)))
      .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    const groups = new Map<string, TransactionRow[]>();
    for (const row of visible) groups.set(row.date, [...(groups.get(row.date) ?? []), row]);
    return [...groups];
  }, [rows, filter, incomeKind, search]);

  const unavailable = rows.length === 0 && (loading || Boolean(loadError));
  const placeholder = loadError ? "Unavailable" : "…";
  const figure = (value: string) => unavailable ? placeholder : value;
  const daysUnavailable = days.length === 0 && Boolean(daysError);

  return (
    <>
      <LoadError error={loadError || daysError} onRetry={refresh} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Income" value={figure(money(income))} tone="good" />
        <Stat label="Expenses" value={figure(money(expense))} />
        <Stat label="Profit" value={figure(money(income - expense))} strong />
        <Stat label="Client payments" value={figure(String(clientVisits))} />
      </div>

      <Card>
        <CardHeader title="Day by day" action={<Legend items={seriesLegend} />} />
        {daysUnavailable ? <p className="px-5 pb-4 text-small text-ink-2">The daily figures are unavailable. Retry above.</p>
          : daysLoading && days.length === 0 ? <Loading label="Loading the month" />
          : <div className="px-2 pb-3"><DailyBars data={dailySeries} /></div>}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-4">
          <Segmented<Filter> label="Entries to show" className="w-full sm:w-72" value={filter} onChange={setFilter}
            options={[{ value: "all", label: "All" }, { value: "income", label: "Income" }, { value: "expense", label: "Expenses" }]} />
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
            {filter === "income" && <Select aria-label="Income type" className="w-full sm:w-48" value={incomeKind} onChange={e => setIncomeKind(e.target.value as typeof incomeKind)}>
              <option value="all">All income</option>
              <option value="service">Service payments</option>
              <option value="other">Other income</option>
              {(incomeKind === "legacy" || rows.some(r => transactionKind(r) === "legacy")) && <option value="legacy">Older income</option>}
              {(incomeKind === "unassigned" || rows.some(r => transactionKind(r) === "unassigned")) && <option value="unassigned">Unassigned income</option>}
            </Select>}
            <div className="relative w-full min-w-0 sm:w-64">
              <Search size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-2" aria-hidden />
              <Input className="pl-10" placeholder="Search name, type or note" aria-label="Search entries" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>
        </div>

        {byDay.length === 0 ? loading
          ? <Loading label="Loading entries" />
          : <EmptyState icon={<CalendarDays size={20} aria-hidden />} title={loadError ? "Entries unavailable" : rows.length ? "No matching entries" : "Nothing this month"}>
            {loadError ? "Retry above." : rows.length ? "Try a different filter or search." : "Income and expenses for this month will show here."}
          </EmptyState>
          : <div className="pb-2">
            {byDay.map(([date, entries]) => <section key={date} aria-label={shortDate(date)}>
              <h3 className="tabular border-y border-line bg-surface-2/50 px-5 py-2 text-small font-medium text-ink-2">{shortDate(date)}</h3>
              <ul className="divide-y divide-line">{entries.map(row => <TransactionItem key={row.id} row={row} />)}</ul>
            </section>)}
          </div>}
      </Card>
    </>
  );
}

// ---------- The tax year ----------

function TaxYearView({ now }: { now: Date }) {
  const { refresh } = useData();
  const { dark } = useTheme();
  const [last, setLast] = useState(false);
  const today = isoDate(now);
  const tax = taxYear(now, last ? -1 : 0);
  // This year stops at today; last year is the whole year.
  const until = last ? tax.to : today;
  const months = lastMonths(now, 12);
  const thisMonth = monthRange(now);

  const [monthly, monthlyLoading, monthlyError] = useLoad<MonthTotal[]>(() => monthlyTotals(months[0] + "-01", thisMonth.to), [thisMonth.from], []);
  const [taxMonthly, taxLoading, taxError] = useLoad<MonthTotal[]>(() => monthlyTotals(tax.from, until), [tax.from, until], []);
  const [incomeSources, incomeLoading, incomeError] = useLoad(() => incomeTotals(tax.from, until), [tax.from, until], []);

  const byMonth = useMemo(() => new Map(monthly.map(m => [m.month, m])), [monthly]);
  const series = months.map(m => ({ label: monthLabel(m), income: byMonth.get(m)?.income ?? 0, expense: byMonth.get(m)?.expense ?? 0 }));
  const taxIncome = taxMonthly.reduce((s, m) => s + m.income, 0);
  const taxExpense = taxMonthly.reduce((s, m) => s + m.expense, 0);
  const taxUnavailable = taxMonthly.length === 0 && (taxLoading || Boolean(taxError));
  const figure = (pence: number) => taxUnavailable ? taxError ? "Unavailable" : "…" : money(pence);
  const chartsUnavailable = monthly.length === 0 && Boolean(monthlyError);
  const chartsLoading = monthly.length === 0 && monthlyLoading;
  const chart = (content: ReactNode) => chartsUnavailable ? <p className="px-5 pb-4 text-small text-ink-2">The monthly figures are unavailable. Retry above.</p>
    : chartsLoading ? <Loading label="Loading the last 12 months" /> : <div className="px-2 pb-4">{content}</div>;

  return (
    <>
      <LoadError error={monthlyError || taxError || incomeError} onRetry={refresh} />

      <section aria-labelledby="tax-year-heading">
        <SectionHeading id="tax-year-heading" title={last ? "Last tax year" : "Tax year so far"}
          action={<Button size="sm" variant="ghost" onClick={() => setLast(value => !value)}>{last ? "This tax year" : "Last tax year"}</Button>} />
        <p className="tabular text-small text-ink-2">{tax.label} · {last ? "6 April to 5 April" : "from 6 April"}</p>
        <div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-3">
          <Stat label="Income" value={figure(taxIncome)} tone="good" />
          <Stat label="Expenses" value={figure(taxExpense)} />
          <div className="col-span-2 min-w-0 lg:col-span-1"><Stat label="Profit" value={figure(taxIncome - taxExpense)} strong /></div>
        </div>
      </section>

      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader title="Income vs expenses" subtitle="Last 12 months" action={<Legend items={seriesLegend} />} />
            {chart(<IncomeExpenseChart data={series} />)}
          </Card>
          <Card>
            <CardHeader title="Profit per month" subtitle="Income minus expenses, last 12 months" />
            {chart(<ProfitBars data={series} />)}
          </Card>
        </div>

        <Card>
          <CardHeader title="Income by type" subtitle={`Tax year ${tax.label}`} />
          <div className="px-5 pb-4">
            {incomeSources.length ? <CategoryDonut centreLabel="Income"
              data={incomeSources.map(source => ({
                key: source.service_id ? `service:${source.service_id}` : `${source.kind}:${source.id ?? "removed"}:${source.name}`,
                name: source.kind === "other" ? `${source.name} (other income)` : source.kind === "legacy" ? `${source.name} (older income)` : source.name,
                value: source.total,
                colour: themedColour(source.colour, dark),
              }))} />
              : <p className="text-small text-ink-2">{incomeError ? "Income by type is unavailable." : incomeLoading ? "Loading…" : last ? "No income in that tax year." : "No income this tax year yet."}</p>}
          </div>
        </Card>
      </div>
    </>
  );
}
