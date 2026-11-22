import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CalendarOff, Save } from "lucide-react";
import { toast } from "sonner";
import { listAppointments, type AppointmentRow } from "@/lib/db";
import { useData, useLoad } from "@/lib/data";
import { businessNow } from "@/lib/dates";
import { isoDate, minToTime, shortDate, timeLabel, timeToMin } from "@/lib/format";
import { createTimeOff, deleteTimeOff, listBlocks, listCloudSettings, updateCloudSettings, type BusinessSettings, type CloudBlock } from "@/lib/sync";
import {
  WHOLE_DAY_END, WHOLE_DAY_START, timeOffClashes, timeOffMoment, timeOffPeriodLabel, timeOffPeriods, type TimeOffPeriod,
} from "@/lib/time-off";
import { Actions, Button, Checkbox, Chip, ConfirmModal, ErrorText, Field, Input, Modal, Notice } from "./ui";

type Kind = "hours" | "days" | "weekly";
const KINDS: { value: Kind; label: string }[] = [
  { value: "hours", label: "A few hours" },
  { value: "days", label: "Whole days" },
  { value: "weekly", label: "Every week" },
];
const REASONS = ["Holiday", "Appointment", "Personal"];
const DEFAULT_LABEL = "Time off";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Her week reads Monday to Sunday. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
type OpeningDay = { weekday: number; enabled: boolean; open: string; close: string };

const today = () => isoDate(businessNow());
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const listed = (words: string[]) => words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

/** Same reading of the saved week as the opening hours card in Settings. */
function openingDays(settings: BusinessSettings): OpeningDay[] {
  return WEEKDAYS.map((_, weekday) => {
    const hours = settings.opening_hours.find((item) => item.weekday === weekday);
    return { weekday, enabled: Boolean(hours), open: hours?.open ?? "09:00", close: hours?.close ?? "17:00" };
  });
}

/** Plain words for her, the reason for whoever helps her. */
function SaveError({ message, detail }: { message: string; detail: string }) {
  return <div>
    <ErrorText>{message}</ErrorText>
    {detail && <details className="mt-1 text-small text-ink-2"><summary className="cursor-pointer">Show details</summary><span className="break-words">{detail}</span></details>}
  </div>;
}

function ChoiceGroup({ label, children }: { label: string; children: ReactNode }) {
  return <div role="group" aria-label={label}>
    <div className="mb-1.5 text-small font-medium text-ink">{label}</div>
    {children}
  </div>;
}

/**
 * Taking time off, three plain ways: a few hours, whole days, or the days she never works.
 * The first two block that stretch of the diary. "Every week" changes her usual working week.
 */
