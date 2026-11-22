import { useId, useState, type ReactNode } from "react";
import { addDays, format, parseISO } from "date-fns";
import { ChevronDown } from "lucide-react";
import type { AppointmentRow } from "@/lib/db";
import type { BusinessSettings, CloudBlock } from "@/lib/sync";
import { isoDate, minToTime, timeLabel, timeToMin } from "@/lib/format";
import { timeOffMoment } from "@/lib/time-off";
import { cn } from "@/lib/utils";
import { Chip, Field, Input } from "./ui";

/*
 * "Tap to pick" pieces for booking: a day strip, the free times for that day, and the sums behind
 * them. The free times and the clash warning are helpers worked out on this device from opening
 * hours, the diary and time off. They never block a booking: the website stays the authority.
 */

export type Hours = { open: string; close: string };
export interface BusyTime { from: number; to: number; kind: "appointment" | "timeOff"; name: string; start: string }

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Opening hours for a date. `null` means closed that day; `undefined` means hours aren't known here. */
export function openingHours(date: string, settings: Pick<BusinessSettings, "opening_hours"> | null | undefined): Hours | null | undefined {
  if (!settings?.opening_hours || !ISO_DAY.test(date)) return undefined;
  const weekday = parseISO(date).getDay();
  const hours = settings.opening_hours.find((item) => item.weekday === weekday);
  return hours ? { open: hours.open, close: hours.close } : null;
}

/** Everything already in the diary for a day: timed bookings and requests, and time off. */
export function busyTimes(date: string, rows: AppointmentRow[], blocks: CloudBlock[], excludeId?: number): BusyTime[] {
  const busy: BusyTime[] = [];
  for (const row of rows) {
    if (row.id === excludeId || row.date !== date || !row.time_confirmed || (row.status !== "confirmed" && row.status !== "pending")) continue;
    const from = timeToMin(row.start_time);
    busy.push({ from, to: from + row.duration_min, kind: "appointment", name: row.client_name || "another booking", start: row.start_time });
  }
  const dayStart = timeOffMoment(date, "00:00");
  for (const block of blocks) {
    const from = (timeOffMoment(block.date, block.start_time) - dayStart) / 60_000;
    const to = from + block.duration_min;
    if (!Number.isFinite(from) || to <= 0 || from >= 1440) continue;
    busy.push({ from: Math.max(0, from), to: Math.min(1440, to), kind: "timeOff", name: block.label, start: minToTime(Math.max(0, from)) });
  }
  return busy.sort((a, b) => a.from - b.from);
}

const overlaps = (from: number, to: number, busy: BusyTime) => from < busy.to && to > busy.from;

/** Start times, half an hour apart, where an appointment of this length fits inside opening hours. */
export function freeSlots(hours: Hours, busy: BusyTime[], duration: number, notBefore = -1): string[] {
  const slots: string[] = [];
  const close = timeToMin(hours.close);
  for (let from = timeToMin(hours.open); from + duration <= close; from += 30) {
    if (from < notBefore || busy.some((item) => overlaps(from, from + duration, item))) continue;
    slots.push(minToTime(from));
  }
  return slots;
}

/** Plain warnings for a chosen time. An empty list means nothing is in the way. */
export function clashWarnings(date: string, start: string, duration: number, hours: Hours | null | undefined, busy: BusyTime[]): string[] {
  if (!ISO_DAY.test(date) || !start) return [];
  const from = timeToMin(start), to = from + duration;
  const hit = busy.filter((item) => overlaps(from, to, item));
  const booked = hit.filter((item) => item.kind === "appointment");
  const off = hit.find((item) => item.kind === "timeOff");
  const warnings: string[] = [];
  if (booked.length) {
    const others = booked.length - 1;
    warnings.push(`This overlaps ${booked[0].name} at ${timeLabel(booked[0].start)}${others ? ` and ${others} other booking${others === 1 ? "" : "s"}` : ""}.`);
  }
  if (off) warnings.push(`This overlaps your time off${off.name ? ` (${off.name})` : ""}.`);
  if (hours === null) warnings.push(`You're usually closed on ${format(parseISO(date), "EEEE")}s.`);
  else if (hours && (from < timeToMin(hours.open) || to > timeToMin(hours.close))) warnings.push(`This is outside your opening hours (${timeLabel(hours.open)} to ${timeLabel(hours.close)}).`);
  return warnings;
}

