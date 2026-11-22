import { useMemo } from "react";
import { Link } from "react-router-dom";
import { addDays, format, subMonths } from "date-fns";
import { Check, ChevronRight, CircleCheck, Mail, MapPin, Plus } from "lucide-react";
import { distinctClients, listAppointments, monthlyTotals, type AppointmentRow, type MonthTotal } from "@/lib/db";
import { useData, useLoad } from "@/lib/data";
import { lastMonths, monthRange, useBusinessNow } from "@/lib/dates";
import { isoDate, money, percentChange, timeLabel } from "@/lib/format";
import { useInbox } from "@/lib/inbox";
import { useAccess } from "@/components/AccessGate";
import { PageHeader } from "@/components/Layout";
import { useSharedLedger } from "@/components/LedgerGate";
import { PaymentRow, RequestRow, useNeedsYou } from "@/components/NeedsYou";
import { Button, Card, ErrorText, LoadError, Loading, SectionHeading } from "@/components/ui";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const paidNote = (row: AppointmentRow) => row.transaction_id != null ? "Paid" : row.price_pence === 0 ? "No payment due" : row.price_pence == null ? "Price to agree" : money(row.price_pence);

/** The home page: what needs her, who is coming today, and how the month is going. */
export function Today() {
  const { openNewAppointment, openEditAppointment, refresh } = useData();
  const access = useAccess();
  const { ledger } = useSharedLedger();
  const online = access.state === "online";
  const { requests, payments, error: inboxError, loading: inboxLoading, mail, mailError } = useInbox();
  const now = useBusinessNow();
  const today = isoDate(now);
  const tomorrow = isoDate(addDays(now, 1));
  const months = lastMonths(now, 2);
  const thisMonth = monthRange(now);

  const [monthly, monthlyLoading, monthlyError] = useLoad<MonthTotal[]>(() => monthlyTotals(months[0] + "-01", thisMonth.to), [thisMonth.from], []);
  const [clientsThisMonth, clientsLoading, clientsError] = useLoad(() => distinctClients(thisMonth.from, thisMonth.to), [thisMonth.from], 0);
  const [dayRows, dayLoading, dayError] = useLoad(() => listAppointments({ from: today, to: tomorrow }), [today, tomorrow], []);
  const confirmed = (date: string) => dayRows.filter(row => row.date === date && row.status === "confirmed")
    .sort((a, b) => b.time_confirmed - a.time_confirmed || a.start_time.localeCompare(b.start_time));
  const todayAppointments = confirmed(today);
  const tomorrowAppointments = confirmed(tomorrow);

  const byMonth = useMemo(() => new Map(monthly.map(m => [m.month, m])), [monthly]);
  const cur = byMonth.get(months[1]) ?? { income: 0, expense: 0 };
  const prev = byMonth.get(months[0]) ?? { income: 0, expense: 0 };
  const profit = cur.income - cur.expense;
  const change = percentChange(profit, prev.income - prev.expense);
  const figuresUnavailable = monthly.length === 0 && (monthlyLoading || Boolean(monthlyError));
  const figure = (pence: number) => figuresUnavailable ? monthlyError ? "Unavailable" : "…" : money(pence);

  const { busy, error, decide, confirmPayment } = useNeedsYou();
  const todo = requests.length + payments.length;
  const inboxPending = inboxLoading && todo === 0;

  const summary = [format(now, "EEEE d MMMM"), !dayLoading && !dayError && plural(todayAppointments.length, "appointment") + " today", !inboxError && todo > 0 && `${plural(todo, "thing")} need${todo === 1 ? "s" : ""} you`].filter(Boolean).join(" · ");

  return (
    <>
      <PageHeader title={greeting(now)} subtitle={summary} />
      <LoadError error={monthlyError || clientsError || dayError || inboxError} onRetry={refresh} />

      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card aria-labelledby="needs-you-heading" role="region">
            <SectionHeading id="needs-you-heading" title="Needs you" count={inboxPending || inboxError ? undefined : todo} className="px-5 pb-2 pt-4" />
            {error && <ErrorText className="px-5 pb-3">{error}</ErrorText>}
            {inboxError ? <p className="px-5 pb-4 text-small text-bad">Booking requests and payments are unavailable. Retry above.</p>
              : inboxPending ? <Loading label="Checking what needs you" />
              : <ul className="divide-y divide-line border-t border-line">
                {requests.map(row => <RequestRow key={row.id} row={row} busy={busy} online={online} onOpen={() => openEditAppointment(row)} onDecide={approve => void decide(row, approve)} />)}
                {payments.map(row => <PaymentRow key={row.id} row={row} busy={busy} onOpen={() => openEditAppointment(row)} onConfirm={amount => void confirmPayment(row, amount)} />)}
                {todo === 0 && <li className="flex items-center gap-2 px-5 py-4 text-ink-2"><CircleCheck size={18} className="shrink-0 text-good" aria-hidden /> All caught up. New booking requests and payments to confirm appear here.</li>}
                {!mailError && mail.unread_count > 0 && <li>
                  <Link to="/mail" className="flex min-h-11 items-center gap-3 px-5 py-3 hover:bg-surface-2/60">
                    <Mail size={18} className="shrink-0 text-ink-2" aria-hidden />
                    <span className="min-w-0 flex-1 font-medium">{plural(mail.unread_count, "unread email")}</span>
                    <ChevronRight size={16} className="shrink-0 text-ink-2" aria-hidden />
                  </Link>
                </li>}
              </ul>}
            {!online && requests.length > 0 && <p className="border-t border-line px-5 py-3 text-small text-ink-2">
              {ledger ? "Reconnect to answer booking requests and confirm payments." : "Reconnect to accept or decline booking requests. Payments can still be confirmed."}
            </p>}
          </Card>

          <Card aria-labelledby="today-heading" role="region">
            <SectionHeading id="today-heading" title={`Today · ${format(now, "EEE d MMM")}`} className="px-5 pb-2 pt-4"
              action={<Button size="sm" disabled={!online} onClick={() => openNewAppointment({ date: today, start_time: "09:00" })}><Plus size={14} aria-hidden /> Book</Button>} />
            {dayLoading && todayAppointments.length === 0 ? <Loading label="Loading today's appointments" />
              : todayAppointments.length ? <ul className="divide-y divide-line border-t border-line">{todayAppointments.map(row => <AppointmentLine key={row.id} row={row} onOpen={() => openEditAppointment(row)} />)}</ul>
              : <p className="border-t border-line px-5 py-4 text-ink-2">{dayError ? "Today's appointments are unavailable." : "No confirmed appointments today."}</p>}
            <Link to="/schedule" className="flex min-h-11 items-center gap-1 border-t border-line px-5 py-3 text-small font-medium text-ink-2 hover:text-ink">Open diary <ChevronRight size={16} aria-hidden /></Link>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Card className="px-5 pb-2 pt-5" aria-label={`${format(now, "MMMM")} so far`} role="region">
            <div className="text-small text-ink-2">Profit in {format(now, "MMMM")}</div>
            <div className="tabular mt-1 break-words text-figure font-semibold">{figure(profit)}</div>
            {!figuresUnavailable && <div className={`text-small font-medium ${change == null || Math.round(change) === 0 ? "text-ink-2" : change > 0 ? "text-good" : "text-bad"}`}>
              {change == null ? `No figures for ${format(subMonths(now, 1), "MMMM")}` : Math.round(change) === 0 ? `Same as ${format(subMonths(now, 1), "MMMM")}`
                : `${change > 0 ? "Up" : "Down"} ${Math.abs(change).toFixed(0)}% on ${format(subMonths(now, 1), "MMMM")}`}
            </div>}
            <dl className="mt-4 divide-y divide-line text-small">
              <FigureLine label="Income" value={figure(cur.income)} />
              <FigureLine label="Expenses" value={figure(cur.expense)} />
              <FigureLine label="Clients seen" value={clientsError ? "Unavailable" : clientsLoading ? "…" : String(clientsThisMonth)} />
            </dl>
            <Link to="/finances" className="flex min-h-11 items-center gap-1 border-t border-line text-small font-medium text-ink-2 hover:text-ink">Open money <ChevronRight size={16} aria-hidden /></Link>
          </Card>

          <Card aria-labelledby="tomorrow-heading" role="region">
            <div className="px-5 pb-2 pt-4">
              <h2 id="tomorrow-heading" className="text-heading font-semibold">Tomorrow</h2>
              <p className="text-small text-ink-2">{format(addDays(now, 1), "EEEE d MMMM")}</p>
            </div>
            {tomorrowAppointments.length ? <ul className="divide-y divide-line border-t border-line">{tomorrowAppointments.map(row => <AppointmentLine key={row.id} row={row} compact onOpen={() => openEditAppointment(row)} />)}</ul>
              : <p className="border-t border-line px-5 py-4 text-ink-2">{dayError ? "Tomorrow's appointments are unavailable." : dayLoading ? "Loading…" : "Nothing booked yet."}</p>}
          </Card>
        </div>
      </div>
    </>
  );
}

