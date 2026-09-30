import { useEffect, useRef, useState } from "react";
import { addDays, parseISO } from "date-fns";
import { toast } from "sonner";
import { BanknoteArrowDown, CalendarOff, Check, Clock, Repeat, Trash2, Undo2, UserX, X } from "lucide-react";
import {
  createAppointment,
  createAppointmentSeries,
  createClient,
  deleteAppointment,
  deleteAppointmentSeries,
  listCategories,
  listClients,
  markAppointmentPaid,
  markAppointmentUnpaid,
  seriesRemaining,
  setAppointmentStatus,
  updateAppointment,
  type AppointmentRow,
  type AppointmentStatus,
  type Category,
  type Client,
} from "@/lib/db";
import { useData } from "@/lib/data";
import { listServices, type CloudService } from "@/lib/sync";
import { useAccess } from "./AccessGate";
import {
  durationLabel,
  isoDate,
  minToTime,
  money,
  parseAmount,
  penceToInput,
  timeLabel,
  timeToMin,
  ukDate,
} from "@/lib/format";
import { toastDeleted } from "@/lib/undo";
import { Button, Field, Input, Modal, Select, Textarea } from "./ui";
import { ClientCombobox, type ClientChoice } from "./ClientCombobox";

const DURATIONS = [15, 20, 30, 45, 60, 75, 90, 120];
const DEFAULT_DURATION = 30;

/** Days between repeats. 0 means it doesn't repeat. */
const REPEATS = [
  { days: 0, label: "Doesn't repeat" },
  { days: 7, label: "Every week" },
  { days: 14, label: "Every 2 weeks" },
  { days: 21, label: "Every 3 weeks" },
  { days: 28, label: "Every 4 weeks" },
];

/**
 * Book, edit, and — the important bit — mark an appointment paid. Marking it paid
 * is the only thing here that writes to the money tracking; everything else stays
 * in the diary.
 */
