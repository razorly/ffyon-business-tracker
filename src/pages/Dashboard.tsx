import { useMemo } from "react";
import { Link } from "react-router-dom";
import { format, subMonths } from "date-fns";
import { PoundSterling, Receipt, Sparkles, Users, Wallet } from "lucide-react";
import { categoryTotals, distinctClients, listTransactions, monthlyTotals, type MonthTotal } from "@/lib/db";
import { useData, useLoad } from "@/lib/data";
import { lastMonths, monthRange, taxYear } from "@/lib/dates";
import { money, monthLabel, percentChange } from "@/lib/format";
import { themedColour } from "@/lib/palette";
import { useTheme } from "@/lib/theme";
import { PageHeader } from "@/components/Layout";
import { KpiCard } from "@/components/KpiCard";
import { Button, Card, CardHeader, EmptyState } from "@/components/ui";
import { CategoryDonut, IncomeExpenseChart, Legend, ProfitBars } from "@/components/charts";
import { TransactionList } from "@/components/TransactionList";

export function Dashboard() {
  const { openNewEntry } = useData();
  const { dark } = useTheme();
  const now = new Date();
  const months = lastMonths(now, 12);
  const tax = taxYear(now);
  const thisMonth = monthRange(now);

  const [monthly] = useLoad<MonthTotal[]>(() => monthlyTotals(months[0] + "-01", thisMonth.to), [], []);
  const [taxMonthly] = useLoad<MonthTotal[]>(() => monthlyTotals(tax.from, tax.to), [], []);
  const [cats] = useLoad(() => categoryTotals("income", tax.from, tax.to), [], []);
  const [clientsThisMonth] = useLoad(() => distinctClients(thisMonth.from, thisMonth.to), [], 0);
  const [recent, loadingRecent] = useLoad(() => listTransactions({ limit: 6 }), [], []);

  const byMonth = useMemo(() => new Map(monthly.map((m) => [m.month, m])), [monthly]);
  const series = months.map((m) => ({
    label: monthLabel(m),
    income: byMonth.get(m)?.income ?? 0,
    expense: byMonth.get(m)?.expense ?? 0,
  }));
  const cur = byMonth.get(months[11]) ?? { income: 0, expense: 0 };
  const prev = byMonth.get(months[10]) ?? { income: 0, expense: 0 };
  const taxIncome = taxMonthly.reduce((s, m) => s + m.income, 0);
  const taxProfit = taxMonthly.reduce((s, m) => s + m.income - m.expense, 0);
  const prevLabel = format(subMonths(now, 1), "MMMM");

  const empty = !loadingRecent && recent.length === 0;

  return (
    <>
      <PageHeader title={`${greeting()} ✨`} subtitle={`Here's how ${format(now, "MMMM")} is going`} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          hero
          label={`Profit in ${format(now, "MMMM")}`}
          value={money(cur.income - cur.expense)}
          delta={percentChange(cur.income - cur.expense, prev.income - prev.expense)}
          deltaLabel={prevLabel}
          icon={<Wallet size={17} />}
        />
        <KpiCard
          label="Money in"
          value={money(cur.income)}
          delta={percentChange(cur.income, prev.income)}
          deltaLabel={prevLabel}
          icon={<PoundSterling size={17} />}
        />
        <KpiCard
          label="Money out"
          value={money(cur.expense)}
          delta={percentChange(cur.expense, prev.expense)}
          deltaLabel={prevLabel}
          upIsGood={false}
          icon={<Receipt size={17} />}
        />
        <KpiCard label="Clients this month" value={String(clientsThisMonth)} icon={<Users size={17} />} />
      </div>

      {empty ? (
        <Card className="mt-6">
          <EmptyState icon={<Sparkles size={20} />} title="No entries yet">
            Add your first client or expense and your charts will appear here.
            <div className="mt-4">
              <Button variant="primary" onClick={() => openNewEntry()}>
                Add first entry
              </Button>
            </div>
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader
                title="Income vs expenses"
                subtitle="Last 12 months"
                action={
                  <Legend
                    items={[
                      { label: "Income", colour: "var(--series-income)" },
                      { label: "Expenses", colour: "var(--series-expense)" },
                    ]}
                  />
                }
              />
              <div className="px-2 pb-4">
                <IncomeExpenseChart data={series} />
              </div>
            </Card>

            <Card>
              <CardHeader title="Tax year so far" subtitle={`${tax.label} · from 6 April`} />
              <div className="grid grid-cols-2 gap-3 px-5 pb-4">
                <div className="rounded-xl bg-surface-2 p-3">
                  <div className="text-[12px] text-muted">Income</div>
                  <div className="mt-0.5 text-lg font-semibold">{money(taxIncome)}</div>
                </div>
                <div className="rounded-xl bg-surface-2 p-3">
                  <div className="text-[12px] text-muted">Profit</div>
                  <div className={`mt-0.5 text-lg font-semibold ${taxProfit < 0 ? "text-bad" : ""}`}>
                    {money(taxProfit)}
                  </div>
                </div>
              </div>
              <div className="px-5 pb-5">
                <div className="mb-3 text-[13px] font-medium text-ink-2">Income by service</div>
                {cats.length ? (
                  <CategoryDonut
                    centreLabel="Income"
                    data={cats.map((c) => ({ name: c.name, value: c.total, colour: themedColour(c.colour, dark) }))}
                  />
                ) : (
                  <p className="text-[13px] text-muted">No income this tax year yet.</p>
                )}
              </div>
            </Card>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Profit per month" subtitle="Income minus expenses" />
              <div className="px-2 pb-4">
                <ProfitBars data={series} />
              </div>
            </Card>
            <Card>
              <CardHeader
                title="Recent entries"
                action={
                  <Link to="/monthly" className="text-[13px] font-medium text-accent hover:underline">
                    View all
                  </Link>
                }
              />
              <div className="pb-2">
                <TransactionList rows={recent} />
              </div>
            </Card>
          </div>
        </>
      )}
    </>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
