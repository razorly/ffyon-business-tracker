import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Archive, Pencil, Plus, RotateCcw, Upload } from "lucide-react";
import { toast } from "sonner";
import { listAppointments, type AppointmentRow } from "@/lib/db";
import { useData } from "@/lib/data";
import { durationLabel, money, parseAmount, penceToInput, timeLabel, timeToMin, ukDate } from "@/lib/format";
import {
  getImportPreview, getSyncState, importLegacyRecords, listBlocks, listCloudSettings, listNotificationStatus,
  listServices, saveService, serviceDiscountPrice, subscribeSync, updateCloudSettings,
} from "@/lib/sync";
import { useAccess } from "@/components/AccessGate";
import { Actions, Button, Card, CardHeader, Checkbox, ErrorText, Field, Input, Loading, Modal, MoneyInput, Switch, Textarea } from "@/components/ui";
import { Help, OnlineNotice, SaveBar, SubHeading, SwitchHeader } from "@/components/settings/parts";

type Service = Awaited<ReturnType<typeof listServices>>[number];
type Block = Awaited<ReturnType<typeof listBlocks>>[number];
type BusinessSettings = NonNullable<Awaited<ReturnType<typeof listCloudSettings>>>;
type ImportPreview = Awaited<ReturnType<typeof getImportPreview>>;
type OpeningDay = { weekday: number; enabled: boolean; open: string; close: string };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Her week reads Monday to Sunday. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const emptyPreview: ImportPreview = { clients: [], appointments: [], services: [] };
const failureMessage = (error: unknown) => error instanceof Error ? error.message : "Couldn't save. Try again.";

/**
 * Everything the website shares with the tracker: services, time off, booking settings and anything
 * still waiting to be brought across. Loaded once for the whole Settings page, so the opening-hours
 * form keeps its unsaved changes while she moves between sections.
 */
export function useSiteSettings() {
  const access = useAccess();
  const { version, refresh } = useData();
  const [services, setServices] = useState<Service[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [settings, setSettings] = useState<BusinessSettings | null>(null);
  const [preview, setPreview] = useState<ImportPreview>(emptyPreview);
  const [appointments, setAppointments] = useState<AppointmentRow[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const online = access.state === "online";

  useEffect(() => {
    let alive = true;
    Promise.all([listServices(), listBlocks(), listCloudSettings(), getImportPreview(), listAppointments()])
      .then(([nextServices, nextBlocks, nextSettings, nextPreview, nextAppointments]) => {
        if (!alive) return;
        setServices(nextServices);
        setBlocks(nextBlocks);
        setSettings(nextSettings);
        setPreview(nextPreview);
        setAppointments(nextAppointments);
        setError("");
      })
      .catch((cause) => alive && setError(failureMessage(cause)))
      .finally(() => alive && setLoaded(true));
    return () => { alive = false; };
  }, [version, access.state]);

  const booking = useBookingForm(settings, services, online, refresh);
  return { services, blocks, settings, preview, appointments, error, loaded, online, refresh, booking };
}
export type SiteSettings = ReturnType<typeof useSiteSettings>;

// ---------- Services ----------

export function ServicesCard({ site: { services, online, loaded, refresh: onSaved } }: { site: SiteSettings }) {
  const [editing, setEditing] = useState<Service | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const visible = services.filter((service) => showArchived || service.active);
  const archivedCount = services.filter((service) => !service.active).length;
  const toggleArchive = async (service: Service) => {
    setBusyId(service.id);
    try {
      await saveService({ ...service, active: !service.active });
      toast.success(service.active ? "Service archived" : "Service restored");
      onSaved();
    } catch (error) {
      toast.error(failureMessage(error));
      onSaved();
    } finally { setBusyId(null); }
  };

  return (
    <Card>
      <CardHeader title="Services" subtitle="What customers can book, how long it takes and what it costs"
        action={<Button disabled={!online} onClick={() => setEditing("new")}><Plus size={18} aria-hidden /> Add service</Button>} />
      {!online && <div className="px-5 pb-2"><OnlineNotice online={online} /></div>}
      {!loaded && <Loading label="Loading services" />}
      {loaded && !visible.length && <Help className="px-5 pb-4">{showArchived ? "No services yet." : "No services on offer yet."}</Help>}
      {visible.length > 0 && <ul className="divide-y divide-line border-t border-line">
        {visible.map((service) => (
          <li key={service.id} className="flex items-center gap-2 py-2 pl-5 pr-2">
            <div className="min-w-0 flex-1 py-1">
              <div className="break-words font-medium">{service.name}{!service.active && <span className="ml-2 text-small font-normal text-ink-2">Archived</span>}</div>
              <p className="tabular flex flex-wrap items-center gap-x-2 text-small text-ink-2">
                {service.discount_percent > 0
                  ? <><span className="line-through">{money(service.price_pence)}</span><span className="font-semibold text-good">{money(serviceDiscountPrice(service.price_pence, service.discount_percent))}</span><span className="text-good">{service.discount_percent}% off</span></>
                  : <span>{money(service.price_pence)}</span>}
                <span>· {durationLabel(service.duration_min)}</span>
              </p>
              {service.description && <p className="break-words text-small text-ink-2">{service.description}</p>}
            </div>
            <div className="flex shrink-0">
              <Button size="icon" variant="ghost" disabled={!online || busyId !== null} title={`Edit ${service.name}`} aria-label={`Edit ${service.name}`} onClick={() => setEditing(service)}><Pencil size={18} aria-hidden /></Button>
              <Button size="icon" variant="ghost" disabled={!online || busyId !== null} title={`${service.active ? "Archive" : "Restore"} ${service.name}`} aria-label={`${service.active ? "Archive" : "Restore"} ${service.name}`} onClick={() => void toggleArchive(service)}>{service.active ? <Archive size={18} aria-hidden /> : <RotateCcw size={18} aria-hidden />}</Button>
            </div>
          </li>
        ))}
      </ul>}
      {archivedCount > 0 && <div className="border-t border-line px-5 py-1"><Checkbox label={`Show archived (${archivedCount})`} checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /></div>}
      {editing !== null && <ServiceForm service={editing === "new" ? null : editing} online={online} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onSaved(); }} />}
    </Card>
  );
}

