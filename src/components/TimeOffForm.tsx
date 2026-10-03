import { useState, type FormEvent } from "react";
import { CalendarOff } from "lucide-react";
import { toast } from "sonner";
import { createTimeOff } from "@/lib/sync";
import { timeOffMoment } from "@/lib/time-off";
import { Button, Field, Input, Modal } from "./ui";

type TimeOffFormProps = {
  online: boolean;
  initialDate?: string;
  initialStart?: string;
  onClose: () => void;
  onSaved: () => void;
  onBusyChange?: (busy: boolean) => void;
};

export function TimeOffForm({ online, initialDate, initialStart, onClose, onSaved, onBusyChange }: TimeOffFormProps) {
  const [date, setDate] = useState(() => initialDate || new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()));
  const [start, setStart] = useState(initialStart || "09:00");
  const [initialEnd] = useState(() => new Date(initialStart ? timeOffMoment(date, start) + 60 * 60_000 : timeOffMoment(date, "17:00")).toISOString());
  const [endDate, setEndDate] = useState(initialEnd.slice(0, 10));
  const [end, setEnd] = useState(initialEnd.slice(11, 16));
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const from = timeOffMoment(date, start), to = timeOffMoment(endDate, end);
  const validRange = Number.isFinite(from) && Number.isFinite(to) && to > from;
  const coveredDays = Math.ceil(to / 86_400_000) - Math.floor(from / 86_400_000);
  const valid = validRange && coveredDays <= 366 && label.trim().length > 0 && label.trim().length <= 100;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || !online || busy) return;
    setBusy(true); onBusyChange?.(true); setError("");
    try { await createTimeOff({ date, start_time: start, end_date: endDate, end_time: end, label: label.trim() }); toast.success("Time off added"); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The change could not be saved."); }
    finally { setBusy(false); onBusyChange?.(false); }
  };
  return <form onSubmit={submit} className="space-y-4">
    <fieldset disabled={busy} className="space-y-4">
      <Field label="Label"><Input autoFocus required maxLength={100} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Holiday, lunch or personal time" /></Field>
      <fieldset className="space-y-3"><legend className="mb-2 text-sm font-medium">From</legend><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="Start date"><Input type="date" required value={date} onChange={(event) => { const next = event.target.value; setDate(next); if (endDate < next) setEndDate(next); }} /></Field><Field label="Start time"><Input type="time" required value={start} onChange={(event) => setStart(event.target.value)} /></Field></div></fieldset>
      <fieldset className="space-y-3"><legend className="mb-2 text-sm font-medium">To</legend><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="End date"><Input type="date" required min={date} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></Field><Field label="End time"><Input type="time" required value={end} onChange={(event) => setEnd(event.target.value)} /></Field></div></fieldset>
      <p className="text-xs text-muted">Bookings are blocked for this whole period, including every day between these dates. Times are UK local time.</p>
      {!online && <p className="text-xs text-muted">Reconnect to add shared time off.</p>}
      {Number.isFinite(from) && Number.isFinite(to) && !validRange && <p className="text-xs text-bad" role="alert">End date and time must be after the start.</p>}
      {validRange && coveredDays > 366 && <p className="text-xs text-bad" role="alert">Choose a period covering no more than 366 days.</p>}
      {error && <p className="text-sm text-bad" role="alert">{error}</p>}
      <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={!valid || !online}><CalendarOff size={14} />{busy ? "Saving..." : "Add time off"}</Button></div>
    </fieldset>
  </form>;
}

export function TimeOffDialog(props: TimeOffFormProps) {
  const [busy, setBusy] = useState(false);
  return <Modal open onClose={() => { if (!busy) props.onClose(); }} title="Add time off">
    <TimeOffForm {...props} onBusyChange={setBusy} />
  </Modal>;
}
