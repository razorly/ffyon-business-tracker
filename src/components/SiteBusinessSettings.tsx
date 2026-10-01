import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Archive, Bell, CalendarOff, Check, Pencil, Plus, RotateCcw, Save, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { listAppointments, type AppointmentRow } from "@/lib/db";
import { useData } from "@/lib/data";
import { durationLabel, isoDate, money, parseAmount, penceToInput, timeLabel, timeToMin, ukDate } from "@/lib/format";
import {
  createBlock, deleteBlock, getImportPreview, getSyncState, importLegacyRecords, listBlocks, listCloudSettings, listNotificationStatus,
  listServices, saveService, serviceDiscountPrice, subscribeSync, updateCloudSettings,
} from "@/lib/sync";
import { useAccess } from "@/components/AccessGate";
import { Button, Card, CardHeader, Field, Input, Modal, Textarea } from "@/components/ui";
import { VisitSettingsCard } from "@/components/VisitSettingsCard";

type Service = Awaited<ReturnType<typeof listServices>>[number];
type Block = Awaited<ReturnType<typeof listBlocks>>[number];
type BusinessSettings = NonNullable<Awaited<ReturnType<typeof listCloudSettings>>>;
type ImportPreview = Awaited<ReturnType<typeof getImportPreview>>;
type OpeningDay = { weekday: number; enabled: boolean; open: string; close: string };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const emptyPreview: ImportPreview = { clients: [], appointments: [], services: [] };
const failureMessage = (error: unknown) => error instanceof Error ? error.message : "The change could not be saved.";

export function SiteBusinessSettings() {
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

  return (
    <>
      {error && <p className="col-span-full text-sm text-bad" role="alert">{error}</p>}
      <ServiceCatalogCard services={services} online={online} loaded={loaded} onSaved={refresh} />
      <OpeningHoursCard settings={settings} services={services} online={online} loaded={loaded} onSaved={refresh} />
      <VisitSettingsCard settings={settings} online={online} onSaved={refresh} />
      <RequestNotificationsCard settings={settings} online={online} onSaved={refresh} />
      <TimeOffCard blocks={blocks} online={online} loaded={loaded} onSaved={refresh} />
      <ImportReviewCard preview={preview} appointments={appointments} blocks={blocks} online={online} loaded={loaded} onSaved={refresh} />
    </>
  );
}

function OnlineNotice({ online }: { online: boolean }) {
  return online ? null : <p className="mb-3 text-xs text-muted">Reconnect to change shared booking settings.</p>;
}

