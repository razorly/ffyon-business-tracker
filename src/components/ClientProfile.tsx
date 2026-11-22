import { useId, useMemo, useState, type Ref } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft, CalendarPlus, Check, Link2, Mail, MapPin, MessageSquare, Pencil, Phone, Plus, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { listAppointments, listTransactions, saveClientNotes, upcomingForClient, type AppointmentRow, type ClientWithStats, type TransactionRow } from "@/lib/db";
import { useData, useLoad } from "@/lib/data";
import { money, shortDate, timeLabel, ukDate } from "@/lib/format";
import { transactionLabel } from "@/lib/income-display";
import { cn } from "@/lib/utils";
import { Actions, Avatar, Button, Card, ErrorText, ListRow, LoadError, Menu, SectionHeading, Textarea } from "./ui";

const STATUS: Record<string, string> = { pending: "Request", rejected: "Declined", cancelled: "Cancelled", no_show: "No-show" };
const HISTORY_STEP = 10;

/** "Sat 3 Oct" this year, 03/10/2025 for anything older, so a date is never ambiguous. */
const dayLabel = (iso: string, today: string) => iso.slice(0, 4) === today.slice(0, 4) ? shortDate(iso) : ukDate(iso);
const whenLabel = (row: AppointmentRow, today: string) => `${dayLabel(row.date, today)} · ${row.time_confirmed === 0 ? "Time to confirm" : timeLabel(row.start_time)}`;
const serviceLabel = (row: AppointmentRow) => `${row.service_name || row.category_name || "Appointment"}${row.is_remote ? " · home visit" : ""}`;

// A phone or text link that looks like the kit's secondary button.
const linkButton = "inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-line bg-surface px-4 text-body font-medium text-ink transition-colors hover:bg-surface-2";

type HistoryItem = { key: string; date: string; time: string; appointment?: AppointmentRow; payment?: TransactionRow };

