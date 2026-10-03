import { useMemo } from "react";
import { Link } from "react-router-dom";
import { format, subMonths } from "date-fns";
import { BanknoteArrowDown, CalendarClock, CalendarHeart, ChevronRight, CircleCheck, Mail, MapPin, Plus, PoundSterling, Receipt, Sparkles, Users, Wallet } from "lucide-react";
import { distinctClients, incomeTotals, listAppointments, listTransactions, monthlyTotals, type MonthTotal } from "@/lib/db";
import { useData, useLoad } from "@/lib/data";
import { lastMonths, monthRange, taxYear, useBusinessNow } from "@/lib/dates";
import { isoDate, money, monthLabel, percentChange, timeLabel } from "@/lib/format";
import { useInbox } from "@/lib/inbox";
import { themedColour } from "@/lib/palette";
import { useTheme } from "@/lib/theme";
import { PageHeader } from "@/components/Layout";
import { KpiCard } from "@/components/KpiCard";
import { FittedValue } from "@/components/FittedValue";
import { Button, Card, CardHeader, EmptyState, LoadError } from "@/components/ui";
import { useAccess } from "@/components/AccessGate";
import { CategoryDonut, IncomeExpenseChart, Legend, ProfitBars } from "@/components/charts";
import { TransactionList } from "@/components/TransactionList";