function ServiceCatalogCard({ services, online, loaded, onSaved }: {
  services: Service[]; online: boolean; loaded: boolean; onSaved: () => void;
}) {
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
    <Card className="self-start">
      <CardHeader title="Services" action={<Button size="sm" disabled={!online} onClick={() => setEditing("new")}><Plus size={14} /> Add</Button>} />
      <div className="px-5 pb-5">
        <OnlineNotice online={online} />
        {!loaded && <p className="py-3 text-sm text-muted">Loading services...</p>}
        {loaded && !visible.length && <p className="py-3 text-sm text-muted">No {showArchived ? "" : "active "}services.</p>}
        <ul className="divide-y divide-line">
          {visible.map((service) => (
              <li key={service.id} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium"><span className="break-words">{service.name}</span>{!service.active && <span className="text-xs font-normal text-muted">Archived</span>}</div>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">{service.discount_percent > 0 ? <><span className="text-muted line-through">{money(service.price_pence)}</span><span className="font-semibold text-good">{money(serviceDiscountPrice(service.price_pence, service.discount_percent))}</span><span className="text-good">{service.discount_percent}% off</span></> : <span>{money(service.price_pence)}</span>}<span>· {durationLabel(service.duration_min)}</span></p>
                  {service.description && <p className="mt-1 break-words text-xs text-muted">{service.description}</p>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="icon" variant="ghost" disabled={!online || busyId !== null} title={`Edit ${service.name}`} aria-label={`Edit ${service.name}`} onClick={() => setEditing(service)}><Pencil size={14} /></Button>
                  <Button size="icon" variant="ghost" disabled={!online || busyId !== null} title={`${service.active ? "Archive" : "Restore"} ${service.name}`} aria-label={`${service.active ? "Archive" : "Restore"} ${service.name}`} onClick={() => void toggleArchive(service)}>{service.active ? <Archive size={14} /> : <RotateCcw size={14} />}</Button>
                </div>
              </li>
          ))}
        </ul>
        {archivedCount > 0 && <label className="mt-3 flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} className="accent-accent" /> Show archived ({archivedCount})</label>}
      </div>
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
      <form onSubmit={submit} className="max-h-[calc(100dvh-140px)] space-y-4 overflow-y-auto">
        <Field label="Name"><Input autoFocus required minLength={2} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="Description"><Textarea maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Duration (minutes)"><Input type="number" required min={5} max={480} step={1} value={duration} onChange={(event) => setDuration(event.target.value)} /></Field>
          <Field label="Price (GBP)"><Input required inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={discountEnabled} onChange={(event) => setDiscountEnabled(event.target.checked)} className="accent-accent" />Discount enabled</label>
        <Field label="Discount (%)"><Input type="number" min={1} max={100} step={1} disabled={!discountEnabled} value={discount} onChange={(event) => setDiscount(event.target.value)} /></Field>
        {pricePence !== null && valid && <p className="text-sm text-ink-2">Booking price: <strong className={discountPercent > 0 ? "text-good" : ""}>{money(serviceDiscountPrice(pricePence, discountPercent))}</strong>{discountPercent > 0 ? ` (${discountPercent}% off ${money(pricePence)})` : ""}</p>}
        <p className="text-xs text-muted">Existing bookings keep their original quoted price.</p>
        {error && <p className="text-sm text-bad" role="alert">{error}</p>}
        <div className="flex justify-end gap-2"><Button type="button" disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={!online || !valid || busy}><Save size={14} /> {busy ? "Saving..." : "Save"}</Button></div>
      </form>
    </Modal>
  );
}

function RequestNotificationsCard({ settings, online, onSaved }: { settings: BusinessSettings | null; online: boolean; onSaved: () => void }) {
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
  const stale = settings && dirty && settings.revision !== revision;
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
  return <Card className="self-start">
    <CardHeader title="Request notifications" />
    <form className="space-y-4 px-5 pb-5" onSubmit={submit}>
      <OnlineNotice online={online} />
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={enabled} disabled={!settings || !online || busy} onChange={(event) => { setEnabled(event.target.checked); setDirty(true); }} className="mt-1 accent-accent" /><Bell size={15} className="mt-0.5 shrink-0 text-muted" />Email new website requests</label>
      <Field label="Notification email"><Input type="email" autoComplete="email" required={enabled} value={email} disabled={!settings || !online || busy} onChange={(event) => { setEmail(event.target.value); setDirty(true); }} /></Field>
      {sync.notifications ? <div className="space-y-1 text-xs">
        <p className={sync.notifications.configured ? "text-muted" : "text-bad"}>{sync.notifications.configured ? "Email sender configured" : "Email sender is not configured on the site."}</p>
        {sync.notifications.pending > 0 && <p className="text-muted">{sync.notifications.pending} email {sync.notifications.pending === 1 ? "delivery" : "deliveries"} pending</p>}
        {sync.notifications.failed > 0 && <p className="text-bad" role="alert">{sync.notifications.failed} email {sync.notifications.failed === 1 ? "delivery has" : "deliveries have"} failed.</p>}
      </div> : <p className="text-xs text-muted">Email delivery status is not yet available.</p>}
      {stale && <p className="text-xs text-bad" role="alert">Settings changed on another device. Reload before saving.</p>}
      {error && <p className="text-sm text-bad" role="alert">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">{dirty && <Button type="button" disabled={busy} onClick={() => { setDirty(false); setError(""); }}><RotateCcw size={14} />{stale ? "Reload latest" : "Reset"}</Button>}<Button type="submit" variant="primary" disabled={!settings || !online || !dirty || busy || Boolean(stale) || (enabled && !email.trim())}><Save size={14} />{busy ? "Saving..." : "Save notifications"}</Button></div>
    </form>
  </Card>;
}

function openingDays(settings: BusinessSettings): OpeningDay[] {
  return WEEKDAYS.map((_, weekday) => {
    const hours = settings.opening_hours.find((item) => item.weekday === weekday);
    return { weekday, enabled: Boolean(hours), open: hours?.open ?? "09:00", close: hours?.close ?? "17:00" };
  });
}

function OpeningHoursCard({ settings, services, online, loaded, onSaved }: {
  settings: BusinessSettings | null; services: Service[]; online: boolean; loaded: boolean; onSaved: () => void;
}) {
  const [days, setDays] = useState<OpeningDay[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [dirty, setDirty] = useState(false);
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
    setDays((current) => current.map((day) => day.weekday === weekday ? { ...day, ...value } : day));
  };
  const reset = () => { setDirty(false); setError(""); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings || !online || !valid || busy || stale || (enabled && !canEnable)) return;
    setBusy(true);
    setError("");
    try {
      await updateCloudSettings({ ...settings, revision: baseRevision ?? settings.revision, booking_enabled: enabled, timezone: "Europe/London", slot_minutes: 30, horizon_days: 90, opening_hours: days.filter((day) => day.enabled).map(({ weekday, open, close }) => ({ weekday, open, close })) });
      setDirty(false);
      toast.success("Booking settings saved");
      onSaved();
    } catch (cause) { setError(failureMessage(cause)); onSaved(); }
    finally { setBusy(false); }
  };

  return (
    <Card className="self-start">
      <CardHeader title="Booking availability" />
      <form onSubmit={submit} className="space-y-4 px-5 pb-5">
        <OnlineNotice online={online} />
        {!settings ? <p className="py-3 text-sm text-muted">{loaded ? "Synchronize the site to load booking settings." : "Loading booking settings..."}</p> : <>
          <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-sm font-medium">Customer bookings</span><button type="button" role="switch" aria-checked={enabled} aria-label="Customer bookings" disabled={!online || busy} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${enabled ? "bg-accent" : "bg-line"}`} onClick={() => { setEnabled(!enabled); setDirty(true); }}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${enabled ? "left-0.5 translate-x-5" : "left-0.5"}`} /></button></div>
          <div className="space-y-2">
            {days.map((day) => <div key={day.weekday} className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[minmax(90px,1fr)_minmax(0,1fr)_minmax(0,1fr)]"><label className="col-span-2 flex items-center gap-2 text-[13px] sm:col-span-1"><input type="checkbox" disabled={!online || busy} checked={day.enabled} onChange={(event) => updateDay(day.weekday, { enabled: event.target.checked })} className="accent-accent" />{WEEKDAYS[day.weekday].slice(0, 3)}</label><Input aria-label={`${WEEKDAYS[day.weekday]} opening time`} type="time" required={day.enabled} disabled={!day.enabled || !online || busy} value={day.open} onChange={(event) => updateDay(day.weekday, { open: event.target.value })} className="px-2" /><Input aria-label={`${WEEKDAYS[day.weekday]} closing time`} type="time" required={day.enabled} disabled={!day.enabled || !online || busy} value={day.close} onChange={(event) => updateDay(day.weekday, { close: event.target.value })} className="px-2" /></div>)}
          </div>
          <p className="text-xs text-muted">Europe/London · GBP · 30-minute start intervals · 90-day booking window</p>
          {!settings.booking_enabled && <label className="flex items-start gap-2 text-xs text-ink-2"><input type="checkbox" className="mt-0.5 accent-accent" checked={reviewed} disabled={!online || busy} onChange={(event) => { setReviewed(event.target.checked); setDirty(true); }} />I have reviewed the service prices, durations and opening hours.</label>}
          {!valid && <p className="text-xs text-bad">Closing time must follow opening time on the same day.</p>}
          {enabled && !canEnable && <p className="text-xs text-bad">An active service, an open day and reviewed settings are required to accept bookings.</p>}
          {stale && <p className="text-xs text-bad" role="alert">Settings changed on another device. Reload the latest settings before saving.</p>}
          {error && <p className="text-sm text-bad" role="alert">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">{dirty && <Button type="button" disabled={busy} onClick={reset}><RotateCcw size={14} /> {stale ? "Reload latest" : "Reset"}</Button>}<Button type="submit" variant="primary" disabled={!online || !dirty || !valid || busy || stale || (enabled && !canEnable)}><Save size={14} /> {busy ? "Saving..." : "Save hours"}</Button></div>
        </>}
      </form>
    </Card>
  );
}

function TimeOffCard({ blocks, online, loaded, onSaved }: { blocks: Block[]; online: boolean; loaded: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const upcoming = blocks.filter((block) => showPast || block.date >= today).sort((a, b) => `${a.date}${a.start_time}`.localeCompare(`${b.date}${b.start_time}`));
  const remove = async (block: Block) => {
    setBusyId(block.id);
    try { await deleteBlock(block); toast.success("Time off removed"); onSaved(); }
    catch (cause) { toast.error(failureMessage(cause)); onSaved(); }
    finally { setBusyId(null); }
  };
  return (
    <Card className="self-start">
      <CardHeader title="Time off" action={<Button size="sm" disabled={!online} onClick={() => setOpen(true)}><Plus size={14} /> Add</Button>} />
      <div className="px-5 pb-5"><OnlineNotice online={online} />
        {!loaded && <p className="py-3 text-sm text-muted">Loading time off...</p>}
        {loaded && !upcoming.length && <p className="py-3 text-sm text-muted">No {showPast ? "" : "upcoming "}time off.</p>}
        <ul className="divide-y divide-line">{upcoming.map((block) => <li key={block.id} className="flex items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="break-words text-sm font-medium">{block.label}</p><p className="mt-1 text-xs text-muted">{ukDate(block.date)} · {timeLabel(block.start_time)} · {durationLabel(block.duration_min)}</p></div><Button variant="ghost" size="icon" disabled={!online || busyId !== null} title={`Remove ${block.label}`} aria-label={`Remove ${block.label}`} onClick={() => void remove(block)}><Trash2 size={14} /></Button></li>)}</ul>
        {blocks.some((block) => block.date < today) && <label className="mt-3 flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" checked={showPast} onChange={(event) => setShowPast(event.target.checked)} className="accent-accent" /> Show past time off</label>}
      </div>
      {open && <TimeOffForm online={online} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onSaved(); }} />}
    </Card>
  );
}

function TimeOffForm({ online, onClose, onSaved }: { online: boolean; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(isoDate(new Date()));
  const [start, setStart] = useState("09:00");
  const [duration, setDuration] = useState("480");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const durationMin = Number(duration);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(start) && Number.isInteger(durationMin) && durationMin > 0 && timeToMin(start) + durationMin <= 1440 && label.trim().length > 0 && label.trim().length <= 100;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || !online || busy) return;
    setBusy(true);
    setError("");
    try { await createBlock({ date, start_time: start, duration_min: durationMin, label: label.trim() }); toast.success("Time off added"); onSaved(); }
    catch (cause) { setError(failureMessage(cause)); }
    finally { setBusy(false); }
  };
  return (
    <Modal open onClose={() => { if (!busy) onClose(); }} title="Add time off">
      <form onSubmit={submit} className="max-h-[calc(100dvh-140px)] space-y-4 overflow-y-auto">
        <Field label="Label"><Input autoFocus required maxLength={100} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Holiday, lunch or personal time" /></Field>
        <Field label="Date"><Input type="date" required value={date} onChange={(event) => setDate(event.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Start time"><Input type="time" required value={start} onChange={(event) => setStart(event.target.value)} /></Field><Field label="Duration (minutes)"><Input type="number" required min={1} max={1440} step={1} value={duration} onChange={(event) => setDuration(event.target.value)} /></Field></div>
        {timeToMin(start) + durationMin > 1440 && <p className="text-xs text-bad">Time off must finish on the same day. Add a separate block for each day.</p>}
        {error && <p className="text-sm text-bad" role="alert">{error}</p>}
        <div className="flex justify-end gap-2"><Button type="button" disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={!valid || !online || busy}><CalendarOff size={14} />{busy ? "Saving..." : "Add time off"}</Button></div>
      </form>
    </Modal>
  );
}

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
      if (!appointment.client_id) { messages.push(`${name}: choose a client in the diary before importing.`); continue; }
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
    try { await importLegacyRecords({ clientIds: selectedClients, appointmentIds: selectedAppointments }); setClientIds([]); setAppointmentIds([]); setReviewed(false); toast.success("Selected records synchronized"); onSaved(); }
    catch (cause) { setError(failureMessage(cause)); onSaved(); }
    finally { setBusy(false); }
  };
  return (
    <Card className="self-start">
      <CardHeader title="Existing diary import" />
      <div className="space-y-4 px-5 pb-5"><OnlineNotice online={online} />
        {!loaded ? <p className="text-sm text-muted">Loading existing records...</p> : !preview.clients.length && !preview.appointments.length ? <p className="flex items-center gap-2 text-sm text-muted"><Check size={15} /> All existing clients and diary entries are linked.</p> : <>
          {preview.clients.length > 0 && <div><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">Clients ({preview.clients.length})</span><Button size="sm" variant="ghost" disabled={!online || busy} onClick={() => { setClientIds(selectedClients.length === preview.clients.length ? [] : preview.clients.map((client) => client.id)); setReviewed(false); }}>{selectedClients.length === preview.clients.length ? "Clear" : "Select all"}</Button></div><div className="max-h-48 space-y-2 overflow-auto pr-1">{preview.clients.map((client) => <label key={client.id} className="flex items-start gap-2 text-[13px]"><input type="checkbox" disabled={!online || busy} checked={selectedClients.includes(client.id)} onChange={() => toggle(client.id, clientIds, setClientIds)} className="mt-0.5 accent-accent" /><span className="min-w-0 break-words">{client.name}{client.phone && <span className="ml-2 text-xs text-muted">{client.phone}</span>}</span></label>)}</div></div>}
          {preview.appointments.length > 0 && <div><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">Diary entries ({preview.appointments.length})</span><Button size="sm" variant="ghost" disabled={!online || busy} onClick={() => { setAppointmentIds(selectedAppointments.length === preview.appointments.length ? [] : preview.appointments.map((appointment) => appointment.id)); setReviewed(false); }}>{selectedAppointments.length === preview.appointments.length ? "Clear" : "Select all"}</Button></div><div className="max-h-60 space-y-2 overflow-auto pr-1">{preview.appointments.map((appointment) => <label key={appointment.id} className="flex items-start gap-2 text-[13px]"><input type="checkbox" disabled={!online || busy} checked={selectedAppointments.includes(appointment.id)} onChange={() => toggle(appointment.id, appointmentIds, setAppointmentIds)} className="mt-0.5 accent-accent" /><span className="min-w-0 break-words">{appointment.client_name ?? "No client"}<span className="mt-0.5 block text-xs text-muted">{ukDate(appointment.date)} · {appointment.time_confirmed === 0 ? "Time to confirm" : timeLabel(appointment.start_time)} · {durationLabel(appointment.duration_min)} · {money(appointment.price_pence ?? 0)}</span></span></label>)}</div></div>}
          {conflicts.length > 0 && <div className="border-l-2 border-bad pl-3 text-xs text-bad" role="alert"><p className="mb-1 font-medium">Resolve {conflicts.length} import {conflicts.length === 1 ? "conflict" : "conflicts"}</p><ul className="space-y-1">{conflicts.slice(0, 12).map((conflict, index) => <li key={index}>{conflict}</li>)}</ul>{conflicts.length > 12 && <p className="mt-1">And {conflicts.length - 12} more.</p>}</div>}
          <label className="flex items-start gap-2 text-xs text-ink-2"><input type="checkbox" checked={reviewed} disabled={!online || busy} onChange={(event) => setReviewed(event.target.checked)} className="mt-0.5 accent-accent" />I have reviewed the selected records. Private notes and financial entries stay on this computer.</label>
          {error && <p className="text-sm text-bad" role="alert">{error}</p>}
          <div className="flex justify-end"><Button variant="primary" disabled={!online || busy || !reviewed || conflicts.length > 0 || (!selectedClients.length && !selectedAppointments.length)} onClick={() => void runImport()}><Upload size={14} />{busy ? "Importing..." : "Import selected"}</Button></div>
        </>}
      </div>
    </Card>
  );
}