/** Everything about one client: how to reach her, private notes, what is booked and what has happened. */
export function ClientProfile({ client, today, online, headingRef, onBack, onEdit, onLink, onDisable, onEnable, onDelete }: {
  client: ClientWithStats;
  today: string;
  online: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  onBack: () => void;
  onEdit: () => void;
  onLink: () => void;
  onDisable: () => void;
  onEnable: () => void;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  const { refresh, openNewEntry, openEditEntry, openNewAppointment, openEditAppointment } = useData();
  const [payments, paymentsLoading, paymentsError] = useLoad(() => listTransactions({ clientId: client.id }), [client.id], []);
  const [upcoming, upcomingLoading, upcomingError] = useLoad(() => upcomingForClient(client.id, today), [client.id, today], []);
  const [appointments, appointmentsLoading, appointmentsError] = useLoad(() => listAppointments({ clientId: client.id }), [client.id], []);
  const [shown, setShown] = useState(HISTORY_STEP);

  // Upcoming requests and confirmed bookings are listed above; history is everything past or called off,
  // plus payments taken without an appointment. A paid appointment appears once, as the appointment.
  const history = useMemo(() => {
    const paidByAppointment = new Set(appointments.map(row => row.transaction_id).filter(id => id != null));
    const items: HistoryItem[] = [
      ...appointments.filter(row => row.date < today || (row.status !== "confirmed" && row.status !== "pending"))
        .map(row => ({ key: `a${row.id}`, date: row.date, time: row.start_time, appointment: row })),
      ...payments.filter(row => !paidByAppointment.has(row.id)).map(row => ({ key: `t${row.id}`, date: row.date, time: "", payment: row })),
    ];
    return items.sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time) || b.key.localeCompare(a.key));
  }, [appointments, payments, today]);
  const historyLoading = (paymentsLoading || appointmentsLoading) && history.length === 0;

  const dial = client.phone?.replace(/[^\d+]/g, "") ?? "";
  const contactButtons = (dial ? 2 : 0) + (client.email ? 1 : 0);
  const hasAddress = Boolean(client.saved_address && client.saved_postcode);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="lg:hidden">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}><ArrowLeft size={16} aria-hidden /> All clients</Button>
      </div>
      <LoadError error={paymentsError || upcomingError || appointmentsError} onRetry={refresh} />

      <Card className="@container">
        <div className="flex min-w-0 items-center gap-4 px-5 pt-5">
          <Avatar name={client.name} large />
          <div className="min-w-0">
            <h2 ref={headingRef} tabIndex={-1} className="break-words text-heading font-semibold outline-none">{client.name}</h2>
            <div className="break-words text-small text-ink-2">{client.phone || "No phone number"}</div>
            {client.email && <div className="text-small text-ink-2 [overflow-wrap:anywhere]">{client.email}</div>}
            <div className="text-small text-ink-2">{client.account_id ? "Website account linked" : "No website account"}{client.disabled ? " · disabled" : ""}</div>
          </div>
        </div>

        {/* On a phone the actions sit in two tidy columns; with room they run in a row and More moves to the end. */}
        <div className="grid grid-cols-2 gap-2 px-5 pb-5 pt-4 @md:flex @md:flex-wrap @md:items-center">
          <Button variant="primary" className="col-span-2" disabled={!online || !!client.disabled} onClick={() => openNewAppointment({ date: today, start_time: "09:00", clientId: client.id })}>
            <CalendarPlus size={16} aria-hidden /> Book
          </Button>
          {dial && <a href={`tel:${dial}`} className={linkButton}><Phone size={16} aria-hidden /> Call</a>}
          {dial && <a href={`sms:${dial}`} className={linkButton}><MessageSquare size={16} aria-hidden /> Text</a>}
          {client.email && <Button onClick={() => navigate(`/mail?to=${encodeURIComponent(client.email)}`)}><Mail size={16} aria-hidden /> Email</Button>}
          <div className={cn("@md:ml-auto [&>div>button]:w-full", contactButtons % 2 === 0 && "col-span-2")}>
            <Menu items={[
              { label: "Edit details", icon: <Pencil size={16} aria-hidden />, onSelect: onEdit },
              !client.account_id && !!client.remote_id && { label: "Link website account", icon: <Link2 size={16} aria-hidden />, onSelect: onLink, disabled: !online },
              client.disabled
                ? { label: "Re-enable website access", icon: <ShieldCheck size={16} aria-hidden />, onSelect: onEnable, disabled: !online }
                : { label: "Disable website access", icon: <ShieldOff size={16} aria-hidden />, onSelect: onDisable, disabled: !online || !client.remote_id, hint: client.remote_id ? undefined : "This client isn't on the website yet" },
              { label: client.account_id ? "Delete account" : "Delete client", icon: <Trash2 size={16} aria-hidden />, onSelect: onDelete, disabled: !online, danger: true },
            ]} />
          </div>
        </div>

        <ClientNotes client={client} onSaved={refresh} />

        {hasAddress && <p className="flex gap-2 border-t border-line px-5 py-4 text-small text-ink-2">
          <MapPin size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span className="min-w-0 whitespace-pre-line break-words select-text"><span className="sr-only">Saved visit address: </span>{client.saved_address}<span className="block">{client.saved_postcode}</span></span>
        </p>}

        <dl className="grid grid-cols-1 divide-y divide-line border-t border-line @lg:grid-cols-3 @lg:divide-x @lg:divide-y-0">
          <Figure label="Visits" value={String(client.visits)} />
          <Figure label="Total spent" value={money(client.total_pence)} />
          <Figure label="Average" value={client.visits ? money(Math.round(client.total_pence / client.visits)) : "—"} />
        </dl>
      </Card>

      <Card aria-labelledby="client-upcoming" role="region" className="overflow-hidden">
        <SectionHeading id="client-upcoming" title="Upcoming" className="px-5 pb-2 pt-4" />
        {upcoming.length ? <ul className="divide-y divide-line border-t border-line">
          {upcoming.map(row => <li key={row.id}>
            <ListRow className="focus-visible:outline-offset-[-2px]!" onClick={() => openEditAppointment(row)} title={whenLabel(row, today)} subtitle={serviceLabel(row)}
              trailing={<span className="tabular flex shrink-0 items-center gap-1 text-small text-ink-2">
                {row.transaction_id != null && <><Check size={15} className="text-good" aria-hidden /><span className="sr-only">Paid </span></>}
                {row.price_pence != null && money(row.price_pence)}
              </span>} />
          </li>)}
        </ul> : <p className="border-t border-line px-5 py-4 text-ink-2">{upcomingLoading ? "Loading…" : "Nothing booked."}</p>}
      </Card>

      <Card aria-labelledby="client-history" role="region" className="overflow-hidden">
        <SectionHeading id="client-history" title="History" className="px-5 pb-2 pt-4"
          action={<Button size="sm" onClick={() => openNewEntry("income", client.id)}><Plus size={14} aria-hidden /> Record income</Button>} />
        {history.length ? <ul className="divide-y divide-line border-t border-line">
          {history.slice(0, shown).map(item => <li key={item.key}>
            {item.appointment
              ? <AppointmentLine row={item.appointment} today={today} onOpen={() => openEditAppointment(item.appointment!)} />
              : <PaymentLine row={item.payment!} today={today} onOpen={() => openEditEntry(item.payment!)} />}
          </li>)}
        </ul> : <p className="border-t border-line px-5 py-4 text-ink-2">{historyLoading ? "Loading…" : "No visits or payments yet."}</p>}
        {history.length > shown && <div className="border-t border-line p-2 text-center">
          <Button variant="ghost" size="sm" onClick={() => setShown(count => count + HISTORY_STEP * 2)}>Show earlier</Button>
        </div>}
      </Card>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return <div className="flex min-w-0 items-baseline justify-between gap-3 px-5 py-3 @lg:block">
    <dt className="text-small text-ink-2">{label}</dt>
    <dd className="tabular text-heading font-semibold">{value}</dd>
  </div>;
}