function greeting(now: Date) {
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function FigureLine({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3 py-2.5"><dt className="text-ink-2">{label}</dt><dd className="tabular font-medium">{value}</dd></div>;
}

function AppointmentLine({ row, onOpen, compact }: { row: AppointmentRow; onOpen: () => void; compact?: boolean }) {
  const paid = row.transaction_id != null;
  return <li className="@container">
    <button type="button" onClick={onOpen} className="grid w-full min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-5 py-3 text-left hover:bg-surface-2/60 @min-[24rem]:grid-cols-[4rem_minmax(0,1fr)_auto]">
      <span className="tabular col-start-1 row-start-1 font-semibold">{row.time_confirmed === 0 ? "To agree" : timeLabel(row.start_time)}</span>
      <span className="col-span-2 row-start-2 min-w-0 @min-[24rem]:col-span-1 @min-[24rem]:col-start-2 @min-[24rem]:row-start-1">
        <span className="block break-words font-medium">{row.client_name || "Client"}</span>
        {!compact && <span className="block break-words text-small text-ink-2">{row.service_name || row.category_name || "Appointment"} · {row.duration_min} min{row.is_remote ? <> · <MapPin size={13} className="inline" aria-hidden /> home visit</> : ""}</span>}
        {compact && <span className="block break-words text-small text-ink-2">{row.service_name || row.category_name || "Appointment"}</span>}
      </span>
      {!compact && <span className={`tabular col-start-2 row-start-1 flex items-center gap-1 text-small @min-[24rem]:col-start-3 ${paid ? "font-medium text-good" : "text-ink-2"}`}>{paid && <Check size={15} aria-hidden />}{paidNote(row)}</span>}
    </button>
  </li>;
}