export function AppointmentDialog() {
  const access = useAccess();
  const { appointment, closeAppointment: onClose, refresh } = useData();
  const { open, editing, draft } = appointment;

  const [date, setDate] = useState("");
  const [start, setStart] = useState("09:00");
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [categoryId, setCategoryId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [services, setServices] = useState<CloudService[]>([]);
  const [client, setClient] = useState<ClientChoice>({ id: null, name: "" });
  const [price, setPrice] = useState("");
  const [received, setReceived] = useState("");
  const [notes, setNotes] = useState("");
  const [customerNotes, setCustomerNotes] = useState("");
  const [repeatDays, setRepeatDays] = useState(0);
  const [repeatTimes, setRepeatTimes] = useState(4);
  const [categories, setCategories] = useState<Category[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [error, setError] = useState<string | null>(null);
  // true while the price box still holds a service's usual price the user hasn't touched
  const [priceIsDefault, setPriceIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  // null when closed, otherwise how many of this booking's run are still to come
  const [deleting, setDeleting] = useState<number | null>(null);
  const clientRef = useRef<HTMLDivElement>(null);

  const offline = access.state !== "online";

  // Reset the form each time the dialog opens
  useEffect(() => {
    if (!open) return;
    Promise.all([listCategories("income"), listClients(), listServices()]).then(([cats, cls, catalog]) => {
      setCategories(cats);
      setClients(cls);
      setServices(catalog);
      const firstService = catalog.find((s) => s.active);
      const first = cats.find((c) => c.service_id === firstService?.id) ?? cats[0];
      setServiceId(editing?.service_id ?? firstService?.id ?? "");
      setDate(editing?.date ?? draft?.date ?? "");
      setStart(editing?.start_time ?? draft?.start_time ?? "09:00");
      setDuration(editing?.duration_min ?? firstService?.duration_min ?? DEFAULT_DURATION);
      setCategoryId(editing ? String(editing.category_id ?? "") : String(first?.id ?? ""));
      // A service's usual price only ever prefills a new booking.
      const usual = editing ? null : (firstService?.price_pence ?? first?.default_pence ?? null);
      setPrice(
        editing?.price_pence != null ? penceToInput(editing.price_pence) : usual != null ? penceToInput(usual) : "",
      );
      setPriceIsDefault(!editing && usual != null);
      setReceived(editing?.paid_amount_pence != null ? penceToInput(editing.paid_amount_pence) : editing?.price_pence != null ? penceToInput(editing.price_pence) : "");
      const cid = editing?.client_id ?? draft?.clientId ?? null;
      setClient({ id: cid, name: cid ? (cls.find((c) => c.id === cid)?.name ?? "") : "" });
      setNotes(editing?.notes ?? "");
      setCustomerNotes(editing?.customer_notes ?? "");
      setRepeatDays(0);
      setRepeatTimes(4);
      setError(null);
      setDeleting(null);
      // Start a new booking in the client box; leave an existing one alone to read.
      if (!editing && !cid) setTimeout(() => clientRef.current?.querySelector("input")?.focus(), 30);
    }).catch((e) => setError(e instanceof Error ? e.message : "Could not load the appointment"));
  }, [open, editing, draft]);

  const pickService = (id: string) => {
    setServiceId(id);
    const service = services.find((s) => s.id === id);
    setCategoryId(String(categories.find((c) => c.service_id === id)?.id ?? ""));
    if (service) {
      setDuration(service.duration_min);
      setPrice(penceToInput(service.price_pence));
      setPriceIsDefault(true);
    }
  };

  /** The dates a repeating booking would land on, this one included. */
  const repeatDates = () =>
    Array.from({ length: repeatDays ? repeatTimes : 1 }, (_, i) => isoDate(addDays(parseISO(date), i * repeatDays)));

  /** Validates and saves. Returns the appointment id, or null if something's missing. */
  const save = async (): Promise<number | null> => {
    if (!date) {
      setError("Pick a date");
      return null;
    }
    if (!start) {
      setError("Pick a start time");
      return null;
    }
    let pence: number | null = null;
    if (price.trim()) {
      pence = parseAmount(price);
      if (pence == null || !Number.isSafeInteger(pence)) {
        setError("Enter a price, e.g. 25 or 27.50");
        return null;
      }
    }
    let clientId: number | null = client.id;
    if (!clientId && client.name.trim()) clientId = await createClient({ name: client.name });
    const input = {
      date,
      start_time: start,
      duration_min: duration,
      client_id: clientId,
      category_id: categoryId ? Number(categoryId) : null,
      price_pence: pence,
      notes: notes.trim() || null,
      service_id: serviceId || null,
      customer_notes: customerNotes.trim(),
    };
    if (editing) {
      await updateAppointment(editing.id, input, editing.cloud_revision);
      return editing.id;
    }
    if (repeatDays) {
      const ids = await createAppointmentSeries(input, repeatDates());
      return ids[0];
    }
    return createAppointment(input);
  };

  /** Saves, then runs `action` on the saved appointment. Anything that throws lands in the form. */
  const run = async (action: (id: number) => Promise<void>, done: string) => {
    setBusy(true);
    try {
      const id = await save();
      if (id == null) return;
      await action(id);
      toast.success(done);
      refresh();
      onClose();
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : "Couldn't save — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const booked = repeatDays ? `${repeatTimes} appointments booked` : "Appointment booked";
    run(async () => {}, editing ? "Appointment updated" : booked);
  };

  const payNow = async () => {
    if (!editing) return;
    const pence = parseAmount(received);
    if (pence == null || pence <= 0) return setError("Enter the amount received before recording payment");
    setBusy(true);
    try {
      await markAppointmentPaid(editing.id, pence);
      toast.success(`${money(pence)} added to your money`);
      refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record the payment");
    } finally {
      setBusy(false);
    }
  };

  const markUnpaid = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await markAppointmentUnpaid(editing.id);
      toast.success("Payment entry removed");
      refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove the payment");
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (next: AppointmentStatus, done: string) => {
    if (!editing) return;
    setBusy(true);
    try {
      await setAppointmentStatus(editing.id, next, editing.cloud_revision);
      toast.success(done);
      refresh();
      onClose();
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : "Couldn't change it — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const askDelete = async () => {
    if (!editing) return;
    setDeleting(editing.series_id ? await seriesRemaining(editing.series_id, editing.date) : 1);
  };

  const remove = async (scope: "one" | "rest") => {
    if (!editing) return;
    setDeleting(null);
    try {
      if (scope === "one" && editing.remote_id) {
        await setAppointmentStatus(editing.id, "cancelled", editing.cloud_revision);
        toast.success("Appointment cancelled");
        refresh();
        onClose();
        return;
      }
      const removed =
        scope === "rest" && editing.series_id
          ? await deleteAppointmentSeries(editing.series_id, editing.date)
          : await deleteAppointment(editing.id);
      toastDeleted(removed, refresh);
      refresh();
      onClose();
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : "Couldn't cancel it — please try again.");
    }
  };

  const finish = start ? minToTime(timeToMin(start) + duration) : null;
  const dates = date && repeatDays ? repeatDates() : [];

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Appointment" : "New appointment"} width="max-w-lg">
      <form onSubmit={submit} className="space-y-4">
        <div ref={clientRef}>
          <Field label="Client">
            <fieldset disabled={offline}><ClientCombobox clients={clients} value={client} onChange={setClient} /></fieldset>
          </Field>
        </div>

        <Field label="Service">
          <Select value={serviceId} onChange={(e) => pickService(e.target.value)} disabled={offline}>
            <option value="">No service selected</option>
            {services.filter((s) => s.active || s.id === editing?.service_id).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{!s.active ? " (archived)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        {editing?.service_name && editing.service_id === serviceId && services.find((s) => s.id === serviceId)?.name !== editing.service_name && <p className="text-xs text-muted">Booked service: {editing.service_name}</p>}

        <div className="grid grid-cols-3 gap-3">
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={offline} />
          </Field>
          <Field label="Start">
            <Input type="time" step={300} value={start} onChange={(e) => setStart(e.target.value)} disabled={offline} />
          </Field>
          <Field label="Length" hint={finish ? `Finishes ${timeLabel(finish)}` : undefined}>
            <Select value={duration} onChange={(e) => setDuration(Number(e.target.value))} disabled={offline}>
              {Array.from(new Set([...DURATIONS, duration])).sort((a, b) => a - b).map((d) => (
                <option key={d} value={d}>
                  {durationLabel(d)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Price" hint={priceIsDefault ? "Usual price — type over it if this one's different" : undefined}>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">£</span>
            <Input
              inputMode="decimal"
              placeholder="0.00"
              className="pl-7 tabular"
              value={price}
              disabled={offline}
              onChange={(e) => {
                setPrice(e.target.value);
                setPriceIsDefault(false);
              }}
            />
          </div>
        </Field>

        {!editing && (
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field
                label="Repeat"
                hint={dates.length > 1 ? `${dates.length} appointments, last on ${ukDate(dates[dates.length - 1])}` : undefined}
              >
                <Select value={repeatDays} onChange={(e) => setRepeatDays(Number(e.target.value))}>
                  {REPEATS.map((r) => (
                    <option key={r.days} value={r.days}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {repeatDays > 0 && (
              <Field label="How many">
                <Select value={repeatTimes} onChange={(e) => setRepeatTimes(Number(e.target.value))}>
                  {Array.from({ length: 11 }, (_, i) => i + 2).map((n) => (
                    <option key={n} value={n}>
                      {n} times
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        )}

        <Field label="Private staff note">
          <Textarea
            placeholder="e.g. Full body, dark shade — back door"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <Field label="Customer-visible note">
          <Textarea value={customerNotes} onChange={(e) => setCustomerNotes(e.target.value)} disabled={offline} />
        </Field>
        {offline && <p className="text-xs text-muted">Reconnect to change bookings. Local payments and private staff notes remain available.</p>}

        {editing?.series_id && (
          <p className="flex items-center gap-2 text-[12.5px] text-muted">
            <Repeat size={13} /> One of a repeating booking. Changes here only affect this one.
          </p>
        )}

        {error && <p className="text-[13px] text-bad">{error}</p>}

        <PaymentStrip editing={editing} busy={busy} offline={offline} received={received} onReceived={setReceived} onPay={payNow} onUnpaid={markUnpaid} onStatus={changeStatus} />

        <div className="flex items-center justify-between pt-1">
          {editing ? (
            <Button type="button" variant="ghost" className="text-bad" disabled={offline || busy} onClick={askDelete}>
              <Trash2 size={15} /> Cancel booking
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant={editing ? "secondary" : "primary"} disabled={busy || (offline && !editing)}>
              {editing ? "Save changes" : dates.length > 1 ? `Book ${dates.length}` : "Book appointment"}
            </Button>
          </div>
        </div>
      </form>

      <Modal open={deleting != null} onClose={() => setDeleting(null)} title="Cancel appointment?" width="max-w-sm">
        <div className="text-sm text-ink-2">
          This cancels the booking on the website and frees its time. Existing payments remain in your money tracking.
          {deleting != null && deleting > 1 && (
            <p className="mt-2">
              It repeats — <b>{deleting}</b> of them are still to come, this one included.
            </p>
          )}
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button onClick={() => setDeleting(null)}>Cancel</Button>
          {deleting != null && deleting > 1 && (
            <Button variant="danger" onClick={() => remove("rest")}>
              Cancel all {deleting}
            </Button>
          )}
          <Button variant="danger" onClick={() => remove("one")}>
            {deleting != null && deleting > 1 ? "Just this one" : "Cancel booking"}
          </Button>
        </div>
      </Modal>
    </Modal>
  );
}

/** Says plainly whether this appointment is counted in the money yet, and switches it. */
function PaymentStrip({
  editing,
  busy,
  offline,
  received,
  onReceived,
  onPay,
  onUnpaid,
  onStatus,
}: {
  editing: AppointmentRow | null;
  busy: boolean;
  offline: boolean;
  received: string;
  onReceived: (value: string) => void;
  onPay: () => void;
  onUnpaid: () => void;
  onStatus: (next: AppointmentStatus, done: string) => void;
}) {
  if (!editing) {
    return (
      <p className="rounded-2xl bg-surface-2 px-4 py-3 text-[13px] text-ink-2">
        Booking it doesn't touch your money. Open it and mark it paid once she's paid.
      </p>
    );
  }

  const statusLabel = editing.status === "confirmed" ? "Confirmed" : editing.status === "pending" ? "Awaiting approval" : editing.status === "rejected" ? "Rejected" : editing.status === "cancelled" ? "Cancelled" : "Didn't show";
  if (editing.transaction_id != null) {
    return (
      <div className="flex items-center gap-3 rounded-2xl bg-surface-2 px-4 py-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-good/15 text-good">
          <Check size={15} strokeWidth={3} />
        </span>
        <span className="min-w-0 flex-1 text-[13px] text-ink-2">{statusLabel} · {money(editing.paid_amount_pence ?? 0)} received for {ukDate(editing.date)}.</span>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={onUnpaid}
        >
          <Undo2 size={15} /> Mark unpaid
        </Button>
      </div>
    );
  }

  if (editing.status === "pending") {
    return <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface-2 px-4 py-3">
      <Clock size={16} className="text-muted" />
      <span className="min-w-0 flex-1 text-[13px] text-ink-2">Awaiting approval</span>
      <Button type="button" disabled={busy || offline} onClick={() => onStatus("rejected", "Request rejected")}><X size={14} /> Reject</Button>
      <Button type="button" variant="primary" disabled={busy || offline} onClick={() => onStatus("confirmed", "Appointment accepted")}><Check size={14} /> Accept</Button>
    </div>;
  }

  if (editing.status !== "confirmed") {
    const cancelled = editing.status === "cancelled";
    return (
      <div className="flex items-center gap-3 rounded-2xl bg-surface-2 px-4 py-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface text-muted">
          {cancelled ? <CalendarOff size={14} /> : <UserX size={14} />}
        </span>
        <span className="min-w-0 flex-1 text-[13px] text-ink-2">
          {statusLabel} · no payment recorded.
        </span>
        <Button type="button" variant="ghost" disabled={busy || offline} onClick={() => onStatus("confirmed", "Appointment confirmed")}>
          <Undo2 size={15} /> Confirm
        </Button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 rounded-2xl bg-surface-2 px-4 py-3">
        <div className="min-w-0 flex-1"><Field label="Amount received"><Input inputMode="decimal" value={received} onChange={(e) => onReceived(e.target.value)} placeholder="0.00" /></Field></div>
        <Button type="button" variant="primary" onClick={onPay} disabled={busy}>
          <BanknoteArrowDown size={15} /> Mark paid
        </Button>
      </div>
      <div className="mt-2 flex justify-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy || offline}
          onClick={() => onStatus("cancelled", "Marked as cancelled")}
        >
          <CalendarOff size={14} /> Cancelled
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy || offline}
          onClick={() => onStatus("no_show", "Marked as a no-show")}
        >
          <UserX size={14} /> Didn't show
        </Button>
      </div>
    </div>
  );
}