export function TimeOffDialog({ online, initialDate, initialStart, onClose, onSaved }: {
  online: boolean; initialDate?: string; initialStart?: string; onClose: () => void; onSaved: () => void;
}) {
  const { refresh } = useData();
  const [kind, setKind] = useState<Kind>(initialStart ? "hours" : "days");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // A few hours, and whole days
  const [date, setDate] = useState(() => initialDate || today());
  const [start, setStart] = useState(initialStart || "09:00");
  const [end, setEnd] = useState(() => minToTime(Math.min(timeToMin(initialStart || "09:00") + 60, 24 * 60 - 1)));
  const [firstDay, setFirstDay] = useState(() => initialDate || today());
  const [lastDay, setLastDay] = useState(() => initialDate || today());
  const [reason, setReason] = useState<string | null>(null);
  const [other, setOther] = useState("");
  const label = (reason === "other" ? other.trim() : reason) || DEFAULT_LABEL;

  const period = kind === "hours"
    ? { date, start_time: start, end_date: date, end_time: end }
    : { date: firstDay, start_time: WHOLE_DAY_START, end_date: lastDay, end_time: WHOLE_DAY_END };
  const from = timeOffMoment(period.date, period.start_time), to = timeOffMoment(period.end_date, period.end_time);
  const complete = Number.isFinite(from) && Number.isFinite(to);
  const validRange = complete && to > from;
  const coveredDays = Math.ceil(to / 86_400_000) - Math.floor(from / 86_400_000);
  const valid = validRange && coveredDays <= 366 && label.length <= 100;

  // Every week
  const [settings, settingsLoading] = useLoad(listCloudSettings, [], null);
  const [days, setDays] = useState<OpeningDay[]>([]);
  const [dirty, setDirty] = useState(false);
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  useEffect(() => {
    if (!settings || dirty) return;
    setDays(openingDays(settings));
    setBaseRevision(settings.revision);
  }, [settings, dirty]);
  const stale = dirty && settings !== null && baseRevision !== settings.revision;
  const working = WEEK_ORDER.map((weekday) => days.find((day) => day.weekday === weekday)).filter((day): day is OpeningDay => Boolean(day?.enabled));
  const off = WEEK_ORDER.filter((weekday) => days.some((day) => day.weekday === weekday && !day.enabled));
  const newlyOff = settings ? off.filter((weekday) => settings.opening_hours.some((item) => item.weekday === weekday)) : [];
  const newlyWorking = settings ? working.filter((day) => !settings.opening_hours.some((item) => item.weekday === day.weekday)) : [];
  const noWorkingDays = days.length > 0 && working.length === 0;
  // The website can't take bookings with no working day, the same rule as the opening hours card.
  const blockedWeek = noWorkingDays && Boolean(settings?.booking_enabled);
  const toggleDay = (weekday: number) => {
    setDirty(true);
    setDays((current) => current.map((day) => day.weekday === weekday ? { ...day, enabled: !day.enabled } : day));
  };

  // Appointments already booked in the chosen time. They stay booked: this only warns.
  const lookFrom = kind === "weekly" ? today() : period.date;
  const lookTo = kind === "weekly" ? "" : period.end_date;
  const lookUp = kind === "weekly" ? newlyOff.length > 0 : valid;
  const [booked] = useLoad<AppointmentRow[]>(
    () => lookUp ? listAppointments(lookTo ? { from: lookFrom, to: lookTo } : { from: lookFrom }) : Promise.resolve([]),
    [lookUp, lookFrom, lookTo], [],
  );
  const clashes = !lookUp ? [] : kind === "weekly"
    ? booked.filter((appointment) => appointment.status === "confirmed" && newlyOff.includes(new Date(timeOffMoment(appointment.date, "00:00")).getUTCDay()))
    : timeOffClashes(booked, from, to);

  const fail = (cause: unknown) => { setError(cause instanceof Error ? cause.message : "The change could not be saved."); refresh(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!online || busy) return;
    if (kind === "weekly") {
      if (!settings || !dirty || stale || blockedWeek) return;
      setBusy(true); setError("");
      try {
        await updateCloudSettings({ ...settings, revision: baseRevision ?? settings.revision, booking_enabled: settings.booking_enabled, timezone: "Europe/London", slot_minutes: 30, horizon_days: 90, opening_hours: days.filter((day) => day.enabled).map(({ weekday, open, close }) => ({ weekday, open, close })) });
        setDirty(false);
        toast.success("Working days saved");
        onSaved();
      } catch (cause) { fail(cause); }
      finally { setBusy(false); }
      return;
    }
    if (!valid) return;
    setBusy(true); setError("");
    try {
      await createTimeOff({ ...period, label });
      toast.success("Time off added");
      onSaved();
    } catch (cause) { fail(cause); }
    finally { setBusy(false); }
  };

  const [blocks] = useLoad(listBlocks, [], []);

  return <Modal open onClose={() => { if (!busy) onClose(); }} title="Time off" width="max-w-lg">
    <form onSubmit={submit}>
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <div role="group" aria-label="What kind of time off" className="grid grid-cols-3 gap-2">
          {KINDS.map((item) => <Chip key={item.value} selected={kind === item.value} onClick={() => { setKind(item.value); setError(""); }} className="h-auto min-h-11 shrink whitespace-normal px-2 py-1.5 text-center">{item.label}</Chip>)}
        </div>

        {kind === "hours" && <>
          <Field label="Date"><Input type="date" required value={date} onChange={(event) => setDate(event.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From"><Input type="time" required value={start} onChange={(event) => {
              const next = event.target.value;
              setStart(next);
              // Keep the finish after the start, so moving the start never leaves an impossible time.
              if (next && end <= next) setEnd(minToTime(Math.min(timeToMin(next) + 60, 24 * 60 - 1)));
            }} /></Field>
            <Field label="To"><Input type="time" required value={end} onChange={(event) => setEnd(event.target.value)} /></Field>
          </div>
          {complete && !validRange && <ErrorText>The finish time must be after the start time.</ErrorText>}
        </>}

        {kind === "days" && <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="First day off"><Input type="date" required value={firstDay} onChange={(event) => { const next = event.target.value; setFirstDay(next); if (next && lastDay < next) setLastDay(next); }} /></Field>
            <Field label="Last day off"><Input type="date" required min={firstDay} value={lastDay} onChange={(event) => setLastDay(event.target.value)} /></Field>
          </div>
          <p className="text-small text-ink-2">{validRange ? `${plural(coveredDays, "day")} off. ` : ""}For a single day, keep both dates the same.</p>
          {complete && !validRange && <ErrorText>The last day off can't be before the first.</ErrorText>}
          {validRange && coveredDays > 366 && <ErrorText>Choose a period covering no more than 366 days.</ErrorText>}
        </>}

        {kind !== "weekly" && <>
          <ChoiceGroup label="What's it for? (optional)">
            <div className="flex flex-wrap gap-2">
              {REASONS.map((item) => <Chip key={item} selected={reason === item} onClick={() => setReason(reason === item ? null : item)}>{item}</Chip>)}
              <Chip selected={reason === "other"} onClick={() => setReason(reason === "other" ? null : "other")}>Something else</Chip>
            </div>
            {reason === "other" && <Input className="mt-2" autoFocus maxLength={100} aria-label="What's it for?" placeholder="For example, training day" value={other} onChange={(event) => setOther(event.target.value)} />}
          </ChoiceGroup>
          <p className="text-small text-ink-2">Nobody can book online in this time. It shows in your diary as “{label}”.</p>
        </>}

        {kind === "weekly" && (!settings
          ? <p className="text-small text-ink-2">{settingsLoading ? "Loading your working week…" : "Your working week isn't available yet. Check your connection and try again."}</p>
          : <>
            <ChoiceGroup label="Days you don't work">
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                {WEEK_ORDER.map((weekday) => {
                  const day = days.find((item) => item.weekday === weekday);
                  return <Chip key={weekday} selected={day ? !day.enabled : false} disabled={!online} aria-label={`${WEEKDAYS[weekday]} off`} onClick={() => toggleDay(weekday)} className="shrink px-1">{WEEKDAYS[weekday].slice(0, 3)}</Chip>;
                })}
              </div>
            </ChoiceGroup>
            <p className="text-body">
              {noWorkingDays ? "You'd have no working days at all."
                : `You work ${listed(working.map((day) => WEEKDAYS[day.weekday]))}.${off.length ? ` Off every ${listed(off.map((weekday) => WEEKDAYS[weekday]))}.` : ""}`}
            </p>
            <p className="text-small text-ink-2">
              This changes your usual working week, and the website stops offering the days you're off. For a regular half day, change that day's hours in <Link to="/settings?section=hours" onClick={onClose} className="font-medium text-ink underline underline-offset-2">Settings</Link>.
            </p>
            {newlyWorking.length > 0 && <p className="text-small text-ink-2">{listed(newlyWorking.map((day) => WEEKDAYS[day.weekday]))} will open {timeLabel(newlyWorking[0].open)} to {timeLabel(newlyWorking[0].close)}. You can change the hours in Settings.</p>}
            {blockedWeek && <ErrorText>Keep at least one working day while the website is taking bookings. To stop website bookings, turn them off in Settings.</ErrorText>}
            {noWorkingDays && !blockedWeek && <Notice tone="bad">With no working days, the website can't offer any times. Save only if that's what you want.</Notice>}
            {stale && <ErrorText>Your settings were changed on another device. Load the latest before saving.</ErrorText>}
          </>)}

        {clashes.length > 0 && <Notice>
          <span className="font-medium text-ink">{clashes.length === 1 ? "1 appointment is" : `${clashes.length} appointments are`} booked {kind === "weekly" ? "on those days" : "in this time"}. {clashes.length === 1 ? "It stays" : "They stay"} booked.</span>
          <ul className="mt-1">
            {clashes.slice(0, 3).map((appointment) => <li key={appointment.id} className="break-words">{appointment.client_name || "Client"} · {shortDate(appointment.date)}{appointment.time_confirmed === 0 ? "" : `, ${timeLabel(appointment.start_time)}`}</li>)}
            {clashes.length > 3 && <li>and {clashes.length - 3} more</li>}
          </ul>
        </Notice>}

        {!online && <Notice>You're offline. Adding or changing time off needs a connection.</Notice>}
        {error && <SaveError message="Couldn't save. Try again." detail={error} />}

        <Actions>
          {kind === "weekly" && dirty && <Button disabled={busy} onClick={() => { setDirty(false); setError(""); }}>{stale ? "Load latest" : "Reset"}</Button>}
          <Button onClick={onClose}>Cancel</Button>
          {kind === "weekly"
            ? <Button variant="primary" type="submit" disabled={!online || !settings || !dirty || stale || blockedWeek}><Save size={16} aria-hidden />{busy ? "Saving…" : "Save working days"}</Button>
            : <Button variant="primary" type="submit" disabled={!online || !valid}><CalendarOff size={16} aria-hidden />{busy ? "Saving…" : "Add time off"}</Button>}
        </Actions>
      </fieldset>
    </form>

    <section aria-labelledby="booked-time-off" className="mt-6 border-t border-line pt-4">
      <h3 id="booked-time-off" className="text-heading font-semibold">Booked time off</h3>
      <TimeOffList blocks={blocks} online={online} onChanged={refresh} />
    </section>
  </Modal>;
}

/** Asks before removing. `onChanged` reloads the diary either way; `onRemoved` runs only once it has gone. */
function RemoveTimeOffConfirm({ period, onChanged, onRemoved, onClose }: { period: TimeOffPeriod | null; onChanged: () => void; onRemoved?: () => void; onClose: () => void }) {
  const remove = async () => {
    if (!period) return;
    try {
      await deleteTimeOff(period.blocks);
    } catch (cause) {
      console.error("Time off could not be removed", cause);
      onChanged();
      throw new Error("Couldn't remove it. Try again.");
    }
    toast.success("Time off removed");
    onChanged();
    onRemoved?.();
  };
  return <ConfirmModal open={period !== null} title="Remove time off?" confirmLabel="Remove" cancelLabel="Keep it" onClose={onClose} onConfirm={remove}
    message={period && <>
      <span className="block font-medium text-ink">{period.label || DEFAULT_LABEL}</span>
      <span className="block">{timeOffPeriodLabel(period)}</span>
      <span className="mt-2 block">People will be able to book this time again.</span>
    </>} />;
}

/** Upcoming time off, each with a Remove button that asks first. Used in Settings and in the Diary's time-off dialog. */
export function TimeOffList({ blocks, online, onChanged }: { blocks: CloudBlock[]; online: boolean; onChanged: () => void }) {
  const [showPast, setShowPast] = useState(false);
  const [removing, setRemoving] = useState<TimeOffPeriod | null>(null);
  const now = today();
  const periods = timeOffPeriods(blocks);
  const shown = periods.filter((period) => showPast || period.end.date >= now);
  return <div>
    {!shown.length && <p className="py-3 text-small text-ink-2">No {showPast ? "" : "upcoming "}time off.</p>}
    <ul className="divide-y divide-line">
      {shown.map((period) => <li key={period.id} className="flex items-center justify-between gap-3 py-3">
        <div className="min-w-0">
          <p className="break-words font-medium">{period.label || DEFAULT_LABEL}</p>
          <p className="text-small text-ink-2">{timeOffPeriodLabel(period)}</p>
        </div>
        <Button size="sm" disabled={!online} aria-label={`Remove ${period.label || DEFAULT_LABEL}`} title={online ? undefined : "Removing time off needs a connection"} onClick={() => setRemoving(period)}>Remove</Button>
      </li>)}
    </ul>
    {!online && shown.length > 0 && <p className="text-small text-ink-2">Removing time off needs a connection.</p>}
    {periods.some((period) => period.end.date < now) && <Checkbox label="Show past time off" checked={showPast} onChange={(event) => setShowPast(event.target.checked)} className="text-small" />}
    <RemoveTimeOffConfirm period={removing} onChanged={onChanged} onClose={() => setRemoving(null)} />
  </div>;
}

/** Opened by tapping time off in the diary: what it is, when, and a way to remove it. */
export function TimeOffDetails({ period, online, onClose, onChanged }: { period: TimeOffPeriod; online: boolean; onClose: () => void; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return <>
    <Modal open onClose={onClose} title="Time off" width="max-w-sm">
      <p className="break-words text-heading font-semibold">{period.label || DEFAULT_LABEL}</p>
      <p className="text-body text-ink-2">{timeOffPeriodLabel(period)}</p>
      <p className="mt-2 text-small text-ink-2">Nobody can book online in this time.{period.blocks.length > 1 ? ` Removing it frees all ${period.blocks.length} days.` : ""}</p>
      {!online && <p className="mt-2 text-small text-ink-2">Removing time off needs a connection.</p>}
      <Actions className="mt-5">
        <Button onClick={onClose}>Close</Button>
        <Button variant="danger" disabled={!online} onClick={() => setConfirming(true)}>Remove time off</Button>
      </Actions>
    </Modal>
    <RemoveTimeOffConfirm period={confirming ? period : null} onClose={() => setConfirming(false)} onChanged={onChanged} onRemoved={onClose} />
  </>;
}
