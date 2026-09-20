import { useEffect, useRef, useState } from "react";
import { addDays, parseISO } from "date-fns";
import { toast } from "sonner";
import { BanknoteArrowDown, CalendarOff, Check, Repeat, Trash2, Undo2, UserX } from "lucide-react";
import {
  createAppointment,
  createAppointmentSeries,
  createClient,
  deleteAppointment,
  deleteAppointmentSeries,
  listCategories,
  listClients,
  markAppointmentPaid,
  seriesRemaining,
  setAppointmentStatus,
  updateAppointment,
  type AppointmentRow,
  type AppointmentStatus,
  type Category,
  type Client,
} from "@/lib/db";
import { useData } from "@/lib/data";
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
  const { appointment, closeAppointment: onClose, refresh } = useData();
  const { open, editing, draft } = appointment;

  const [date, setDate] = useState("");
  const [start, setStart] = useState("09:00");
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [categoryId, setCategoryId] = useState("");
  const [client, setClient] = useState<ClientChoice>({ id: null, name: "" });
  const [price, setPrice] = useState("");
  const [notes, setNotes] = useState("");
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

  const status = editing?.status ?? "booked";

  // Reset the form each time the dialog opens
  useEffect(() => {
    if (!open) return;
    Promise.all([listCategories("income"), listClients()]).then(([cats, cls]) => {
      setCategories(cats);
      setClients(cls);
      const first = cats[0];
      setDate(editing?.date ?? draft?.date ?? "");
      setStart(editing?.start_time ?? draft?.start_time ?? "09:00");
      setDuration(editing?.duration_min ?? DEFAULT_DURATION);
      setCategoryId(editing ? String(editing.category_id ?? "") : String(first?.id ?? ""));
      // A service's usual price only ever prefills a new booking.
      const usual = editing ? null : (first?.default_pence ?? null);
      setPrice(
        editing?.price_pence != null ? penceToInput(editing.price_pence) : usual != null ? penceToInput(usual) : "",
      );
      setPriceIsDefault(!editing && usual != null);
      const cid = editing?.client_id ?? draft?.clientId ?? null;
      setClient({ id: cid, name: cid ? (cls.find((c) => c.id === cid)?.name ?? "") : "" });
      setNotes(editing?.notes ?? "");
      setRepeatDays(0);
      setRepeatTimes(4);
      setError(null);
      setDeleting(null);
      // Start a new booking in the client box; leave an existing one alone to read.
      if (!editing && !cid) setTimeout(() => clientRef.current?.querySelector("input")?.focus(), 30);
    });
  }, [open, editing, draft]);

  /** Choosing a service fills in its usual price, unless a price has been typed. */
  const pickCategory = (id: string) => {
    setCategoryId(id);
    if (editing) return; // never rewrite the price on a booking that already exists
    const usual = categories.find((c) => String(c.id) === id)?.default_pence ?? null;
    if (!price.trim() || priceIsDefault) {
      setPrice(usual != null ? penceToInput(usual) : "");
      setPriceIsDefault(usual != null);
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
      if (pence == null || pence <= 0) {
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
    };
    if (editing) {
      await updateAppointment(editing.id, input);
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

  const payNow = () => {
    const pence = parseAmount(price);
    if (pence == null || pence <= 0) return setError("Add a price before marking this paid");
    run(async (id) => markAppointmentPaid(id), `${money(pence)} added to your money`);
  };

  /** Cancelled, no-show, or back to booked — none of them count as money. */
  const changeStatus = async (next: Exclude<AppointmentStatus, "paid">, done: string) => {
    if (!editing) return;
    setBusy(true);
    try {
      await setAppointmentStatus(editing.id, next);
      toast.success(done);
      refresh();
      onClose();
    } catch (e) {
      console.error(e);
      setError("Couldn't change it — please try again.");
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
      if (scope === "rest" && editing.series_id) {
        const n = await deleteAppointmentSeries(editing.series_id, editing.date);
        toast.success(`${n} appointments deleted`);
      } else {
        await deleteAppointment(editing.id);
        toast.success(status === "paid" ? "Appointment and its entry deleted" : "Appointment deleted");
      }
      refresh();
      onClose();
    } catch (e) {
      console.error(e);
      setError("Couldn't delete it — please try again.");
    }
  };

  const finish = start ? minToTime(timeToMin(start) + duration) : null;
  const dates = date && repeatDays ? repeatDates() : [];

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Appointment" : "New appointment"} width="max-w-lg">
      <form onSubmit={submit} className="space-y-4">
        <div ref={clientRef}>
          <Field label="Client">
            <ClientCombobox clients={clients} value={client} onChange={setClient} />
          </Field>
        </div>

        <Field label="Service">
          <Select value={categoryId} onChange={(e) => pickCategory(e.target.value)}>
            <option value="">No service</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Start">
            <Input type="time" step={300} value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Length" hint={finish ? `Finishes ${timeLabel(finish)}` : undefined}>
            <Select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map((d) => (
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

        <Field label="Note">
          <Textarea
            placeholder="e.g. Full body, dark shade — back door"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        {editing?.series_id && (
          <p className="flex items-center gap-2 text-[12.5px] text-muted">
            <Repeat size={13} /> One of a repeating booking. Changes here only affect this one.
          </p>
        )}

        {error && <p className="text-[13px] text-bad">{error}</p>}

        <PaymentStrip editing={editing} busy={busy} onPay={payNow} onStatus={changeStatus} />

        <div className="flex items-center justify-between pt-1">
          {editing ? (
            <Button type="button" variant="ghost" className="text-bad" onClick={askDelete}>
              <Trash2 size={15} /> Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant={editing ? "secondary" : "primary"} disabled={busy}>
              {editing ? "Save changes" : dates.length > 1 ? `Book ${dates.length}` : "Book appointment"}
            </Button>
          </div>
        </div>
      </form>

      <Modal open={deleting != null} onClose={() => setDeleting(null)} title="Delete appointment?" width="max-w-sm">
        <div className="text-sm text-ink-2">
          {status === "paid" && editing?.price_pence != null ? (
            <>
              This also removes the <b>{money(editing.price_pence)}</b> entry it added to your money tracking.
            </>
          ) : (
            "This takes it out of the diary. Nothing in your money tracking changes."
          )}
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
              Delete all {deleting}
            </Button>
          )}
          <Button variant="danger" onClick={() => remove("one")}>
            {deleting != null && deleting > 1 ? "Just this one" : "Delete"}
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
  onPay,
  onStatus,
}: {
  editing: AppointmentRow | null;
  busy: boolean;
  onPay: () => void;
  onStatus: (next: Exclude<AppointmentStatus, "paid">, done: string) => void;
}) {
  if (!editing) {
    return (
      <p className="rounded-2xl bg-surface-2 px-4 py-3 text-[13px] text-ink-2">
        Booking it doesn't touch your money. Open it and mark it paid once she's paid.
      </p>
    );
  }

  if (editing.status === "paid") {
    return (
      <div className="flex items-center gap-3 rounded-2xl bg-surface-2 px-4 py-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-good/15 text-good">
          <Check size={15} strokeWidth={3} />
        </span>
        <span className="min-w-0 flex-1 text-[13px] text-ink-2">Paid — in your money for {ukDate(editing.date)}.</span>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => onStatus("booked", "Marked unpaid — the entry has been removed")}
        >
          <Undo2 size={15} /> Mark unpaid
        </Button>
      </div>
    );
  }

  if (editing.status !== "booked") {
    const cancelled = editing.status === "cancelled";
    return (
      <div className="flex items-center gap-3 rounded-2xl bg-surface-2 px-4 py-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface text-muted">
          {cancelled ? <CalendarOff size={14} /> : <UserX size={14} />}
        </span>
        <span className="min-w-0 flex-1 text-[13px] text-ink-2">
          {cancelled ? "Cancelled" : "Didn't show"} — never counted in your money.
        </span>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => onStatus("booked", "Back in the diary")}>
          <Undo2 size={15} /> Undo
        </Button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 rounded-2xl bg-surface-2 px-4 py-3">
        <span className="min-w-0 flex-1 text-[13px] text-ink-2">Not counted in your money yet.</span>
        <Button type="button" variant="primary" onClick={onPay} disabled={busy}>
          <BanknoteArrowDown size={15} /> Mark paid
        </Button>
      </div>
      <div className="mt-2 flex justify-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => onStatus("cancelled", "Marked as cancelled")}
        >
          <CalendarOff size={14} /> Cancelled
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => onStatus("no_show", "Marked as a no-show")}
        >
          <UserX size={14} /> Didn't show
        </Button>
      </div>
    </div>
  );
}