function ServiceForm({ service, online, onClose, onSaved }: {
  service: Service | null; online: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(service?.name ?? "");
  const [description, setDescription] = useState(service?.description ?? "");
  const [duration, setDuration] = useState(String(service?.duration_min ?? 30));
  const [price, setPrice] = useState(penceToInput(service?.price_pence ?? 0));
  const [discountEnabled, setDiscountEnabled] = useState((service?.discount_percent ?? 0) > 0);
  const [discount, setDiscount] = useState(String(service?.discount_percent || 20));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const durationMin = Number(duration);
  const pricePence = parseAmount(price);
  const discountPercent = discountEnabled ? Number(discount) : 0;
  const valid = name.trim().length >= 2 && name.trim().length <= 100 && description.length <= 1000 && Number.isInteger(durationMin) && durationMin >= 5 && durationMin <= 480 && pricePence !== null && pricePence <= 1_000_000 && Number.isInteger(discountPercent) && discountPercent >= 0 && discountPercent <= 100 && (!discountEnabled || discountPercent >= 1);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!online || !valid || pricePence === null || busy) return;
    setBusy(true);
    setError("");
    const id = service?.id ?? crypto.randomUUID();
    try {
      await saveService({ id, name: name.trim(), description: description.trim(), duration_min: durationMin, price_pence: pricePence, discount_percent: discountPercent, active: service?.active ?? true, ...(service ? { revision: service.revision } : {}) });
      toast.success(service ? "Service updated" : "Service added");
      onSaved();
    } catch (cause) { setError(failureMessage(cause)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={() => { if (!busy) onClose(); }} title={service ? "Edit service" : "Add service"}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name"><Input autoFocus required minLength={2} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Price"><MoneyInput required value={price} onChange={(event) => setPrice(event.target.value)} /></Field>
          <Field label="Duration (minutes)"><Input className="tabular" type="number" required min={5} max={480} step={1} value={duration} onChange={(event) => setDuration(event.target.value)} /></Field>
        </div>
        <Field label="Description" hint="Shown to customers on the website."><Textarea maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        <div>
          <Checkbox label="Offer a discount" checked={discountEnabled} onChange={(event) => setDiscountEnabled(event.target.checked)} />
          {discountEnabled && <Field label="Discount (%)" className="mt-1"><Input className="tabular" type="number" min={1} max={100} step={1} value={discount} onChange={(event) => setDiscount(event.target.value)} /></Field>}
        </div>
        {pricePence !== null && valid && <p className="text-small text-ink-2">Customers pay <strong className={`tabular font-semibold ${discountPercent > 0 ? "text-good" : "text-ink"}`}>{money(serviceDiscountPrice(pricePence, discountPercent))}</strong>{discountPercent > 0 ? ` (${discountPercent}% off ${money(pricePence)})` : ""}. Bookings already made keep the price they were given.</p>}
        {error && <ErrorText>{error}</ErrorText>}
        <Actions><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={!online || !valid || busy}>{busy ? "Saving…" : "Save"}</Button></Actions>
      </form>
    </Modal>
  );
}

// ---------- Opening hours and customer bookings: one form, shown in two sections ----------

function openingDays(settings: BusinessSettings): OpeningDay[] {
  return WEEKDAYS.map((_, weekday) => {
    const hours = settings.opening_hours.find((item) => item.weekday === weekday);
    return { weekday, enabled: Boolean(hours), open: hours?.open ?? "09:00", close: hours?.close ?? "17:00" };
  });
}

/**
 * Opening hours ("When I work") and the customer bookings switch ("Website and bookings") are saved
 * together, against one copy of the settings, so the two sections can never overwrite each other.
 */
function useBookingForm(settings: BusinessSettings | null, services: Service[], online: boolean, onSaved: () => void) {
  const [days, setDays] = useState<OpeningDay[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [touched, setTouched] = useState({ hours: false, bookings: false });
  const [reviewed, setReviewed] = useState(false);
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!settings || dirty) return;
    setDays(openingDays(settings));
    setEnabled(settings.booking_enabled);
    setReviewed(settings.booking_enabled);
    setBaseRevision(settings.revision);
  }, [settings, dirty]);
  const valid = days.every((day) => !day.enabled || (/^\d{2}:\d{2}$/.test(day.open) && /^\d{2}:\d{2}$/.test(day.close) && day.open < day.close));
  const canEnable = services.some((service) => service.active) && days.some((day) => day.enabled) && reviewed;
  const stale = dirty && settings !== null && baseRevision !== settings.revision;
  const updateDay = (weekday: number, value: Partial<OpeningDay>) => {
    setDirty(true);
    setTouched((current) => ({ ...current, hours: true }));
    setDays((current) => current.map((day) => day.weekday === weekday ? { ...day, ...value } : day));
  };
  const changeBookings = (change: () => void) => { change(); setDirty(true); setTouched((current) => ({ ...current, bookings: true })); };
  const toggleEnabled = (next: boolean) => changeBookings(() => setEnabled(next));
  const tickReviewed = (next: boolean) => changeBookings(() => setReviewed(next));
  const reset = () => { setDirty(false); setTouched({ hours: false, bookings: false }); setError(""); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings || !online || !valid || busy || stale || (enabled && !canEnable)) return;
    setBusy(true);
    setError("");
    try {
      await updateCloudSettings({ ...settings, revision: baseRevision ?? settings.revision, booking_enabled: enabled, timezone: "Europe/London", slot_minutes: 30, horizon_days: 90, opening_hours: days.filter((day) => day.enabled).map(({ weekday, open, close }) => ({ weekday, open, close })) });
      setDirty(false);
      setTouched({ hours: false, bookings: false });
      toast.success("Booking settings saved");
      onSaved();
    } catch (cause) { setError(failureMessage(cause)); onSaved(); }
    finally { setBusy(false); }
  };
  const blocked = !online || !valid || (enabled && !canEnable);
  return { days, enabled, dirty, touched, reviewed, busy, error, valid, canEnable, stale, blocked, updateDay, toggleEnabled, tickReviewed, reset, submit };
}