/** A labelled set of chips or tiles. Chips can't sit inside a `Field`, whose label would swallow their names. */
export function ChoiceGroup({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className={cn("min-w-0", className)}>
      <div id={id} className="mb-1.5 text-small font-medium text-ink">{label}</div>
      {children}
    </div>
  );
}

/** A choice with a second line: a service with its length and price. Pressed means chosen. */
export function OptionTile({ title, detail, selected, className, ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title"> & { title: ReactNode; detail?: ReactNode; selected?: boolean }) {
  return (
    <button type="button" aria-pressed={!!selected} {...props}
      className={cn(
        "flex min-h-11 w-full min-w-0 cursor-pointer flex-col items-start justify-center rounded-xl border px-3.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        selected ? "border-transparent bg-accent text-accent-ink" : "border-line bg-surface text-ink hover:bg-surface-2",
        className,
      )}>
      <span className={cn("max-w-full break-words text-body", selected ? "font-semibold" : "font-medium")}>{title}</span>
      {detail && <span className={cn("tabular max-w-full break-words text-small", selected ? "text-accent-ink/85" : "text-ink-2")}>{detail}</span>}
    </button>
  );
}

/** Today, tomorrow and the rest of the week as tiles, with "Other date" for anything further out. */
export function DayPicker({ value, onChange, today, disabled }: { value: string; onChange: (date: string) => void; today: string; disabled?: boolean }) {
  const [other, setOther] = useState(false);
  const days = Array.from({ length: 7 }, (_, index) => isoDate(addDays(parseISO(today), index)));
  const custom = other || !days.includes(value);
  return (
    <ChoiceGroup label="Day">
      <div className="grid grid-cols-4 gap-2">
        {days.map((day, index) => (
          <Chip key={day} selected={!custom && value === day} disabled={disabled} onClick={() => { setOther(false); onChange(day); }} className="h-14 flex-col gap-0 px-1">
            <span className="text-label">{index === 0 ? "Today" : index === 1 ? "Tomorrow" : format(parseISO(day), "EEE")}</span>
            <span className="tabular">{format(parseISO(day), "d MMM")}</span>
          </Chip>
        ))}
        <Chip selected={custom} disabled={disabled} onClick={() => setOther(true)} className="h-14 whitespace-normal px-1 text-center">Other date</Chip>
      </div>
      {custom && <Field label="Date" className="mt-3"><Input type="date" value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} /></Field>}
    </ChoiceGroup>
  );
}

/**
 * Free start times as chips, with "Other time" to type any time at all.
 * `slots` is null when free times can't be offered (opening hours or the diary aren't available),
 * in which case the time box is simply shown.
 */
export function TimePicker({ value, onChange, slots, loading, note, finish, disabled }: {
  value: string; onChange: (time: string) => void; slots: string[] | null; loading?: boolean; note?: string | null; finish?: string | null; disabled?: boolean;
}) {
  const [other, setOther] = useState(false);
  const custom = other || (!loading && (slots === null || (value !== "" && !slots.includes(value))));
  return (
    <ChoiceGroup label="Time">
      {loading ? <p role="status" className="py-3 text-small text-ink-2">Checking free times…</p> : slots && <>
        {note && <p className="mb-2 text-small text-ink-2">{note}</p>}
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
          {slots.map((slot) => (
            <Chip key={slot} selected={!custom && value === slot} disabled={disabled} onClick={() => { setOther(false); onChange(slot); }} className="tabular px-1">{timeLabel(slot)}</Chip>
          ))}
          <Chip selected={custom} disabled={disabled} onClick={() => setOther(true)} className="col-span-2 px-1">Other time</Chip>
        </div>
      </>}
      {custom && <Field label="Start" className={cn(!loading && slots && "mt-3")}><Input type="time" step={300} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} /></Field>}
      {finish && <p className="mt-2 text-small text-ink-2">Finishes <span className="tabular">{finish}</span></p>}
    </ChoiceGroup>
  );
}

/** "More options": the rarely needed fields, tucked away until asked for. */
export function Disclosure({ label, open, onToggle, children }: { label: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  const id = useId();
  return (
    <div className="min-w-0 border-t border-line">
      <button type="button" aria-expanded={open} aria-controls={open ? id : undefined} onClick={onToggle}
        className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 py-2 text-left text-body font-medium text-ink">
        {label}
        <ChevronDown size={18} aria-hidden className={cn("shrink-0 text-ink-2 transition-transform", open && "rotate-180")} />
      </button>
      {open && <div id={id} className="flex min-w-0 flex-col gap-4 pb-1 pt-2">{children}</div>}
    </div>
  );
}