export function Dashboard() {
  const { openNewEntry, openNewAppointment, openEditAppointment, refresh } = useData();
  const access = useAccess();
  const { requests, payments, error: inboxError, loading: inboxLoading, mail, mailLoading, mailError } = useInbox();
  const { dark } = useTheme();
  const now = useBusinessNow();
  const today = isoDate(now);
  const months = lastMonths(now, 12);
  const tax = taxYear(now);
  const thisMonth = monthRange(now);

  const [monthly, monthlyLoading, monthlyError] = useLoad<MonthTotal[]>(() => monthlyTotals(months[0] + "-01", thisMonth.to), [thisMonth.from], []);
  const [taxMonthly, taxLoading, taxError] = useLoad<MonthTotal[]>(() => monthlyTotals(tax.from, today), [tax.from, today], []);
  const [incomeSources, incomeLoading, incomeError] = useLoad(() => incomeTotals(tax.from, today), [tax.from, today], []);
  const [clientsThisMonth, clientsLoading, clientsError] = useLoad(() => distinctClients(thisMonth.from, thisMonth.to), [thisMonth.from], 0);
  const [recent, loadingRecent, recentError] = useLoad(() => listTransactions({ limit: 6 }), [], []);
  const [todayRows, todayLoading, todayError] = useLoad(() => listAppointments({ from: today, to: today }), [today], []);
  const todayAppointments = todayRows.filter(row => row.status === "confirmed").sort((a, b) => b.time_confirmed - a.time_confirmed || a.start_time.localeCompare(b.start_time));

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
  const owed = payments.reduce((sum, row) => sum + (row.price_pence ?? 0), 0);
  const inboxPending = inboxLoading && requests.length === 0 && payments.length === 0;
  const mailLabel = mailError ? "Email check unavailable" : mailLoading && mail.unread_count === 0 ? "Checking email…" : `${mail.unread_count} unread email${mail.unread_count === 1 ? "" : "s"}`;

  const empty = !loadingRecent && !recentError && recent.length === 0;
  const figuresUnavailable = monthly.length === 0 && (monthlyLoading || Boolean(monthlyError));
  const figuresPlaceholder = monthlyError ? "Unavailable" : "…";

  return (
    <>
      <PageHeader title={greeting(now)} subtitle={`Here's how ${format(now, "MMMM")} is going`} />
      <LoadError error={monthlyError || taxError || incomeError || clientsError || recentError || todayError || inboxError} onRetry={refresh} />
      {monthlyLoading && <p role="status" className="mb-3 text-sm text-muted">Loading business figures…</p>}

      <div className="mb-4 grid min-w-0 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title={`Today · ${format(now, "EEE d MMM")}`} subtitle={`${todayAppointments.length} confirmed appointment${todayAppointments.length === 1 ? "" : "s"}`} action={<Button size="sm" disabled={access.state !== "online"} onClick={() => openNewAppointment({ date: today, start_time: "09:00" })}><Plus size={14} />Book</Button>} />
          {todayLoading && todayAppointments.length === 0 ? <p role="status" className="px-5 py-3 text-sm text-muted">Loading today's appointments…</p> : todayAppointments.length ? <ul className="max-h-64 divide-y divide-line overflow-y-auto">
            {todayAppointments.map(row => <li key={row.id}><button type="button" onClick={() => openEditAppointment(row)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-5 py-3 text-left text-sm hover:bg-surface-2/60 sm:flex sm:items-center sm:gap-3"><span className="col-span-2 font-medium text-ink-2 sm:w-24 sm:shrink-0">{row.time_confirmed === 0 ? "Time to confirm" : timeLabel(row.start_time)}</span><span className="min-w-0 sm:flex-1"><span className="block break-words font-medium">{row.client_name || "Client"}</span><span className="block break-words text-xs text-muted">{row.service_name || row.category_name || "Appointment"} · {row.duration_min} min{row.is_remote ? <> · <MapPin size={12} className="inline" /> home visit</> : ""}</span></span><span className="self-start whitespace-nowrap text-xs text-muted sm:self-auto">{row.transaction_id != null ? "Paid" : row.price_pence === 0 ? "No payment due" : row.price_pence == null ? "Price to agree" : money(row.price_pence)}</span></button></li>)}
          </ul> : <p className="px-5 py-3 text-sm text-muted">{todayError ? "Today's appointments are unavailable." : "No confirmed appointments today."}</p>}
          <div className="px-5 py-3"><Link to="/schedule" className="inline-flex items-center gap-2 text-sm font-medium text-ink-2 hover:underline"><CalendarHeart size={15} />Open schedule<ChevronRight size={14} /></Link></div>
        </Card>
        <Card>
          <CardHeader title="Needs your attention" />
          {inboxError ? <p className="px-5 pb-4 text-sm text-bad">To do is unavailable. Retry above.</p> : <ul className="pb-2 text-sm">
            <AttentionRow to="/todo" icon={<CalendarClock size={15} />} count={requests.length} loading={inboxPending} label={`${requests.length} booking request${requests.length === 1 ? "" : "s"}`} />
            <AttentionRow to="/todo" icon={<BanknoteArrowDown size={15} />} count={payments.length} loading={inboxPending} label={`${payments.length} payment${payments.length === 1 ? "" : "s"} to confirm`} detail={owed ? money(owed) : undefined} />
            <AttentionRow to="/mail" icon={<Mail size={15} />} count={mailError ? 0 : mail.unread_count} loading={mailLoading && mail.unread_count === 0} label={mailLabel} />
          </ul>}
          {!inboxError && !inboxPending && requests.length === 0 && payments.length === 0 && !mailError && !mailLoading && mail.unread_count === 0 && <p className="flex items-center gap-2 px-5 pb-4 text-[13px] text-muted"><CircleCheck size={15} className="text-good" /> All caught up</p>}
        </Card>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          hero
          label={`Profit in ${format(now, "MMMM")}`}
          value={figuresUnavailable ? figuresPlaceholder : money(cur.income - cur.expense)}
          delta={figuresUnavailable ? undefined : percentChange(cur.income - cur.expense, prev.income - prev.expense)}
          deltaLabel={prevLabel}
          icon={<Wallet size={17} />}
        />
        <KpiCard
          label="Income"
          value={figuresUnavailable ? figuresPlaceholder : money(cur.income)}
          delta={figuresUnavailable ? undefined : percentChange(cur.income, prev.income)}
          deltaLabel={prevLabel}
          icon={<PoundSterling size={17} />}
        />
        <KpiCard
          label="Expenses"
          value={figuresUnavailable ? figuresPlaceholder : money(cur.expense)}
          delta={figuresUnavailable ? undefined : percentChange(cur.expense, prev.expense)}
          deltaLabel={prevLabel}
          upIsGood={false}
          icon={<Receipt size={17} />}
        />
        <KpiCard label="Clients this month" value={clientsError ? "Unavailable" : clientsLoading ? "…" : String(clientsThisMonth)} icon={<Users size={17} />} />
      </div>


      {empty ? (
        <Card className="mt-6">
          <EmptyState icon={<Sparkles size={20} />} title="No income or expenses yet">
            Mark an appointment paid, or record income or an expense, and your charts will appear here.
            <div className="mt-4">
              <Button variant="primary" onClick={() => openNewEntry()}>
                <Plus size={15} /> Add income or expense
              </Button>
            </div>
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-3">
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
              <div className="grid grid-cols-1 gap-3 px-5 pb-4 sm:grid-cols-2">
                <div className="rounded-2xl bg-surface-2 p-3.5">
                  <div className="eyebrow text-[10px] text-ink-2">Income</div>
                  <FittedValue className="mt-1.5 min-w-0 font-display text-[22px] leading-none" value={taxMonthly.length === 0 && (taxError || taxLoading) ? taxError ? "Unavailable" : "…" : money(taxIncome)} />
                </div>
                <div className="rounded-2xl bg-surface-2 p-3.5">
                  <div className="eyebrow text-[10px] text-ink-2">Profit</div>
                  <FittedValue className={`mt-1.5 min-w-0 font-display text-[22px] leading-none ${taxProfit < 0 ? "text-bad" : ""}`} value={taxMonthly.length === 0 && (taxError || taxLoading) ? taxError ? "Unavailable" : "…" : money(taxProfit)} />
                </div>
              </div>
              <div className="px-5 pb-5">
                <div className="eyebrow mb-3 text-ink-2">Income by type</div>
                {incomeSources.length ? (
                  <CategoryDonut
                    centreLabel="Income"
                    data={incomeSources.map((source) => ({
                      key: source.service_id ? `service:${source.service_id}` : `${source.kind}:${source.id ?? "removed"}:${source.name}`,
                      name: source.kind === "other" ? `${source.name} (other income)` :
                        source.kind === "legacy" ? `${source.name} (legacy)` : source.name,
                      value: source.total,
                      colour: themedColour(source.colour, dark),
                    }))}
                  />
                ) : (
                  <p className="text-[13px] text-muted">{incomeError ? "Income sources are unavailable." : incomeLoading ? "Loading income sources…" : "No income this tax year yet."}</p>
                )}
              </div>
            </Card>
          </div>

          <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Profit per month" subtitle="Income minus expenses" />
              <div className="px-2 pb-4">
                <ProfitBars data={series} />
              </div>
            </Card>
            <Card>
              <CardHeader
                title="Recent income & expenses"
                action={
                  <Link to="/finances" className="eyebrow text-ink-2 underline decoration-rose underline-offset-4 hover:text-ink">
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

function greeting(now: Date) {
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** One line of the attention card, linking straight to where it's dealt with. */
function AttentionRow({ to, icon, label, count, loading, detail }: { to: string; icon: React.ReactNode; label: string; count: number; loading?: boolean; detail?: string }) {
  return <li>
    <Link to={to} className={`flex items-center gap-2.5 px-5 py-2 hover:bg-surface-2/60 ${count > 0 ? "font-medium text-ink" : "text-muted"}`}>
      <span className={count > 0 ? "text-rose" : "text-muted"}>{icon}</span>
      <span className="min-w-0 flex-1">{loading ? "Checking…" : label}</span>
      {detail && <span className="tabular text-xs text-ink-2">{detail}</span>}
      <ChevronRight size={14} className="shrink-0 text-muted" />
    </Link>
  </li>;
}