// In a very narrow window the clock button would crowd out the time itself; typing still works.
const timeField = "tabular min-w-0 flex-1 px-2 max-[420px]:[&::-webkit-calendar-picker-indicator]:hidden sm:w-32 sm:flex-none";
const NEEDS = "To take bookings you need at least one service on offer, at least one open day, and the tick to say you've checked them.";

export function OpeningHoursCard({ site: { settings, online, loaded, booking } }: { site: SiteSettings }) {
  const { days, busy, valid, updateDay } = booking;
  return (
    <Card>
      <CardHeader title="Opening hours" subtitle="The days and times customers can book" />
      <form onSubmit={booking.submit} className="space-y-4 px-5 pb-5">
        <OnlineNotice online={online} />
        {!settings ? <Help>{loaded ? "Connect to the website to load your opening hours." : "Loading…"}</Help> : <>
          <div className="divide-y divide-line border-t border-line">
            {WEEK_ORDER.map((weekday) => days.find((day) => day.weekday === weekday)).filter((day): day is OpeningDay => Boolean(day)).map((day) => (
              <div key={day.weekday} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
                <Checkbox label={WEEKDAYS[day.weekday]} disabled={!online || busy} checked={day.enabled} onChange={(event) => updateDay(day.weekday, { enabled: event.target.checked })} />
                {day.enabled ? <div className="col-span-2 flex items-center gap-2 pb-3 sm:col-span-1 sm:py-1.5">
                  <Input aria-label={`${WEEKDAYS[day.weekday]} opening time`} type="time" required disabled={!online || busy} value={day.open} onChange={(event) => updateDay(day.weekday, { open: event.target.value })} className={timeField} />
                  <span className="text-small text-ink-2">to</span>
                  <Input aria-label={`${WEEKDAYS[day.weekday]} closing time`} type="time" required disabled={!online || busy} value={day.close} onChange={(event) => updateDay(day.weekday, { close: event.target.value })} className={timeField} />
                </div> : <span className="text-small text-ink-2">Closed</span>}
              </div>
            ))}
          </div>
          {!valid && <ErrorText>Closing time must be after opening time.</ErrorText>}
          <SaveBar dirty={booking.dirty} stale={booking.stale} busy={busy} disabled={booking.blocked} label="Save hours" onReset={booking.reset} error={booking.error}>
            {booking.enabled && !booking.canEnable && <ErrorText>{NEEDS}</ErrorText>}
            {booking.touched.bookings && <Help>This also saves the change you made to customer bookings.</Help>}
          </SaveBar>
        </>}
      </form>
    </Card>
  );
}