function AppointmentLine({ row, today, onOpen }: { row: AppointmentRow; today: string; onOpen: () => void }) {
  const paid = row.transaction_id != null;
  const status = row.status === "confirmed" ? null : STATUS[row.status];
  return <ListRow className="focus-visible:outline-offset-[-2px]!" onClick={onOpen} title={whenLabel(row, today)} subtitle={serviceLabel(row)}
    trailing={<span className="shrink-0 text-right text-small">
      {status && <span className="block text-ink-2">{status}</span>}
      {paid ? <span className="tabular block font-medium text-good">Paid{row.paid_amount_pence != null ? ` ${money(row.paid_amount_pence)}` : ""}</span>
        : row.status === "confirmed" && <span className="block text-ink-2">{row.price_pence === 0 ? "No payment due" : "Not paid"}</span>}
    </span>} />;
}

function PaymentLine({ row, today, onOpen }: { row: TransactionRow; today: string; onOpen: () => void }) {
  const income = row.type === "income";
  return <ListRow className="focus-visible:outline-offset-[-2px]!" onClick={onOpen} title={dayLabel(row.date, today)} subtitle={[transactionLabel(row), row.description].filter(Boolean).join(" · ")}
    trailing={<span className={`tabular shrink-0 text-small font-medium ${income ? "text-good" : "text-ink"}`}>{income ? "Paid " : "−"}{money(row.amount_pence)}</span>} />;
}

/** Private staff notes, edited where they are read. They stay on her devices: never the website, mail or a link. */
function ClientNotes({ client, onSaved }: { client: ClientWithStats; onSaved: () => void }) {
  // `original` is the text as it was when editing started, so a save cannot overwrite a newer note from another device.
  const [draft, setDraft] = useState<{ original: string | null; text: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const headingId = useId();
  const startEditing = () => {
    setError("");
    setDraft({ original: client.notes, text: client.notes ?? "" });
  };
  return <section aria-labelledby={headingId} className="border-t border-line px-5 py-4">
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
      <h3 id={headingId} className="text-small font-medium text-ink-2">Client notes</h3>
      {!draft && <Button size="sm" onClick={startEditing}>
        {client.notes ? <Pencil size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
        {client.notes ? "Edit notes" : "Add notes"}
      </Button>}
    </div>
    {draft ? <form className="mt-2 space-y-3" onSubmit={async event => {
      event.preventDefault();
      if (busy) return;
      setError("");
      setBusy(true);
      try {
        await saveClientNotes(client.id, draft.text, draft.original);
        onSaved();
        setDraft(null);
        toast.success(draft.text.trim() ? "Client notes saved" : "Client notes cleared");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not save client notes.");
        onSaved(); // Re-read, so the latest note is what shows once she cancels.
      } finally { setBusy(false); }
    }}>
      <Textarea aria-label="Private client notes" autoFocus rows={5} value={draft.text} disabled={busy} placeholder="Preferred shade, skin notes, allergies…"
        onChange={event => setDraft(current => current && { ...current, text: event.target.value })} />
      <p className="text-small text-ink-2">Only you see these notes.</p>
      {error && <ErrorText>{error}</ErrorText>}
      <Actions>
        <Button disabled={busy} onClick={() => { setDraft(null); setError(""); }}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={busy || (draft.original ?? "") === draft.text}>Save notes</Button>
      </Actions>
    </form> : <p className={`mt-1 whitespace-pre-wrap break-words select-text ${client.notes ? "text-ink" : "text-ink-2"}`}>
      {client.notes || "No notes yet."}
    </p>}
  </section>;
}
