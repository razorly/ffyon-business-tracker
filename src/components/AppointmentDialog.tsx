import { useEffect, useId, useRef, useState } from "react";
import { addDays, parseISO } from "date-fns";
import { toast } from "sonner";
import { BanknoteArrowDown, CalendarOff, Check, Clock, MapPin, Repeat, Trash2, Undo2, UserX, X } from "lucide-react";
import {
  createAppointment,
  createAppointmentSeries,
  createClient,
  deleteAppointment,
  deleteAppointmentSeries,
  getAppointment,
  listClients,
  markAppointmentPaid,
  markAppointmentUnpaid,
  seriesRemaining,
  setAppointmentStatus,
  updateAppointment,
  type AppointmentRow,
  type AppointmentStatus,
  type Client,
} from "@/lib/db";
import { useData } from "@/lib/data";
import { listServices, serviceDiscountPrice, type CloudService } from "@/lib/sync";
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
import { Button, Field, Input, Modal, Select, Textarea } from "./ui";
import { cn } from "@/lib/utils";
import { ClientCombobox, type ClientChoice } from "./ClientCombobox";
import { EntryModeSwitch } from "./EntryModeSwitch";
import { RemoteAppointmentMap } from "./RemoteAppointmentMap";
import { TimeOffForm } from "./TimeOffForm";

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
  const { appointment, closeAppointment: onClose, switchAppointmentToEntry, refresh } = useData();
  const { open, editing, draft } = appointment;
  const [bookingMode, setBookingMode] = useState<"appointment" | "timeOff">("appointment");
  const [timeOffVisited, setTimeOffVisited] = useState(false);
  const bookingTabsId = useId();
  const allowTimeOff = !editing && Boolean(draft?.fromSchedule);
  const showTimeOff = allowTimeOff && bookingMode === "timeOff";

  const [date, setDate] = useState("");
  const [start, setStart] = useState("09:00");
  const [timeConfirmed, setTimeConfirmed] = useState(true);
  const [remote, setRemote] = useState(false);
  const [address, setAddress] = useState("");
  const [postcode, setPostcode] = useState("");
  const [saveAddress, setSaveAddress] = useState(false);
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [serviceId, setServiceId] = useState("");
  const [services, setServices] = useState<CloudService[]>([]);
  const [client, setClient] = useState<ClientChoice>({ id: null, name: "" });
  const [price, setPrice] = useState("");
  const [received, setReceived] = useState("");
  const [notes, setNotes] = useState("");
  const [customerNotes, setCustomerNotes] = useState("");
  const [repeatDays, setRepeatDays] = useState(0);
  const [repeatTimes, setRepeatTimes] = useState(4);
  const [clients, setClients] = useState<Client[]>([]);
  const [error, setError] = useState<string | null>(null);
  // true while the price box still holds a service's usual price the user hasn't touched
  const [priceIsDefault, setPriceIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadedFor, setLoadedFor] = useState<typeof appointment | null>(null);
  const ready = loadedFor === appointment;
  // null when closed, otherwise how many of this booking's run are still to come
  const [deleting, setDeleting] = useState<number | null>(null);
  const clientRef = useRef<HTMLDivElement>(null);

  const offline = access.state !== "online";

  // Reset the form each time the dialog opens
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setBookingMode("appointment");
    setTimeOffVisited(false);
    setLoadedFor(null);
    setError(null);
    setDeleting(null);
    Promise.all([listClients(), listServices()]).then(([cls, catalog]) => {
      if (!alive) return;
      setClients(cls);
      setServices(catalog);
      const firstService = catalog.find((s) => s.active && s.id === draft?.serviceId) ?? catalog.find((s) => s.active);
      setServiceId(editing ? editing.service_id ?? "" : firstService?.id ?? "");
      setDate(editing?.date ?? draft?.date ?? "");
      setStart(editing?.start_time ?? draft?.start_time ?? "09:00");
      setTimeConfirmed(editing ? editing.time_confirmed !== 0 : true);
      setRemote(Boolean(editing?.is_remote));
      setAddress(editing?.visit_address ?? "");
      setPostcode(editing?.visit_postcode ?? "");
      setSaveAddress(false);
      setDuration(editing?.duration_min ?? firstService?.duration_min ?? DEFAULT_DURATION);
      // A service's usual price only ever prefills a new booking.
      const usual = !editing && firstService ? serviceDiscountPrice(firstService.price_pence, firstService.discount_percent ?? 0) : null;
      setPrice(
        editing?.price_pence != null ? penceToInput(editing.price_pence) : usual != null ? penceToInput(usual) : "",
      );
      setPriceIsDefault(!editing && usual != null);
      setReceived(editing?.paid_amount_pence != null ? penceToInput(editing.paid_amount_pence) : editing?.price_pence != null ? penceToInput(editing.price_pence) : "");
      const cid = editing?.client_id ?? draft?.clientId ?? null;
      setClient({ id: cid, name: cid ? (cls.find((c) => c.id === cid)?.name ?? "") : draft?.clientName ?? "" });
      setNotes(editing?.notes ?? "");
      setCustomerNotes(editing?.customer_notes ?? "");
      setRepeatDays(0);
      setRepeatTimes(4);
      setError(null);
      setDeleting(null);
      setLoadedFor(appointment);
      // Start a new booking in the client box; leave an existing one alone to read.
      if (!editing && !cid) setTimeout(() => alive && clientRef.current?.querySelector("input")?.focus(), 30);
    }).catch((e) => { if (alive) setError(e instanceof Error ? e.message : "Could not load the appointment"); });
    return () => { alive = false; };
  }, [open, editing, draft]);

  const pickService = (id: string) => {
    if (id === serviceId) return;
    setServiceId(id);
    if (editing && id === (editing.service_id ?? "")) {
      setDuration(editing.duration_min);
      setPrice(editing.price_pence != null ? penceToInput(editing.price_pence) : "");
      setPriceIsDefault(false);
      return;
    }
    const service = services.find((s) => s.id === id);
    if (service) {
      setDuration(service.duration_min);
      setPrice(penceToInput(serviceDiscountPrice(service.price_pence, service.discount_percent ?? 0)));
      setPriceIsDefault(true);
    }
  };

  /** The dates a repeating booking would land on, this one included. */
  const repeatDates = () =>
    Array.from({ length: repeatDays ? repeatTimes : 1 }, (_, i) => isoDate(addDays(parseISO(date), i * repeatDays)));

  /** Validates and saves. Returns the appointment id, or null if something's missing. */
  const save = async (): Promise<number | null> => {
    if (!ready) return null;
    const selectedService = services.find((service) => service.id === serviceId);
    const preservesBookedService = Boolean(editing && (editing.service_id ?? "") === serviceId);
    if (!preservesBookedService && (!selectedService || !selectedService.active)) {
      setError("Choose an active service before booking");
      return null;
    }
    if (!date) {
      setError("Pick a date");
      return null;
    }
    if (timeConfirmed && !start) {
      setError("Pick a start time");
      return null;
    }
    if (timeConfirmed && timeToMin(start) + duration > 1440) {
      setError("The appointment must finish by midnight. Choose an earlier time or a shorter length.");
      return null;
    }
    if (remote && (!address.trim() || !postcode.trim())) {
      setError("Enter the visit address and postcode");
      return null;
    }
    if ((!editing || editing.remote_id) && !client.name.trim()) {
      setError("Choose a client or enter a new client's name.");
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
    if (!editing && pence == null) {
      setError("Enter the agreed total price before booking.");
      return null;
    }
    let clientId: number | null = client.id;
    if (!clientId && client.name.trim()) {
      clientId = await createClient({ name: client.name });
      setClient({ id: clientId, name: client.name.trim() });
    }
    const sameQuote = editing && editing.service_id === (serviceId || null) && editing.price_pence === pence;
    const input = {
      date,
      start_time: timeConfirmed ? start : "00:00",
      time_confirmed: timeConfirmed,
      duration_min: duration,
      client_id: clientId,
      category_id: editing?.category_id ?? null,
      price_pence: pence,
      base_price_pence: sameQuote ? editing.base_price_pence : priceIsDefault && selectedService ? selectedService.price_pence : pence,
      discount_percent: sameQuote ? editing.discount_percent : priceIsDefault ? selectedService?.discount_percent ?? 0 : 0,
      is_remote: remote,
      visit_address: remote ? address.trim() : "",
      visit_postcode: remote ? postcode.trim().toUpperCase() : "",
      save_visit_address: remote && saveAddress,
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
    if (busy || !ready) return;
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
    if (!editing || busy || !ready) return;
    const pence = parseAmount(received);
    if (pence == null || !Number.isSafeInteger(pence) || pence <= 0) return setError("Enter the amount received before recording payment");
    setBusy(true);
    try {
      await markAppointmentPaid(editing.id, pence);
      toast.success(`${money(pence)} recorded as income`);
      refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record the payment");
    } finally {
      setBusy(false);
    }
  };

  const markUnpaid = async () => {
    if (!editing || busy || !ready) return;
    setBusy(true);
    try {
      await markAppointmentUnpaid(editing.id);
      toast.success("Payment removed from income");
      refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove the payment");
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (next: AppointmentStatus, done: string) => {
    if (!editing || busy || !ready) return;
    setBusy(true);
    try {
      if (next === "confirmed") {
        const id = await save();
        if (id == null) return;
        const current = await getAppointment(id);
        await setAppointmentStatus(id, next, current?.cloud_revision);
      } else await setAppointmentStatus(editing.id, next, editing.cloud_revision);
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
    try { setDeleting(editing.series_id ? await seriesRemaining(editing.series_id, editing.date) : 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load this booking"); }
  };

  const remove = async (scope: "one" | "rest") => {
    if (!editing) return;
    setBusy(true);
    try {
      if (scope === "rest" && editing.series_id) await deleteAppointmentSeries(editing.series_id, editing.date);
      else await deleteAppointment(editing.id);
      setDeleting(null);
      toast.success(scope === "rest" ? "Appointments deleted. Payments retained." : "Appointment deleted. Payments retained.");
      refresh();
      onClose();
    } catch (e) {
      console.error(e);
      setDeleting(null);
      setError(e instanceof Error ? e.message : "Could not delete the booking. Please try again.");
    } finally { setBusy(false); }
  };

  const finish = timeConfirmed && start ? minToTime(timeToMin(start) + duration) : null;
  const finishesAtMidnight = timeConfirmed && start && timeToMin(start) + duration === 1440;
  const dates = date && repeatDays ? repeatDates() : [];
  const savedClient = clients.find((item) => item.id === client.id);
  const selectedService = services.find((service) => service.id === serviceId);
  const bookedServiceId = editing?.service_id ?? "";
  const bookedService = services.find((service) => service.id === bookedServiceId);
  const bookedServiceName = editing?.service_name || editing?.category_name || bookedService?.name || "Saved appointment";
  const quoteDiscount = editing && editing.service_id === (serviceId || null) && editing.price_pence === parseAmount(price)
    ? editing.discount_percent : priceIsDefault ? selectedService?.discount_percent ?? 0 : 0;

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} title={editing ? "Appointment" : showTimeOff ? "Add time off" : "New appointment"} width="max-w-lg">
      {allowTimeOff && <div role="tablist" aria-label="Booking type" className="mb-4 flex w-full rounded-full bg-surface-2 p-1">
        {(["appointment", "timeOff"] as const).map((mode) => <button key={mode} type="button" role="tab" id={`${bookingTabsId}-${mode}-tab`} aria-controls={`${bookingTabsId}-${mode}-panel`} aria-selected={bookingMode === mode} tabIndex={bookingMode === mode ? 0 : -1} disabled={busy}
          onClick={() => { setBookingMode(mode); if (mode === "timeOff") setTimeOffVisited(true); }}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "appointment" : event.key === "End" ? "timeOff" : mode === "appointment" ? "timeOff" : "appointment";
            setBookingMode(next); if (next === "timeOff") setTimeOffVisited(true);
            document.getElementById(`${bookingTabsId}-${next}-tab`)?.focus();
          }}
          className={cn("flex-1 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors cursor-pointer disabled:opacity-50", bookingMode === mode ? "bg-accent text-accent-ink shadow-sm" : "text-ink-2 hover:text-ink")}>
          {mode === "appointment" ? "Appointment" : "Time off"}
        </button>)}
      </div>}
      <div hidden={showTimeOff} role={allowTimeOff ? "tabpanel" : undefined} id={`${bookingTabsId}-appointment-panel`} aria-labelledby={allowTimeOff ? `${bookingTabsId}-appointment-tab` : undefined}>
      {!ready && !error && <p role="status" className="mb-3 text-sm text-muted">Loading appointment details…</p>}
      {!ready && error && <p role="alert" className="mb-3 text-sm text-bad">{error}</p>}
      <form onSubmit={submit}>
        <fieldset disabled={busy || !ready} className="space-y-4">
        {!editing && draft?.fromEntry && <EntryModeSwitch value="appointment" onChange={(mode) => { if (mode !== "appointment" && !busy) switchAppointmentToEntry(mode, client); }} />}
        {editing && <PaymentStrip editing={editing} busy={busy} offline={offline} received={received} onReceived={setReceived} onPay={payNow} onUnpaid={markUnpaid} onStatus={changeStatus} />}
        <div ref={clientRef}>
          <Field label="Client">
            <fieldset disabled={offline}><ClientCombobox clients={clients} value={client} onChange={setClient} required={!editing || Boolean(editing.remote_id)} placeholder={!editing || editing.remote_id ? "Search or add a client" : "Search or add a client (optional)"} /></fieldset>
          </Field>
        </div>

        <Field label="Service">
          <Select value={serviceId} onChange={(e) => pickService(e.target.value)} disabled={offline}>
            {editing ? (
              <option value={bookedServiceId}>
                {bookedServiceName}{bookedServiceId && !bookedService?.active ? " (archived)" : !bookedServiceId ? " (saved booking)" : ""}
              </option>
            ) : <option value="" disabled>{services.some((service) => service.active) ? "Choose a service" : "No active services"}</option>}
            {services.filter((s) => s.active && (!editing || s.id !== bookedServiceId)).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        {editing && bookedServiceId === serviceId && bookedService?.name && bookedService.name !== bookedServiceName && <p className="text-xs text-muted">Now listed as {bookedService.name}. This booking keeps its agreed details.</p>}

        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!timeConfirmed} disabled={offline} className="accent-accent" onChange={(event) => { setTimeConfirmed(!event.target.checked); if (!event.target.checked && start === "00:00") setStart("09:00"); }} /><Clock size={14} className="text-muted" /> Time to confirm</label>
        {!timeConfirmed && <p className="text-xs text-muted">Shown all day until a time is agreed. Other booking slots stay available.</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={offline} />
          </Field>
          <Field label="Start">
            <Input type="time" step={300} value={timeConfirmed ? start : ""} onChange={(e) => setStart(e.target.value)} disabled={offline || !timeConfirmed} />
          </Field>
          <Field label="Length" hint={finish ? `Finishes ${finishesAtMidnight ? "midnight" : timeLabel(finish)}` : undefined}>
            <Select value={duration} onChange={(e) => setDuration(Number(e.target.value))} disabled={offline}>
              {Array.from(new Set([...DURATIONS, duration])).sort((a, b) => a - b).map((d) => (
                <option key={d} value={d}>
                  {durationLabel(d)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Price (agreed total)" hint={remote ? "Include any home-visit fee in this total." : priceIsDefault ? "Usual price — type over it if this one's different" : undefined}>
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
        {quoteDiscount > 0 && <p className="text-xs font-medium text-good">{quoteDiscount}% service discount included in this quote.</p>}

        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={remote} disabled={offline} onChange={(event) => setRemote(event.target.checked)} className="accent-accent" /><MapPin size={14} className="text-muted" /> Home visit</label>
        {remote && <div className="space-y-3 border-l-2 border-line pl-3">
          {savedClient?.saved_address && savedClient?.saved_postcode && <Button type="button" size="sm" disabled={offline} onClick={() => { setAddress(savedClient.saved_address); setPostcode(savedClient.saved_postcode); }}>Use saved address</Button>}
          <Field label="Address"><Textarea required maxLength={500} autoComplete="street-address" value={address} disabled={offline} onChange={(event) => setAddress(event.target.value)} /></Field>
          <Field label="Postcode"><Input required maxLength={12} autoComplete="postal-code" value={postcode} disabled={offline} onChange={(event) => setPostcode(event.target.value.toUpperCase())} /></Field>
          <label className="flex items-start gap-2 text-xs text-ink-2"><input type="checkbox" checked={saveAddress} disabled={offline || (!client.id && !client.name.trim())} onChange={(event) => setSaveAddress(event.target.checked)} className="mt-0.5 accent-accent" />Save this address for future appointments</label>
          {address.trim() && postcode.trim() && <RemoteAppointmentMap address={address} postcode={postcode} />}
        </div>}

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

        {ready && error && <p role="alert" className="text-[13px] text-bad">{error}</p>}

        {!editing && <p className="rounded-2xl bg-surface-2 px-4 py-3 text-[13px] text-ink-2">
          Booking doesn't add any income. Mark the appointment paid once the client has paid.
        </p>}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          {editing ? (
            <Button type="button" variant="ghost" className="text-bad" disabled={offline || busy} onClick={askDelete}>
              <Trash2 size={15} /> Delete booking
            </Button>
          ) : (
            <span />
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button type="button" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant={editing ? "secondary" : "primary"} disabled={busy || (offline && !editing)}>
              {editing ? "Save changes" : dates.length > 1 ? `Book ${dates.length}` : "Book appointment"}
            </Button>
          </div>
        </div>
        </fieldset>
      </form>
      </div>
      {open && allowTimeOff && <div hidden={!showTimeOff} role="tabpanel" id={`${bookingTabsId}-timeOff-panel`} aria-labelledby={`${bookingTabsId}-timeOff-tab`}>
        {timeOffVisited && <TimeOffForm initialDate={ready ? date : draft?.date} initialStart={ready ? start : draft?.start_time} online={!offline} onClose={onClose} onBusyChange={setBusy} onSaved={() => { refresh(); onClose(); }} />}
      </div>}

      <Modal open={deleting != null} onClose={() => { if (!busy) setDeleting(null); }} title="Delete appointment?" width="max-w-sm">
        <div className="text-sm text-ink-2">
          This permanently removes the booking and its details from the app and website. Existing payments stay in your financial history, without booking details. This cannot be undone.
          {deleting != null && deleting > 1 && (
            <p className="mt-2">
              It repeats — <b>{deleting}</b> of them are still to come, this one included.
            </p>
          )}
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button disabled={busy} onClick={() => setDeleting(null)}>Keep booking</Button>
          {deleting != null && deleting > 1 && (
            <Button variant="danger" disabled={busy} onClick={() => remove("rest")}>
              Delete all {deleting}
            </Button>
          )}
          <Button variant="danger" disabled={busy} onClick={() => remove("one")}>
            {deleting != null && deleting > 1 ? "Just this one" : "Delete booking"}
          </Button>
        </div>
      </Modal>
    </Modal>
  );
}

/** The booking's state at a glance — booked, paid or not — with the next things to do. */
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
  editing: AppointmentRow;
  busy: boolean;
  offline: boolean;
  received: string;
  onReceived: (value: string) => void;
  onPay: () => void;
  onUnpaid: () => void;
  onStatus: (next: AppointmentStatus, done: string) => void;
}) {
  const paid = editing.transaction_id != null;
  const confirmed = editing.status === "confirmed";
  const pending = editing.status === "pending";
  const status = pending ? "Booking request" : editing.status === "rejected" ? "Request rejected"
    : editing.status === "cancelled" ? "Cancelled" : editing.status === "no_show" ? "No-show"
    : editing.time_confirmed === 0 ? "Confirmed · time to agree" : "Confirmed";
  const payment = paid ? `Paid ${money(editing.paid_amount_pence ?? 0)}` : pending ? "Waiting for your decision"
    : editing.price_pence === 0 ? "No payment due" : confirmed ? "Not paid yet" : "No payment recorded";
  const kept = paid ? " Payment kept." : "";

  return (
    <section aria-label="Booking status" className="rounded-2xl bg-surface-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full", paid ? "bg-good/15 text-good" : "bg-surface text-muted")}>
          {paid ? <Check size={13} strokeWidth={3} /> : pending ? <Clock size={13} /> : !confirmed ? editing.status === "no_show" ? <UserX size={13} /> : <CalendarOff size={13} /> : <BanknoteArrowDown size={13} />}
        </span>
        <span className="font-medium text-ink">{status}</span>
        <span className="text-ink-2">· {payment}</span>
        {paid && <Button type="button" variant="ghost" size="sm" className="ml-auto" disabled={busy} onClick={onUnpaid}><Undo2 size={14} /> Mark unpaid</Button>}
      </div>

      {pending && <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button type="button" disabled={busy || offline} onClick={() => onStatus("rejected", "Request rejected")}><X size={14} /> Reject</Button>
        <Button type="button" variant="primary" disabled={busy || offline} onClick={() => onStatus("confirmed", "Booking accepted")}><Check size={14} /> {editing.time_confirmed === 0 ? "Accept date" : "Accept"}</Button>
      </div>}

      {confirmed && !paid && editing.price_pence !== 0 && <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1"><Field label="Amount received"><Input inputMode="decimal" value={received} onChange={(e) => onReceived(e.target.value)} placeholder="0.00" /></Field></div>
        <Button type="button" variant="primary" onClick={onPay} disabled={busy}>
          <BanknoteArrowDown size={15} /> Mark paid
        </Button>
      </div>}

      {!pending && <div className="mt-2 flex flex-wrap justify-end gap-1 border-t border-line pt-2">
        {confirmed ? <>
          <Button type="button" variant="ghost" size="sm" disabled={busy || offline} onClick={() => onStatus("cancelled", `Marked as cancelled.${kept}`)}><CalendarOff size={14} /> Mark cancelled</Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy || offline} onClick={() => onStatus("no_show", `Marked as a no-show.${kept}`)}><UserX size={14} /> Mark no-show</Button>
        </> : <Button type="button" variant="ghost" size="sm" disabled={busy || offline} onClick={() => onStatus("confirmed", "Booking restored")}><Undo2 size={14} /> Restore booking</Button>}
      </div>}
    </section>
  );
}
