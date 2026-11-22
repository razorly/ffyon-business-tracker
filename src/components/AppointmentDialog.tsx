import { useEffect, useId, useRef, useState } from "react";
import { addDays, format, parseISO } from "date-fns";
import { toast } from "sonner";
import { CalendarClock, CalendarOff, CalendarPlus, Check, Clock, Mail, MapPin, MessageSquare, Pencil, Phone, Repeat, Trash2, TriangleAlert, Undo2, UserX } from "lucide-react";
import {
  createAppointment,
  createAppointmentSeries,
  createClient,
  deleteAppointment,
  deleteAppointmentSeries,
  getAppointment,
  listAppointments,
  listClients,
  markAppointmentPaid,
  markAppointmentUnpaid,
  seriesRemaining,
  setAppointmentStatus,
  updateAppointment,
  type AppointmentRow,
  type AppointmentStatus,
  type ClientWithStats,
} from "@/lib/db";
import { useData, type AppointmentDraft } from "@/lib/data";
import { businessNow, useBusinessNow } from "@/lib/dates";
import { listBlocks, listCloudSettings, listServices, serviceDiscountPrice, type CloudBlock, type CloudService } from "@/lib/sync";
import { useAccess } from "./AccessGate";
import {
  durationLabel,
  isoDate,
  minToTime,
  money,
  parseAmount,
  penceToInput,
  shortDate,
  timeLabel,
  timeToMin,
  ukDate,
} from "@/lib/format";
import { Actions, Button, Checkbox, Chip, ErrorText, Field, Input, Loading, Modal, MoneyInput, Select, Textarea } from "./ui";
import { cn } from "@/lib/utils";
import { busyTimes, ChoiceGroup, clashWarnings, DayPicker, Disclosure, freeSlots, openingHours, OptionTile, TimePicker } from "./BookingPickers";
import { ClientCombobox, type ClientChoice } from "./ClientCombobox";
import { EntryModeSwitch } from "./EntryModeSwitch";
import { RemoteAppointmentMap } from "./RemoteAppointmentMap";

const DURATIONS = [15, 20, 30, 45, 60, 75, 90, 120];
const DEFAULT_DURATION = 30;
/** Callers that have no particular time in mind open a booking at this placeholder time. */
const DEFAULT_START = "09:00";
/** Past this many choices, tiles would fill the screen: a drop-down takes over. */
const MAX_TILES = 8;

/** Days between repeats. 0 means it doesn't repeat. */
const REPEATS = [
  { days: 0, label: "Doesn't repeat" },
  { days: 7, label: "Every week" },
  { days: 14, label: "Every 2 weeks" },
  { days: 21, label: "Every 3 weeks" },
  { days: 28, label: "Every 4 weeks" },
];

type View = "summary" | "edit" | "move";
type DayRows = { date: string; rows: AppointmentRow[] | null };

const dayLabel = (date: string, today: string) => date.slice(0, 4) === today.slice(0, 4) ? shortDate(date) : format(parseISO(date), "EEE d MMM yyyy");
const endLabel = (start: string, duration: number) => timeToMin(start) + duration === 1440 ? "midnight" : timeLabel(minToTime(timeToMin(start) + duration));
const whenLabel = (row: Pick<AppointmentRow, "date" | "start_time" | "duration_min" | "time_confirmed">, today: string) =>
  `${dayLabel(row.date, today)}, ${row.time_confirmed === 0 ? "time to confirm" : `${timeLabel(row.start_time)} to ${endLabel(row.start_time, row.duration_min)}`}`;
const minutesNow = (now: Date) => now.getHours() * 60 + now.getMinutes();

const linkButton = "btn-sm inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-xl border border-line bg-surface px-3 text-small font-medium text-ink transition-colors hover:bg-surface-2";

/**
 * Book an appointment, or look after one that exists. A new booking is "tap to pick": who, what,
 * which day, which free time. An existing one opens on a summary with the one thing most likely
 * needed next (accept, mark paid, book the next visit); the full form sits behind "Edit details".
 * Marking it paid is the only thing here that writes to the money tracking.
 */