export function CustomerBookingsCard({ site: { settings, online, loaded, booking } }: { site: SiteSettings }) {
  const { enabled, busy } = booking;
  return (
    <Card>
      <SwitchHeader title="Customer bookings" subtitle={!settings ? undefined : enabled ? "On. Customers can ask for appointments on your website." : "Off. Your website isn't taking booking requests."}>
        {settings && <Switch label="Customer bookings" checked={enabled} disabled={!online || busy} onChange={booking.toggleEnabled} />}
      </SwitchHeader>
      <form onSubmit={booking.submit} className="space-y-3 px-5 pb-5">
        <OnlineNotice online={online} />
        {!settings ? <Help>{loaded ? "Connect to the website to load your booking settings." : "Loading…"}</Help> : <>
          {!settings.booking_enabled && <Checkbox label="I've checked my services, prices, times and opening hours." checked={booking.reviewed} disabled={!online || busy} onChange={(event) => booking.tickReviewed(event.target.checked)} />}
          {enabled && !booking.canEnable && <ErrorText>{NEEDS}</ErrorText>}
          <Help>Customers can book up to 90 days ahead, on the half hour.</Help>
          <SaveBar dirty={booking.dirty} stale={booking.stale} busy={busy} disabled={booking.blocked} label="Save bookings" onReset={booking.reset} error={booking.error}>
            {!booking.valid && <ErrorText>One of your opening days closes before it opens. Fix it in When I work.</ErrorText>}
            {booking.touched.hours && <Help>This also saves the change you made to opening hours.</Help>}
          </SaveBar>
        </>}
      </form>
    </Card>
  );
}

// ---------- Emails about new requests ----------

