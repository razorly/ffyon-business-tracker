import { useEffect, useState } from "react";
import { BanknoteArrowDown, CalendarClock, Check, CircleCheck, Clock, LoaderCircle, MapPin, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { decideReschedule } from "@/lib/sync";
import { listPaymentConfirmations, markAppointmentPaid, setAppointmentStatus, type AppointmentRow } from "@/lib/db";
import { useData } from "@/lib/data";
import { useInbox } from "@/lib/inbox";
import { money, parseAmount, penceToInput, shortDate, timeLabel } from "@/lib/format";
import { useAccess } from "@/components/AccessGate";
import { PageHeader } from "@/components/Layout";
import { Button, Card, EmptyState, Field, Input } from "@/components/ui";
import { RemoteAppointmentMap } from "@/components/RemoteAppointmentMap";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Everything waiting on the owner: website booking requests, and finished appointments to mark paid. */
export function TodoPage() {
  const access = useAccess();
  const { refresh, openEditAppointment } = useData();
  const { requests, payments, loading, error: loadError } = useInbox();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owed = payments.reduce((sum, row) => sum + (row.price_pence ?? 0), 0);
  const clear = !loading && !loadError && requests.length === 0 && payments.length === 0;

  const decide = async (row: AppointmentRow, approve: boolean) => {
    setBusy(row.id); setError(null);
    try {
      if (row.proposed_date) await decideReschedule(row.id, approve, row.cloud_revision);
      else await setAppointmentStatus(row.id, approve ? "confirmed" : "rejected", row.cloud_revision);
      refresh();
      toast.success(row.proposed_date ? approve ? "New time approved" : "New time declined" : approve ? "Booking accepted" : "Request rejected");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update this request");
    } finally { setBusy(null); }
  };
  const confirmPayment = async (row: AppointmentRow, amount: number) => {
    setBusy(row.id); setError(null);
    try {
      const eligible = await listPaymentConfirmations();
      if (!eligible.some(item => item.id === row.id)) {
        refresh();
        toast.info("This appointment no longer needs payment confirmation");
        return;
      }
      await markAppointmentPaid(row.id, amount);
      refresh();
      toast.success(`${money(amount)} recorded as income`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not confirm this payment");
    } finally { setBusy(null); }
  };

  const summary = loading && requests.length === 0 && payments.length === 0 ? "Checking…"
    : clear ? "Nothing waiting" : [requests.length && plural(requests.length, "booking request"), payments.length && `${plural(payments.length, "payment")} to confirm`].filter(Boolean).join(" · ");

  return <>
    <PageHeader title="To do" subtitle={summary} />
    {access.state !== "online" && requests.length > 0 && <p className="mb-4 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink-2">You're offline. Reconnect to accept or reject booking requests. Payments can still be confirmed.</p>}
    {error && <p role="alert" className="mb-4 text-sm text-bad">{error}</p>}
    {loadError && <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-sm text-bad">{loadError}<Button onClick={refresh}><RefreshCw size={14} /> Retry</Button></div>}
    {clear && <Card><EmptyState icon={<CircleCheck size={20} />} title="All caught up">New booking requests and finished appointments waiting for payment will appear here.</EmptyState></Card>}

    {(requests.length > 0 || (loading && !clear)) && <section aria-labelledby="requests-heading" className="mb-7">
      <SectionHeading id="requests-heading" icon={<CalendarClock size={18} />} title="Booking requests" count={requests.length} hint="New bookings and time changes asked for on the website." />
      <Card>
        {loading && requests.length === 0 ? <Loading label="Loading requests" /> : <ul className="divide-y divide-line">
          {requests.map((row) => <li key={row.id} className="flex flex-col items-stretch gap-4 px-5 py-4">
            <div className="w-full min-w-0">
              <button onClick={() => openEditAppointment(row)} className="max-w-full break-words text-left font-medium hover:underline cursor-pointer">{row.client_name || "Client"}</button>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2"><span>{row.service_name || row.category_name || "Appointment"}</span><span>{row.duration_min} min</span>{row.price_pence != null && <span className="tabular">{money(row.price_pence)}</span>}</div>
              {row.account_email && <p className="mt-1 break-all text-xs text-muted">{row.account_email}</p>}
              {row.proposed_date ? <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted">Booked</dt><dd className="text-ink-2">{shortDate(row.date)} · {row.time_confirmed === 0 ? "Time to confirm" : timeLabel(row.start_time)}</dd>
                <dt className="font-medium">Wants</dt><dd className="font-medium">{shortDate(row.proposed_date)} · {row.proposed_time_confirmed === 0 || !row.proposed_start_time ? "Time to confirm" : timeLabel(row.proposed_start_time)}</dd>
              </dl> : <p className="mt-2 flex flex-wrap items-center gap-2 text-sm"><Clock size={14} className="shrink-0 text-muted" /> {shortDate(row.date)} · {row.time_confirmed === 0 ? "Time to confirm" : timeLabel(row.start_time)}</p>}
              {row.time_confirmed === 0 && !row.proposed_date && <p className="mt-1 text-xs font-medium text-ink-2">A start time still needs to be agreed.</p>}
              {!!row.is_remote && <div className="mt-3"><p className="mb-2 flex items-center gap-1.5 text-xs font-medium"><MapPin size={13} /> Home visit</p><RemoteAppointmentMap address={row.visit_address} postcode={row.visit_postcode} /></div>}
              {row.customer_notes && <p className="mt-2 break-words text-[13px] text-ink-2">{row.customer_notes}</p>}
            </div>
            <div className="flex w-full flex-wrap justify-end gap-2">
              <Button disabled={busy != null || access.state !== "online"} onClick={() => void decide(row, false)}><X size={14} /> {row.proposed_date ? "Keep current time" : "Reject"}</Button>
              <Button variant="primary" disabled={busy != null || access.state !== "online"} onClick={() => void decide(row, true)}>{busy === row.id ? <LoaderCircle size={14} className="animate-spin" /> : <Check size={14} />} {row.proposed_date ? "Approve new time" : row.time_confirmed === 0 ? "Accept date" : "Accept"}</Button>
            </div>
          </li>)}
        </ul>}
      </Card>
    </section>}

    {(payments.length > 0 || (loading && !clear)) && <section aria-labelledby="payments-heading">
      <SectionHeading id="payments-heading" icon={<BanknoteArrowDown size={18} />} title="Payments to confirm" count={payments.length} hint={`Finished appointments not yet marked paid${owed ? ` · ${money(owed)} agreed in total` : ""}. Nothing counts as income until you confirm it.`} />
      <Card>
        {loading && payments.length === 0 ? <Loading label="Loading payments" /> : <ul className="divide-y divide-line">
          {payments.map(row => <PaymentConfirmation key={row.id} row={row} busy={busy} onReview={() => openEditAppointment(row)} onConfirm={amount => void confirmPayment(row, amount)} />)}
        </ul>}
      </Card>
    </section>}
  </>;
}

function SectionHeading({ id, icon, title, count, hint }: { id: string; icon: React.ReactNode; title: string; count: number; hint: string }) {
  return <div className="mb-3">
    <h2 id={id} className="flex items-center gap-2 font-display text-[24px]"><span className="text-rose">{icon}</span>{title} <span className="font-sans text-sm text-muted">{count}</span></h2>
    <p className="mt-0.5 text-[13px] text-muted">{hint}</p>
  </div>;
}

function Loading({ label }: { label: string }) {
  return <div role="status" className="flex items-center gap-2 px-5 py-10 text-sm text-muted"><LoaderCircle size={16} className="animate-spin" /> {label}</div>;
}

function PaymentConfirmation({ row, busy, onReview, onConfirm }: {
  row: AppointmentRow; busy: number | null; onReview: () => void; onConfirm: (amount: number) => void;
}) {
  const [amount, setAmount] = useState(() => row.price_pence == null ? "" : penceToInput(row.price_pence));
  useEffect(() => setAmount(row.price_pence == null ? "" : penceToInput(row.price_pence)), [row.price_pence]);
  const pence = parseAmount(amount);
  const valid = pence != null && Number.isSafeInteger(pence) && pence > 0;
  const who = row.client_name || "Client";
  return <li data-testid={`payment-confirmation-${row.id}`} className="flex flex-col gap-4 px-5 py-4 xl:flex-row xl:items-end xl:justify-between">
    <div className="min-w-0">
      <button onClick={onReview} className="max-w-full break-words text-left font-medium hover:underline cursor-pointer">{who}</button>
      <p className="mt-1 break-words text-[13px] text-ink-2">{row.service_name || row.category_name || "Appointment"}</p>
      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm"><Clock size={14} className="shrink-0 text-muted" /> {shortDate(row.date)} · {row.time_confirmed === 0 ? "Date only" : timeLabel(row.start_time)}{row.is_remote !== 0 && <MapPin size={14} className="shrink-0 text-muted" aria-label="Home visit" />}</p>
      <p className="mt-1 text-xs text-muted">{row.price_pence == null ? "No agreed price recorded" : `Agreed price ${money(row.price_pence)}`}</p>
    </div>
    <form className="flex min-w-0 flex-wrap items-end gap-2 xl:shrink-0" onSubmit={event => { event.preventDefault(); if (valid && busy == null) onConfirm(pence!); }}>
      <div className="w-full min-w-0 sm:w-36"><Field label="Amount received"><Input aria-label={`Amount received for ${who}`} inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.00" disabled={busy != null} /></Field></div>
      <Button type="submit" variant="primary" disabled={!valid || busy != null}>{busy === row.id ? <LoaderCircle size={14} className="animate-spin" /> : <Check size={14} />} Confirm paid</Button>
    </form>
  </li>;
}