export function AppointmentDialog() {
  const access = useAccess();
  const { appointment, closeAppointment: onClose, openNewAppointment, switchAppointmentToEntry, refresh } = useData();
  const { open, editing, draft } = appointment;
  const now = useBusinessNow();
  const today = isoDate(now);

  const [date, setDate] = useState("");
  const [start, setStart] = useState(DEFAULT_START);
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
  const [clients, setClients] = useState<ClientWithStats[]>([]);
  const [error, setError] = useState<string | null>(null);
  // true while the price box still holds a service's usual price the user hasn't touched
  const [priceIsDefault, setPriceIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadedFor, setLoadedFor] = useState<typeof appointment | null>(null);
  const ready = loadedFor === appointment;
  // null when closed, otherwise how many of this booking's run are still to come
  const [deleting, setDeleting] = useState<number | null>(null);
  const clientRef = useRef<HTMLDivElement>(null);

  // What the dialog shows, and what the free-time helpers know. None of this is saved.
  const [view, setView] = useState<View>("summary");
  const [moreOpen, setMoreOpen] = useState(false);
  const [otherAmount, setOtherAmount] = useState(false);
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof listCloudSettings>>>(null);
  const [blocks, setBlocks] = useState<CloudBlock[]>([]);
  const [day, setDay] = useState<DayRows | null>(null);

  const offline = access.state !== "online";

  // Reset the form each time the dialog opens
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoadedFor(null);
    setError(null);
    setDeleting(null);
    setView("summary");
    setMoreOpen(Boolean(editing));
    setOtherAmount(editing?.price_pence == null);
    const firstDate = editing?.date ?? draft?.date ?? "";
    Promise.all([
      listClients(), listServices(),
      // Opening hours, time off and the day's diary only feed the free-time helpers, so the form still opens without them.
      listCloudSettings().catch(() => null), listBlocks().catch(() => [] as CloudBlock[]),
      firstDate ? listAppointments({ from: firstDate, to: firstDate }).catch(() => null) : Promise.resolve(null),
    ]).then(([cls, catalog, hoursSettings, timeOff, firstRows]) => {
      if (!alive) return;
      setClients(cls);
      setServices(catalog);
      setSettings(hoursSettings);
      setBlocks(timeOff);
      setDay(firstDate ? { date: firstDate, rows: firstRows } : null);
      const firstService = catalog.find((s) => s.active && s.id === draft?.serviceId) ?? catalog.find((s) => s.active);
      const firstDuration = editing?.duration_min ?? firstService?.duration_min ?? DEFAULT_DURATION;
      // A clicked slot stays chosen. The placeholder time, or one that has already gone today, is
      // dropped when it isn't free, so she picks a time rather than booking one she never chose.
      let firstStart = editing?.start_time ?? draft?.start_time ?? DEFAULT_START;
      const hours = openingHours(firstDate, hoursSettings);
      if (!editing && hours && firstRows) {
        const clock = businessNow();
        const isToday = firstDate === isoDate(clock);
        const free = freeSlots(hours, busyTimes(firstDate, firstRows, timeOff), firstDuration, isToday ? minutesNow(clock) : -1);
        const gone = isToday && timeToMin(firstStart) < minutesNow(clock);
        if (!free.includes(firstStart) && (firstStart === DEFAULT_START || gone)) firstStart = "";
      }
      setServiceId(editing ? editing.service_id ?? "" : firstService?.id ?? "");
      setDate(firstDate);
      setStart(firstStart);
      setTimeConfirmed(editing ? editing.time_confirmed !== 0 : true);
      setRemote(Boolean(editing?.is_remote));
      setAddress(editing?.visit_address ?? "");
      setPostcode(editing?.visit_postcode ?? "");
      setSaveAddress(false);
      setDuration(firstDuration);
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

  // The diary for whichever day is chosen, for the free times and the clash warning.
  useEffect(() => {
    if (!open || !ready || !/^\d{4}-\d{2}-\d{2}$/.test(date) || day?.date === date) return;
    let alive = true;
    listAppointments({ from: date, to: date })
      .then((rows) => { if (alive) setDay({ date, rows }); })
      .catch(() => { if (alive) setDay({ date, rows: null }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready, date]);

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
      await updateAppointment(editing.id, input, editing.cloud_revision, editing.notes ?? null);
      return editing.id;
    }
    if (repeatDays) {
      const ids = await createAppointmentSeries(input, repeatDates());
      return ids[0];
    }
    return createAppointment(input);
  };

  /** A check that fails while the form is tucked away opens the form, so the problem is on screen. */
  const showProblem = () => {
    if (editing) setView((current) => current === "summary" ? "edit" : current);
    if (!timeConfirmed || remote || repeatDays > 0) setMoreOpen(true);
  };

  /** Saves, then runs `action` on the saved appointment. Anything that throws lands in the form. */
  const run = async (action: (id: number) => Promise<void>, done: string) => {
    if (busy || !ready) return;
    setBusy(true);
    try {
      const id = await save();
      if (id == null) return showProblem();
      await action(id);
      toast.success(done);
      refresh();
      onClose();
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : "Couldn't save. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // The summary has nothing to save; its buttons each do their own thing.
    if (editing && view === "summary") return;
    const booked = repeatDays ? `${repeatTimes} appointments booked` : "Appointment booked";
    run(async () => {}, editing ? "Appointment updated" : booked);
  };

  /** Records the payment: the amount given (one tap for the agreed price), or whatever is typed in "Amount received". */
  const payNow = async (amount?: number) => {
    if (!editing || busy || !ready) return;
    const pence = amount ?? parseAmount(received);
    if (pence == null || !Number.isSafeInteger(pence) || pence <= 0) return setError("Enter the amount received before recording payment");
    setBusy(true);
    try {
      const receipt = await markAppointmentPaid(editing.id, pence, editing.cloud_revision);
      if (receipt == null) toast.info("Payment already recorded");
      else toast.success(`${money(pence)} recorded as income`);
      refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record the payment");
    } finally {
      setBusy(false);
    }
  };

  const markUnpaid = async () => {
    if (!editing || editing.transaction_id == null || busy || !ready) return;
    setBusy(true);
    try {
      await markAppointmentUnpaid(editing.id, { id: editing.transaction_id, amountPence: editing.paid_amount_pence });
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
        if (id == null) return showProblem();
        const current = await getAppointment(id);
        await setAppointmentStatus(id, next, current?.cloud_revision);
      } else await setAppointmentStatus(editing.id, next, editing.cloud_revision);
      toast.success(done);
      refresh();
      onClose();
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : "Couldn't change it. Please try again.");
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

  /** Closes this appointment, then starts a new booking for the same client and service. */
  const bookNext = () => {
    if (!editing || busy) return;
    const next: AppointmentDraft = { date: today, start_time: DEFAULT_START, clientId: editing.client_id ?? undefined, serviceId: editing.service_id ?? undefined };
    onClose();
    // A new booking can't open while a dialog is still on screen, so wait for this one to go.
    const openWhenClear = (tries: number) => {
      if (!document.querySelector('[role="dialog"][aria-modal="true"]')) openNewAppointment(next);
      else if (tries > 0) window.setTimeout(() => openWhenClear(tries - 1), 30);
    };
    window.setTimeout(() => openWhenClear(20), 0);
  };

  const finish = timeConfirmed && start ? endLabel(start, duration) : null;
  const dates = date && repeatDays ? repeatDates() : [];
  const savedClient = clients.find((item) => item.id === client.id);
  const selectedService = services.find((service) => service.id === serviceId);
  const bookedServiceId = editing?.service_id ?? "";
  const bookedService = services.find((service) => service.id === bookedServiceId);
  const bookedServiceName = editing?.service_name || editing?.category_name || bookedService?.name || "Saved appointment";
  const quoteDiscount = editing && editing.service_id === (serviceId || null) && editing.price_pence === parseAmount(price)
    ? editing.discount_percent : priceIsDefault ? selectedService?.discount_percent ?? 0 : 0;

  // Free times and the clash warning for the chosen day. Helpers only: saving never depends on them.
  const hours = openingHours(date, settings);
  const dayRows = day && day.date === date ? day.rows : undefined; // undefined while loading, null if it couldn't load
  const busyThatDay = dayRows ? busyTimes(date, dayRows, blocks, editing?.id) : [];
  const slots = hours === null ? [] : hours && dayRows ? freeSlots(hours, busyThatDay, duration, date === today ? minutesNow(now) : -1) : null;
  const slotsLoading = ready && Boolean(date) && dayRows === undefined;
  const timeNote = hours === null ? `You're usually closed on ${format(parseISO(date), "EEEE")}s.`
    : slots && slots.length === 0 ? date === today ? "Nothing free for the rest of today." : "Nothing free on this day." : null;
  const timeChanged = !editing || date !== editing.date || start !== editing.start_time || duration !== editing.duration_min || timeConfirmed !== (editing.time_confirmed !== 0);
  const warnings = timeConfirmed && dayRows && timeChanged ? clashWarnings(date, start, duration, hours, busyThatDay) : [];

  const recentClients = clients.filter((item) => item.last_visit).sort((a, b) => b.last_visit!.localeCompare(a.last_visit!)).slice(0, 4);
  const otherServices = services.filter((s) => s.active && (!editing || s.id !== bookedServiceId));
  const bookedSuffix = bookedServiceId && !bookedService?.active ? " (archived)" : !bookedServiceId ? " (saved booking)" : "";

  const setConfirmed = (confirmed: boolean) => { setTimeConfirmed(confirmed); if (confirmed && start === "00:00") setStart(DEFAULT_START); };

  const dayAndTime = <>
    <DayPicker value={date} onChange={setDate} today={today} disabled={offline} />
    {timeConfirmed
      ? <TimePicker value={start} onChange={setStart} slots={slots} loading={slotsLoading} note={timeNote} finish={finish} disabled={offline} />
      : <ChoiceGroup label="Time"><p className="text-small text-ink-2">To be confirmed. It shows all day until a time is agreed, and other booking slots stay available.</p></ChoiceGroup>}
    {warnings.length > 0 && <div role="status" className="flex min-w-0 items-start gap-3 rounded-xl bg-surface-2 px-4 py-3 text-small text-ink">
      <TriangleAlert size={18} aria-hidden className="mt-0.5 shrink-0 text-rose-ink" />
      <div className="min-w-0 break-words">{warnings.map((warning) => <p key={warning} className="font-medium">{warning}</p>)}<p className="text-ink-2">You can still book it.</p></div>
    </div>}
  </>;

  const timeToConfirm = <Checkbox label="Time to confirm" checked={!timeConfirmed} disabled={offline} onChange={(event) => setConfirmed(!event.target.checked)} />;

  const closeButton = <Button type="button" disabled={busy} onClick={onClose}>Cancel</Button>;
  const offlineNote = offline && <p className="text-small text-ink-2">You're offline. Reconnect to change bookings. You can still record payments and private staff notes.</p>;

  /** The whole form: a new booking, or "Edit details" on an existing one. */
  const form = <>
    {!editing && draft?.fromEntry && <EntryModeSwitch value="appointment" onChange={(mode) => { if (mode !== "appointment" && !busy) switchAppointmentToEntry(mode, client); }} />}

    <div ref={clientRef} className="min-w-0">
      <Field label="Client">
        <fieldset disabled={offline} className="min-w-0"><ClientCombobox clients={clients} value={client} onChange={setClient} required={!editing || Boolean(editing.remote_id)} placeholder={!editing || editing.remote_id ? "Search or add a client" : "Search or add a client (optional)"} /></fieldset>
      </Field>
      {!editing && !client.name && recentClients.length > 0 && <div role="group" aria-label="Recent clients" className="mt-2 flex min-w-0 flex-wrap gap-2">
        {recentClients.map((item) => <Chip key={item.id} disabled={offline} onClick={() => setClient({ id: item.id, name: item.name })} className="min-w-0 max-w-full shrink"><span className="truncate">{item.name}</span></Chip>)}
      </div>}
    </div>

    {otherServices.length + (editing ? 1 : 0) > MAX_TILES ? (
      <Field label="Service">
        <Select value={serviceId} onChange={(e) => pickService(e.target.value)} disabled={offline}>
          {editing ? <option value={bookedServiceId}>{bookedServiceName}{bookedSuffix}</option> : <option value="" disabled>Choose a service</option>}
          {otherServices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </Field>
    ) : (
      <ChoiceGroup label="Service">
        {editing || otherServices.length > 0 ? <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          {editing && <OptionTile selected={serviceId === bookedServiceId} disabled={offline} onClick={() => pickService(bookedServiceId)}
            title={`${bookedServiceName}${bookedSuffix}`} detail={`${durationLabel(editing.duration_min)}${editing.price_pence != null ? ` · ${money(editing.price_pence)}` : ""}`} />}
          {otherServices.map((s) => <OptionTile key={s.id} selected={serviceId === s.id} disabled={offline} onClick={() => pickService(s.id)}
            title={s.name} detail={`${durationLabel(s.duration_min)} · ${money(s.booking_price_pence)}${s.discount_percent > 0 ? ` · ${s.discount_percent}% off` : ""}`} />)}
        </div> : <p className="text-small text-ink-2">{ready ? "No active services. Add one in Settings first." : "Loading services…"}</p>}
      </ChoiceGroup>
    )}
    {editing && bookedServiceId === serviceId && bookedService?.name && bookedService.name !== bookedServiceName && <p className="text-small text-ink-2">Now listed as {bookedService.name}. This booking keeps its agreed details.</p>}

    {dayAndTime}

    <div className="min-w-0">
      <Field label="Price (agreed total)" hint={remote ? "Include any home-visit fee in this total." : priceIsDefault ? "Usual price — type over it if this one's different" : undefined}>
        <MoneyInput value={price} disabled={offline} onChange={(e) => { setPrice(e.target.value); setPriceIsDefault(false); }} />
      </Field>
      {quoteDiscount > 0 && <p className="mt-1.5 text-small font-medium text-good">{quoteDiscount}% service discount included in this quote.</p>}
    </div>

    <Disclosure label="More options" open={moreOpen} onToggle={() => setMoreOpen((value) => !value)}>
      <Field label="Length">
        <Select value={duration} onChange={(e) => setDuration(Number(e.target.value))} disabled={offline}>
          {Array.from(new Set([...DURATIONS, duration])).sort((a, b) => a - b).map((d) => <option key={d} value={d}>{durationLabel(d)}</option>)}
        </Select>
      </Field>

      <div className="min-w-0">
        {timeToConfirm}
        <Checkbox label="Home visit" checked={remote} disabled={offline} onChange={(event) => setRemote(event.target.checked)} />
        {remote && <div className="mt-1 flex min-w-0 flex-col gap-3 border-l-2 border-line pl-4">
          {savedClient?.saved_address && savedClient?.saved_postcode && <Button type="button" className="self-start" disabled={offline} onClick={() => { setAddress(savedClient.saved_address); setPostcode(savedClient.saved_postcode); }}>Use saved address</Button>}
          <Field label="Address"><Textarea required maxLength={500} autoComplete="street-address" value={address} disabled={offline} onChange={(event) => setAddress(event.target.value)} /></Field>
          <Field label="Postcode"><Input required maxLength={12} autoComplete="postal-code" value={postcode} disabled={offline} onChange={(event) => setPostcode(event.target.value.toUpperCase())} /></Field>
          <Checkbox label="Save this address for future appointments" checked={saveAddress} disabled={offline || (!client.id && !client.name.trim())} onChange={(event) => setSaveAddress(event.target.checked)} />
          {address.trim() && postcode.trim() && <RemoteAppointmentMap address={address} postcode={postcode} />}
        </div>}
      </div>

      {!editing && <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Repeat" className="sm:col-span-2" hint={dates.length > 1 ? `${dates.length} appointments, last on ${ukDate(dates[dates.length - 1])}` : undefined}>
          <Select value={repeatDays} onChange={(e) => setRepeatDays(Number(e.target.value))}>
            {REPEATS.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
          </Select>
        </Field>
        {repeatDays > 0 && <Field label="How many">
          <Select value={repeatTimes} onChange={(e) => setRepeatTimes(Number(e.target.value))}>
            {Array.from({ length: 11 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n} times</option>)}
          </Select>
        </Field>}
      </div>}

      <Field label="Private staff note">
        <Textarea placeholder="e.g. Full body, dark shade — back door" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <Field label="Customer-visible note">
        <Textarea value={customerNotes} onChange={(e) => setCustomerNotes(e.target.value)} disabled={offline} />
      </Field>
    </Disclosure>

    {editing?.series_id && <p className="flex items-center gap-2 text-small text-ink-2"><Repeat size={14} aria-hidden className="shrink-0" /> One of a repeating booking. Changes here only affect this one.</p>}
    {offline && (editing ? offlineNote : <p className="text-small text-ink-2">You're offline. Reconnect to book an appointment.</p>)}
    {ready && error && <ErrorText>{error}</ErrorText>}

    {editing ? (
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <Button type="button" variant="ghost" className="text-bad hover:text-bad" disabled={offline || busy} onClick={askDelete}><Trash2 size={16} aria-hidden /> Delete booking</Button>
        <Actions className="ml-auto pt-0">{closeButton}<Button type="submit" variant="primary" disabled={busy}>Save changes</Button></Actions>
      </div>
    ) : <>
      <p className="text-small text-ink-2">Booking doesn't add any income until you mark it paid.</p>
      <Actions>{closeButton}<Button type="submit" variant="primary" disabled={busy || offline}>{dates.length > 1 ? `Book ${dates.length}` : "Book appointment"}</Button></Actions>
    </>}
  </>;

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} title={editing ? "Appointment" : "New appointment"} width="max-w-lg">
      {!ready && !error && <Loading label="Loading appointment details" className="px-0 pb-3 pt-0" />}
      {!ready && error && <ErrorText className="mb-3">{error}</ErrorText>}
      <form onSubmit={submit}>
        <fieldset disabled={busy || !ready} className="flex min-w-0 flex-col gap-4">
          {!editing || view === "edit" ? form
            : view === "move" ? <>
              <div className="min-w-0">
                <p className="break-words text-heading font-semibold">{editing.client_name || "No client"}</p>
                <p className="break-words text-small text-ink-2">{bookedServiceName} · currently <span className="tabular">{whenLabel(editing, today)}</span></p>
              </div>
              {dayAndTime}
              {!timeConfirmed && timeToConfirm}
              {ready && error && <ErrorText>{error}</ErrorText>}
              <Actions>{closeButton}<Button type="submit" variant="primary" disabled={busy || offline}>Save changes</Button></Actions>
            </>
            : <Summary editing={editing} today={today} serviceName={bookedServiceName} contact={clients.find((item) => item.id === editing.client_id)}
              busy={busy} offline={offline} error={ready ? error : null} offlineNote={offlineNote}
              received={received} onReceived={setReceived} otherAmount={otherAmount} onOtherAmount={() => setOtherAmount(true)}
              onPay={payNow} onUnpaid={markUnpaid} onStatus={changeStatus} onBookNext={bookNext} onView={setView} onClose={onClose} />}
        </fieldset>
      </form>

      <Modal open={deleting != null} onClose={() => { if (!busy) setDeleting(null); }} title="Delete appointment?" width="max-w-sm">
        <div className="text-body text-ink-2">
          This permanently removes the booking and its details from the app and website. Existing payments stay in your financial history, without booking details. This cannot be undone.
          {deleting != null && deleting > 1 && (
            <p className="mt-2">
              It repeats: <span className="font-semibold text-ink">{deleting}</span> of them are still to come, this one included.
            </p>
          )}
        </div>
        <Actions className="mt-5">
          <Button disabled={busy} onClick={() => setDeleting(null)}>Keep booking</Button>
          {deleting != null && deleting > 1 && (
            <Button variant="danger" disabled={busy} onClick={() => remove("rest")}>
              Delete all {deleting}
            </Button>
          )}
          <Button variant="danger" disabled={busy} onClick={() => remove("one")}>
            {deleting != null && deleting > 1 ? "Just this one" : "Delete booking"}
          </Button>
        </Actions>
      </Modal>
    </Modal>
  );
}

/** An existing booking at a glance: who, what, when, where it stands, and the next thing to do. */
function Summary({
  editing, today, serviceName, contact, busy, offline, error, offlineNote,
  received, onReceived, otherAmount, onOtherAmount, onPay, onUnpaid, onStatus, onBookNext, onView, onClose,
}: {
  editing: AppointmentRow;
  today: string;
  serviceName: string;
  contact: ClientWithStats | undefined;
  busy: boolean;
  offline: boolean;
  error: string | null;
  offlineNote: React.ReactNode;
  received: string;
  onReceived: (value: string) => void;
  otherAmount: boolean;
  onOtherAmount: () => void;
  onPay: (amount?: number) => void;
  onUnpaid: () => void;
  onStatus: (next: AppointmentStatus, done: string) => void;
  onBookNext: () => void;
  onView: (view: View) => void;
  onClose: () => void;
}) {
  const amountId = useId();
  const paid = editing.transaction_id != null;
  const confirmed = editing.status === "confirmed";
  const pending = editing.status === "pending";
  const status = pending ? "Booking request" : editing.status === "rejected" ? "Declined"
    : editing.status === "cancelled" ? "Cancelled" : editing.status === "no_show" ? "No-show" : "Confirmed";
  const payment = paid ? `Paid ${money(editing.paid_amount_pence ?? 0)}` : pending ? "Not answered yet"
    : editing.price_pence === 0 ? "No payment due" : confirmed ? "Not paid yet" : "No payment recorded";
  const kept = paid ? " Payment kept." : "";
  const agreed = editing.price_pence != null && editing.price_pence > 0 ? editing.price_pence : null;
  const phone = contact?.phone?.trim() ? contact.phone.replace(/[^\d+]/g, "") : "";
  const email = contact?.email?.trim() || editing.account_email?.trim() || "";

  return <>
    <div className="min-w-0">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <p className="min-w-0 break-words text-heading font-semibold">{editing.client_name || "No client"}</p>
        {editing.price_pence != null && <p className="tabular shrink-0 text-heading font-semibold">{money(editing.price_pence)}</p>}
      </div>
      <p className="break-words text-ink-2">{serviceName} · {durationLabel(editing.duration_min)}</p>
      <p className="tabular break-words font-medium">{whenLabel(editing, today)}</p>
      {(phone || email) && <div className="mt-3 flex min-w-0 flex-wrap gap-2">
        {phone && <a href={`tel:${phone}`} className={linkButton}><Phone size={14} aria-hidden /> Call</a>}
        {phone && <a href={`sms:${phone}`} className={linkButton}><MessageSquare size={14} aria-hidden /> Text</a>}
        {email && <Button type="button" size="sm" disabled={busy} onClick={() => { window.location.hash = `#/mail?to=${encodeURIComponent(email)}`; onClose(); }}><Mail size={14} aria-hidden /> Email</Button>}
      </div>}
    </div>

    <section aria-label="Booking status" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-surface-2 px-4 py-2.5">
      <span className={cn("shrink-0", paid ? "text-good" : "text-ink-2")}>
        {paid ? <Check size={18} aria-hidden /> : pending ? <Clock size={18} aria-hidden /> : confirmed ? <CalendarClock size={18} aria-hidden /> : editing.status === "no_show" ? <UserX size={18} aria-hidden /> : <CalendarOff size={18} aria-hidden />}
      </span>
      <p className="min-w-0 flex-1 break-words">
        {/* A confirmed, paid booking just says "Paid": the tick and the amount are the whole story. */}
        {!(confirmed && paid) && <><span className="font-medium">{status}</span> · </>}
        <span className={cn("tabular", paid ? "font-medium text-good" : "text-ink-2")}>{payment}</span>
      </p>
      {paid && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onUnpaid}><Undo2 size={14} aria-hidden /> Mark unpaid</Button>}
    </section>

    {!!editing.is_remote && <div className="min-w-0">
      <p className="mb-1 flex items-center gap-1.5 text-small font-medium"><MapPin size={14} aria-hidden className="shrink-0 text-ink-2" /> Home visit</p>
      <RemoteAppointmentMap address={editing.visit_address} postcode={editing.visit_postcode} />
    </div>}
    {editing.notes && <div className="min-w-0">
      <p className="text-small font-medium">Private staff note</p>
      <p className="whitespace-pre-line break-words text-ink-2">{editing.notes}</p>
    </div>}
    {editing.customer_notes && <div className="min-w-0">
      <p className="text-small font-medium">Customer-visible note</p>
      <p className="whitespace-pre-line break-words text-ink-2">{editing.customer_notes}</p>
    </div>}
    {editing.series_id && <p className="flex items-center gap-2 text-small text-ink-2"><Repeat size={14} aria-hidden className="shrink-0" /> One of a repeating booking.</p>}

    {error && <ErrorText>{error}</ErrorText>}

    {pending && <div className="flex flex-wrap gap-2">
      <Button type="button" className="flex-1" disabled={busy || offline} onClick={() => onStatus("rejected", "Request declined")}>Decline</Button>
      <Button type="button" variant="primary" className="flex-1" disabled={busy || offline} onClick={() => onStatus("confirmed", "Booking accepted")}><Check size={16} aria-hidden /> {editing.time_confirmed === 0 ? "Accept date" : "Accept"}</Button>
    </div>}

    {confirmed && !paid && editing.price_pence !== 0 && (otherAmount || agreed == null ? (
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        {/* Labelled by id so the name is exactly "Amount received", without the pound sign inside the box. */}
        <div className="min-w-32 flex-1">
          <label htmlFor={amountId} className="mb-1.5 block text-small font-medium text-ink">Amount received</label>
          <MoneyInput id={amountId} value={received} autoFocus={agreed != null} onChange={(e) => onReceived(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onPay(); } }} />
        </div>
        <Button type="button" variant="primary" disabled={busy} onClick={() => onPay()}><Check size={16} aria-hidden /> Mark paid</Button>
      </div>
    ) : (
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="primary" className="grow-[3]" disabled={busy} onClick={() => onPay(agreed)}><Check size={16} aria-hidden /><span>Mark paid <span className="tabular">{money(agreed)}</span></span></Button>
        <Button type="button" className="grow" disabled={busy} onClick={onOtherAmount}>Other amount</Button>
      </div>
    ))}

    {confirmed && paid && <Button type="button" variant="primary" disabled={busy || offline} onClick={onBookNext}><CalendarPlus size={16} aria-hidden /> Book next visit</Button>}

    <div className="grid min-w-0 grid-cols-1 gap-2 border-t border-line pt-4 min-[22.5rem]:grid-cols-2">
      {confirmed && <>
        <Button type="button" className="px-2" disabled={busy || offline} onClick={() => onView("move")}><CalendarClock size={16} aria-hidden /> Move</Button>
        <Button type="button" className="px-2" disabled={busy || offline} onClick={() => onStatus("cancelled", `Marked as cancelled.${kept}`)}><CalendarOff size={16} aria-hidden /> Cancel booking</Button>
        <Button type="button" className="px-2" disabled={busy || offline} onClick={() => onStatus("no_show", `Marked as a no-show.${kept}`)}><UserX size={16} aria-hidden /> No-show</Button>
      </>}
      {!confirmed && !pending && <Button type="button" className="px-2" disabled={busy || offline} onClick={() => onStatus("confirmed", "Booking restored")}><Undo2 size={16} aria-hidden /> Restore booking</Button>}
      <Button type="button" className={cn("px-2", pending && "min-[22.5rem]:col-span-2")} disabled={busy} onClick={() => onView("edit")}><Pencil size={16} aria-hidden /> Edit details</Button>
    </div>

    {offlineNote}
  </>;
}
