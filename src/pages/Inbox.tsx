import { useEffect, useState } from "react";
import { Check, CircleCheck, Clock, Inbox, LoaderCircle, Mail, MapPin, RefreshCw, X } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { decideReschedule } from "@/lib/sync";
import { listPaymentConfirmations, markAppointmentPaid, setAppointmentStatus, type AppointmentRow } from "@/lib/db";
import { useData } from "@/lib/data";
import { useInbox } from "@/lib/inbox";
import { mailTime } from "@/lib/mail";
import { money, parseAmount, penceToInput, shortDate, timeLabel } from "@/lib/format";
import { useAccess } from "@/components/AccessGate";
import { PageHeader } from "@/components/Layout";
import { Button, Card, EmptyState, Field, Input } from "@/components/ui";
import { RemoteAppointmentMap } from "@/components/RemoteAppointmentMap";

export function InboxPage() {
  const access = useAccess();
  const { refresh, openEditAppointment } = useData();
  const { requests, payments, loading, error: loadError, mail, mailLoading, mailError, refreshMail } = useInbox();
  const emailSummary = mailError ? "email check unavailable" : mailLoading && mail.unread_count === 0 ? "checking email…" : `${mail.unread_count} unread email conversation${mail.unread_count === 1 ? "" : "s"}`;
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = async (row: AppointmentRow, approve: boolean) => {
    setBusy(row.id); setError(null);
    try {
      if (row.proposed_date) await decideReschedule(row.id, approve, row.cloud_revision);
      else await setAppointmentStatus(row.id, approve ? "confirmed" : "rejected", row.cloud_revision);
      refresh();
      toast.success(row.proposed_date ? approve ? "Reschedule approved" : "Reschedule rejected" : approve ? "Appointment accepted" : "Request rejected");
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
      toast.success(`${money(amount)} recorded`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not confirm this payment");
    } finally { setBusy(null); }
  };
  return <>
    <PageHeader title="Inbox" subtitle={`${requests.length} request${requests.length === 1 ? "" : "s"} · ${payments.length} payment${payments.length === 1 ? "" : "s"} to confirm · ${emailSummary}`} />
    {access.state !== "online" && <p className="mb-4 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink-2">You're offline. Reconnect to accept, reject or approve a new time.</p>}
    {error && <p role="alert" className="mb-4 text-sm text-bad">{error}</p>}
    {loadError && <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-sm text-bad">{loadError}<Button onClick={refresh}><RefreshCw size={14} /> Retry</Button></div>}
    {!loadError && !loading && !mailLoading && !mailError && requests.length === 0 && payments.length === 0 && mail.unread_count === 0 && <EmptyState icon={<Inbox size={20} />} title="All caught up" />}
    <section aria-labelledby="email-heading" className="mb-7">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 id="email-heading" className="font-display text-[24px]">Email <span className="font-sans text-sm text-muted">{mail.unread_count} unread</span></h2><Link to="/mail" className="text-sm text-ink-2 underline underline-offset-4">Open Mail</Link></div>
      {mailError && <div role="status" className="mb-3 flex flex-wrap items-center gap-2 text-sm text-ink-2"><span className="min-w-0 flex-1 break-words">Mail is temporarily unavailable. {mailError}</span><Button size="sm" disabled={access.state !== "online" || mailLoading} onClick={refreshMail}>Retry email</Button></div>}
      <Card>{mailLoading && mail.conversations.length === 0 ? <div role="status" className="flex items-center gap-2 px-5 py-6 text-sm text-muted"><LoaderCircle size={16} className="animate-spin" /> Checking email</div> : mail.conversations.length === 0 ? <div className="px-5 py-5 text-sm text-muted">{mailError ? "Appointment requests and payments are still available below." : "No unread email"}</div> : <ul className="divide-y divide-line">{mail.conversations.map(conversation => <li key={conversation.id}><Link to={`/mail/${encodeURIComponent(conversation.id)}`} className="flex min-w-0 items-start gap-3 px-5 py-4 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"><Mail size={17} className="mt-1 shrink-0 text-rose" /><div className="min-w-0 flex-1"><div className="flex flex-wrap justify-between gap-x-3 gap-y-1"><span className="break-words font-medium">{conversation.participant_name || conversation.participant_email}</span><time dateTime={conversation.last_message_at} className="text-xs text-muted">{mailTime(conversation.last_message_at)}</time></div><p className="mt-1 break-words text-sm font-medium">{conversation.subject || "(No subject)"}</p><p className="mt-1 line-clamp-2 break-words text-xs text-ink-2">{conversation.preview}</p></div></Link></li>)}</ul>}</Card>
    </section>
    <section aria-labelledby="requests-heading" className="mb-7">
    <h2 id="requests-heading" className="mb-3 font-display text-[24px]">Requests <span className="font-sans text-sm text-muted">{requests.length}</span></h2>
    <Card>
      {loading && requests.length === 0 ? <div role="status" className="flex items-center gap-2 px-5 py-10 text-sm text-muted"><LoaderCircle size={16} className="animate-spin" /> Loading requests</div> : requests.length === 0 ? <EmptyState icon={<Inbox size={20} />} title={loadError ? "Requests unavailable" : "No requests awaiting a decision"} /> : <ul className="divide-y divide-line">
        {requests.map((row) => <li key={row.id} className="flex flex-col items-stretch gap-4 px-5 py-4">
          <div className="w-full min-w-0">
            <button onClick={() => openEditAppointment(row)} className="max-w-full break-words text-left font-medium hover:underline cursor-pointer">{row.client_name || "Client"}</button>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2"><span>{row.service_name || row.category_name || "Appointment"}</span><span>{row.duration_min} min</span>{row.price_pence != null && <span className="tabular">{money(row.price_pence)}</span>}</div>
            {row.account_email && <p className="mt-1 break-all text-xs text-muted">{row.account_email}</p>}
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm"><Clock size={14} className="shrink-0 text-muted" /> {shortDate(row.date)} · {row.time_confirmed === 0 ? "Time to confirm" : timeLabel(row.start_time)}{row.proposed_date && row.time_confirmed !== 0 && <span className="text-muted"> (reserved)</span>}</p>
            {row.proposed_date && <p className="mt-1 text-sm font-medium">Requested: {shortDate(row.proposed_date)} · {row.proposed_time_confirmed === 0 ? "Time to confirm" : row.proposed_start_time ? timeLabel(row.proposed_start_time) : "Time to confirm"}</p>}
            {row.time_confirmed === 0 && <p className="mt-1 text-xs font-medium text-ink-2">A start time still needs to be agreed.</p>}
            {!!row.is_remote && <div className="mt-3"><p className="mb-2 flex items-center gap-1.5 text-xs font-medium"><MapPin size={13} /> Home visit</p><RemoteAppointmentMap address={row.visit_address} postcode={row.visit_postcode} /></div>}
            {row.customer_notes && <p className="mt-2 break-words text-[13px] text-ink-2">{row.customer_notes}</p>}
          </div>
          <div className="flex w-full flex-wrap justify-end gap-2">
            <Button disabled={busy != null || access.state !== "online"} onClick={() => void decide(row, false)}><X size={14} /> Reject</Button>
            <Button variant="primary" disabled={busy != null || access.state !== "online"} onClick={() => void decide(row, true)}>{busy === row.id ? <LoaderCircle size={14} className="animate-spin" /> : <Check size={14} />} {row.proposed_date ? row.proposed_time_confirmed === 0 ? "Approve date" : "Approve time" : row.time_confirmed === 0 ? "Accept date" : "Accept"}</Button>
          </div>
        </li>)}
      </ul>}
    </Card>
    </section>
    <section aria-labelledby="payments-heading">
      <h2 id="payments-heading" className="mb-3 font-display text-[24px]">Payment confirmations <span className="font-sans text-sm text-muted">{payments.length}</span></h2>
      <Card>
        {loading && payments.length === 0 ? <div role="status" className="flex items-center gap-2 px-5 py-10 text-sm text-muted"><LoaderCircle size={16} className="animate-spin" /> Loading payments</div> : payments.length === 0 ? <EmptyState icon={<CircleCheck size={20} />} title={loadError ? "Payments unavailable" : "No payments to confirm"} /> : <ul className="divide-y divide-line">
          {payments.map(row => <PaymentConfirmation key={row.id} row={row} busy={busy} onReview={() => openEditAppointment(row)} onConfirm={amount => void confirmPayment(row, amount)} />)}
        </ul>}
      </Card>
    </section>
  </>;
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