export function RequestEmailCard({ site: { settings, online, refresh: onSaved } }: { site: SiteSettings }) {
  const [sync, setSync] = useState(getSyncState);
  const [enabled, setEnabled] = useState(false);
  const [email, setEmail] = useState("");
  const [revision, setRevision] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => subscribeSync(setSync), []);
  useEffect(() => {
    let alive = true;
    listNotificationStatus().then((notifications) => {
      if (alive && getSyncState().last_synced_at === null) setSync((current) => ({ ...current, notifications }));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!settings || dirty) return;
    setEnabled(settings.admin_notifications_enabled ?? false);
    setEmail(settings.admin_notification_email ?? "");
    setRevision(settings.revision);
  }, [settings, dirty]);
  const stale = Boolean(settings && dirty && settings.revision !== revision);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings || !online || stale || busy || !event.currentTarget.reportValidity()) return;
    setBusy(true); setError("");
    try {
      await updateCloudSettings({ ...settings, revision: revision ?? settings.revision, admin_notifications_enabled: enabled, admin_notification_email: email.trim() });
      setDirty(false); toast.success("Request notifications saved"); onSaved();
    } catch (cause) { setError(failureMessage(cause)); onSaved(); }
    finally { setBusy(false); }
  };
  const status = sync.notifications;
  return <Card>
    <SwitchHeader title="Booking request emails" subtitle="Get an email when someone asks for an appointment">
      <Switch label="Email new website requests" checked={enabled} disabled={!settings || !online || busy} onChange={(next) => { setEnabled(next); setDirty(true); }} />
    </SwitchHeader>
    <form className="space-y-4 px-5 pb-5" onSubmit={submit}>
      <OnlineNotice online={online} />
      <Field label="Send them to"><Input type="email" autoComplete="email" required={enabled} value={email} disabled={!settings || !online || busy} onChange={(event) => { setEmail(event.target.value); setDirty(true); }} /></Field>
      {status && (!status.configured || status.pending > 0 || status.failed > 0) && <div className="space-y-1 text-small">
        {!status.configured && <p className="text-bad">Emails can't be sent yet: the website's email isn't set up.</p>}
        {status.pending > 0 && <p className="text-ink-2">{status.pending} {status.pending === 1 ? "email is" : "emails are"} waiting to send.</p>}
        {status.failed > 0 && <p className="text-bad" role="alert">{status.failed} {status.failed === 1 ? "email" : "emails"} couldn't be sent.</p>}
      </div>}
      <SaveBar dirty={dirty} stale={stale} busy={busy} disabled={!settings || !online || (enabled && !email.trim())} label="Save notifications" onReset={() => { setDirty(false); setError(""); }} error={error} />
    </form>
  </Card>;
}

// ---------- Older diary entries the website doesn't know about yet ----------

/** True when some clients or diary entries were made before the website link and can be brought across. */
export const hasOlderRecords = (site: SiteSettings) => site.loaded && (site.preview.clients.length > 0 || site.preview.appointments.length > 0);

export function ImportReviewCard({ preview, appointments, blocks, online, loaded, onSaved }: {
  preview: ImportPreview; appointments: AppointmentRow[]; blocks: Block[]; online: boolean; loaded: boolean; onSaved: () => void;
}) {
  const [clientIds, setClientIds] = useState<number[]>([]);
  const [appointmentIds, setAppointmentIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const selectedClients = clientIds.filter((id) => preview.clients.some((client) => client.id === id));
  const selectedAppointments = appointmentIds.filter((id) => preview.appointments.some((appointment) => appointment.id === id));
  const conflicts = useMemo(() => {
    const chosen = preview.appointments.filter((appointment) => appointmentIds.includes(appointment.id));
    const confirmed = appointments.filter((appointment) => appointment.remote_id && appointment.status === "confirmed" && appointment.time_confirmed !== 0);
    const messages: string[] = [];
    for (const [index, appointment] of chosen.entries()) {
      const name = `${ukDate(appointment.date)} ${appointment.time_confirmed === 0 ? "Time to confirm" : timeLabel(appointment.start_time)} (${appointment.client_name ?? "No client"})`;
      if (!appointment.client_id) { messages.push(`${name}: choose a client in the diary first.`); continue; }
      if (appointment.time_confirmed === 0) continue;
      const overlaps = (other: { date: string; start_time: string; duration_min: number; time_confirmed?: number }) => other.time_confirmed !== 0 && other.date === appointment.date && timeToMin(other.start_time) < timeToMin(appointment.start_time) + appointment.duration_min && timeToMin(appointment.start_time) < timeToMin(other.start_time) + other.duration_min;
      if (confirmed.some(overlaps) || chosen.slice(0, index).some(overlaps)) messages.push(`${name}: overlaps another confirmed appointment.`);
      if (blocks.some(overlaps)) messages.push(`${name}: overlaps time off.`);
    }
    return messages;
  }, [preview.appointments, appointmentIds, appointments, blocks]);
  const toggle = (id: number, current: number[], setter: (ids: number[]) => void) => {
    setter(current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    setReviewed(false);
    setError("");
  };
  const runImport = async () => {
    if (!online || busy || !reviewed || conflicts.length || (!selectedClients.length && !selectedAppointments.length)) return;
    setBusy(true);
    setError("");
    try { await importLegacyRecords({ clientIds: selectedClients, appointmentIds: selectedAppointments }); setClientIds([]); setAppointmentIds([]); setReviewed(false); toast.success("Brought across to the website"); onSaved(); }
    catch (cause) { setError(failureMessage(cause)); onSaved(); }
    finally { setBusy(false); }
  };
  if (!loaded || (!preview.clients.length && !preview.appointments.length)) return null;
  return (
    <Card>
      <CardHeader title="Bring across older diary entries" subtitle="These were added before the website was linked. Choose the ones the website should know about." />
      <div className="space-y-4 px-5 pb-5"><OnlineNotice online={online} />
        {preview.clients.length > 0 && <div>
          <div className="flex flex-wrap items-center justify-between gap-2"><SubHeading>Clients <span className="tabular font-normal text-ink-2">{preview.clients.length}</span></SubHeading><Button size="sm" variant="ghost" disabled={!online || busy} onClick={() => { setClientIds(selectedClients.length === preview.clients.length ? [] : preview.clients.map((client) => client.id)); setReviewed(false); }}>{selectedClients.length === preview.clients.length ? "Clear" : "Select all"}</Button></div>
          <div className="max-h-60 overflow-y-auto">{preview.clients.map((client) => <Checkbox key={client.id} disabled={!online || busy} checked={selectedClients.includes(client.id)} onChange={() => toggle(client.id, clientIds, setClientIds)} label={<span className="break-words">{client.name}</span>} hint={client.phone || undefined} />)}</div>
        </div>}
        {preview.appointments.length > 0 && <div>
          <div className="flex flex-wrap items-center justify-between gap-2"><SubHeading>Diary entries <span className="tabular font-normal text-ink-2">{preview.appointments.length}</span></SubHeading><Button size="sm" variant="ghost" disabled={!online || busy} onClick={() => { setAppointmentIds(selectedAppointments.length === preview.appointments.length ? [] : preview.appointments.map((appointment) => appointment.id)); setReviewed(false); }}>{selectedAppointments.length === preview.appointments.length ? "Clear" : "Select all"}</Button></div>
          <div className="max-h-72 overflow-y-auto">{preview.appointments.map((appointment) => <Checkbox key={appointment.id} disabled={!online || busy} checked={selectedAppointments.includes(appointment.id)} onChange={() => toggle(appointment.id, appointmentIds, setAppointmentIds)} label={<span className="break-words">{appointment.client_name ?? "No client"}</span>} hint={<span className="tabular">{ukDate(appointment.date)} · {appointment.time_confirmed === 0 ? "Time to confirm" : timeLabel(appointment.start_time)} · {durationLabel(appointment.duration_min)} · {money(appointment.price_pence ?? 0)}</span>} />)}</div>
        </div>}
        {conflicts.length > 0 && <div className="border-l-2 border-bad pl-3 text-small text-bad" role="alert"><p className="mb-1 font-medium">{conflicts.length === 1 ? "1 entry needs sorting first" : `${conflicts.length} entries need sorting first`}</p><ul className="space-y-1">{conflicts.slice(0, 12).map((conflict, index) => <li key={index}>{conflict}</li>)}</ul>{conflicts.length > 12 && <p className="mt-1">And {conflicts.length - 12} more.</p>}</div>}
        <Checkbox checked={reviewed} disabled={!online || busy} onChange={(event) => setReviewed(event.target.checked)} label="I've checked the ones I chose." hint="Private notes and money records are not sent to the website." />
        {error && <ErrorText>{error}</ErrorText>}
        <Actions><Button variant="primary" disabled={!online || busy || !reviewed || conflicts.length > 0 || (!selectedClients.length && !selectedAppointments.length)} onClick={() => void runImport()}><Upload size={16} aria-hidden />{busy ? "Bringing across…" : "Bring across"}</Button></Actions>
      </div>
    </Card>
  );
}
