import { useEffect, useState } from "react";
import { Check, LoaderCircle, MapPin } from "lucide-react";
import { toast } from "sonner";
import { listPaymentConfirmations, markAppointmentPaid, setAppointmentStatus, type AppointmentRow } from "@/lib/db";
import { useData } from "@/lib/data";
import { money, parseAmount, penceToInput, shortDate, timeLabel } from "@/lib/format";
import { decideReschedule } from "@/lib/sync";
import { Button, KindLabel, MoneyInput } from "./ui";

const when = (date: string, time: string, confirmed: number | boolean) => `${shortDate(date)}, ${confirmed ? timeLabel(time) : "time to confirm"}`;

/**
 * The two things that wait on her: website requests to answer and finished appointments to mark paid.
 * Today lists both; Money lists the payments again as "Still to collect". One set of rows, one set of rules.
 */
export function useNeedsYou() {
  const { refresh } = useData();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (row: AppointmentRow, approve: boolean) => {
    setBusy(row.id); setError(null);
    try {
      if (row.proposed_date) await decideReschedule(row.id, approve, row.cloud_revision);
      else await setAppointmentStatus(row.id, approve ? "confirmed" : "rejected", row.cloud_revision);
      refresh();
      toast.success(row.proposed_date ? approve ? "New time approved" : "New time declined" : approve ? "Booking accepted" : "Request declined");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this request");
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not confirm this payment");
    } finally { setBusy(null); }
  };
  return { busy, error, decide, confirmPayment };
}

/** A website booking request, or a request to move a booking, with its two answers beside it. */
export function RequestRow({ row, busy, online, onOpen, onDecide }: { row: AppointmentRow; busy: number | null; online: boolean; onOpen: () => void; onDecide: (approve: boolean) => void }) {
  const moving = Boolean(row.proposed_date);
  const service = row.service_name || row.category_name || "Appointment";
  return <li className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-3.5">
    <div className="min-w-0 flex-[1_1_12rem]">
      <KindLabel>{moving ? "Wants to move" : "Booking request"}</KindLabel>
      <button type="button" onClick={onOpen} className="max-w-full cursor-pointer break-words text-left font-semibold hover:underline">{row.client_name || "Client"}</button>
      {moving
        ? <p className="break-words text-small text-ink-2">{service} · from {when(row.date, row.start_time, row.time_confirmed)} to <span className="font-medium text-ink">{when(row.proposed_date!, row.proposed_start_time || "00:00", row.proposed_time_confirmed !== 0 && Boolean(row.proposed_start_time))}</span></p>
        : <p className="break-words text-small text-ink-2">{service} · {when(row.date, row.start_time, row.time_confirmed)}{row.price_pence != null && <> · <span className="tabular">{money(row.price_pence)}</span></>}</p>}
      {!!row.is_remote && <p className="flex items-center gap-1 break-words text-small text-ink-2"><MapPin size={13} className="shrink-0" aria-hidden /> Home visit{row.visit_postcode ? `, ${row.visit_postcode}` : ""}</p>}
      {row.customer_notes && <p className="line-clamp-2 break-words text-small text-ink-2">“{row.customer_notes}”</p>}
    </div>
    <div className="flex flex-wrap justify-end gap-2">
      <Button disabled={busy != null || !online} onClick={() => onDecide(false)}>{moving ? "Keep time" : "Decline"}</Button>
      <Button variant="primary" disabled={busy != null || !online} onClick={() => onDecide(true)}>{busy === row.id && <LoaderCircle size={16} className="animate-spin" aria-hidden />}{moving ? "Approve" : row.time_confirmed === 0 ? "Accept date" : "Accept"}</Button>
    </div>
  </li>;
}

/** A finished appointment not yet paid: one tap for the agreed price, or type what was received. */
export function PaymentRow({ row, busy, onOpen, onConfirm }: { row: AppointmentRow; busy: number | null; onOpen: () => void; onConfirm: (amount: number) => void }) {
  const agreed = row.price_pence != null && row.price_pence > 0 ? row.price_pence : null;
  const [other, setOther] = useState(agreed == null);
  const [amount, setAmount] = useState(() => agreed == null ? "" : penceToInput(agreed));
  useEffect(() => { setAmount(agreed == null ? "" : penceToInput(agreed)); setOther(agreed == null); }, [agreed]);
  const pence = parseAmount(amount);
  const valid = pence != null && Number.isSafeInteger(pence) && pence > 0;
  const who = row.client_name || "Client";
  return <li data-testid={`payment-confirmation-${row.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-3.5">
    <div className="min-w-0 flex-[1_1_12rem]">
      <KindLabel>Payment due</KindLabel>
      <button type="button" onClick={onOpen} className="max-w-full cursor-pointer break-words text-left font-semibold hover:underline">{who}</button>
      <p className="break-words text-small text-ink-2">{row.service_name || row.category_name || "Appointment"} · {shortDate(row.date)}{row.time_confirmed === 0 ? "" : `, ${timeLabel(row.start_time)}`}{row.is_remote !== 0 && " · home visit"}{agreed == null && " · no agreed price"}</p>
    </div>
    {other ? <form className="flex min-w-0 flex-wrap items-center justify-end gap-2" onSubmit={event => { event.preventDefault(); if (valid && busy == null) onConfirm(pence!); }}>
      <div className="w-32"><MoneyInput aria-label={`Amount received for ${who}`} value={amount} onChange={event => setAmount(event.target.value)} disabled={busy != null} autoFocus={agreed != null} /></div>
      <Button type="submit" variant="primary" disabled={!valid || busy != null}>{busy === row.id ? <LoaderCircle size={16} className="animate-spin" aria-hidden /> : <Check size={16} aria-hidden />} Confirm paid</Button>
    </form> : <div className="flex flex-wrap justify-end gap-2">
      <Button disabled={busy != null} onClick={() => setOther(true)}>Other amount</Button>
      <Button variant="primary" disabled={busy != null} onClick={() => onConfirm(agreed!)}>{busy === row.id ? <LoaderCircle size={16} className="animate-spin" aria-hidden /> : <Check size={16} aria-hidden />} Paid <span className="tabular">{money(agreed!)}</span></Button>
    </div>}
  </li>;
}
