import { format, parseISO } from "date-fns";
import type { AppointmentRow } from "./db";
import { shortDate, timeLabel, timeToMin } from "./format";
import type { CloudBlock } from "./sync";

// UTC is calendar arithmetic here: these are London wall-clock dates/times,
// so a holiday spanning a clock change still covers every selected local day.
export function timeOffMoment(date: string, time: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return NaN;
  const parsed = Date.parse(`${date}T${time}:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date ? parsed : NaN;
}

export function timeOffEnd(block: CloudBlock) {
  const end = new Date(timeOffMoment(block.date, block.start_time) + block.duration_min * 60_000).toISOString();
  return { date: end.slice(0, 10), time: end.slice(11, 16) };
}

export function timeOffPeriods(blocks: CloudBlock[]) {
  const grouped = new Map<string, CloudBlock[]>();
  for (const block of blocks) {
    const key = block.period_id ?? block.id;
    grouped.set(key, [...(grouped.get(key) ?? []), block]);
  }
  return [...grouped.entries()].map(([id, days]) => {
    days.sort((a, b) => `${a.date}${a.start_time}`.localeCompare(`${b.date}${b.start_time}`));
    const first = days[0], end = timeOffEnd(days[days.length - 1]);
    return { id, label: first.label, date: first.date, start_time: first.start_time, end, blocks: days };
  }).sort((a, b) => `${a.date}${a.start_time}`.localeCompare(`${b.date}${b.start_time}`));
}

export type TimeOffPeriod = ReturnType<typeof timeOffPeriods>[number];

/** Whole days off are saved as midnight on the first day to 23:59 on the last. */
export const WHOLE_DAY_START = "00:00";
export const WHOLE_DAY_END = "23:59";

/** One day's slice of time off that runs from midnight to midnight. */
export const isWholeDayBlock = (block: Pick<CloudBlock, "start_time" | "duration_min">) =>
  block.start_time === WHOLE_DAY_START && block.duration_min >= 24 * 60 - 1;

/** The first and last day of a period made of whole days, or null when it has start and finish times. */
export function timeOffWholeDays(period: Pick<TimeOffPeriod, "date" | "start_time" | "end">): { from: string; to: string } | null {
  if (period.start_time !== WHOLE_DAY_START) return null;
  if (period.end.time === WHOLE_DAY_END) return { from: period.date, to: period.end.date };
  // Older holidays ran to midnight at the start of the following day.
  if (period.end.time === "00:00" && period.end.date > period.date) {
    return { from: period.date, to: new Date(timeOffMoment(period.end.date, "00:00") - 86_400_000).toISOString().slice(0, 10) };
  }
  return null;
}

/** Mon 2 Feb, with the year once it isn't this year. */
const plainDay = (iso: string) => iso.slice(0, 4) === String(new Date().getFullYear()) ? shortDate(iso) : format(parseISO(iso), "EEE d MMM yyyy");

/** "Mon 2 Feb, all day", "Mon 2 Feb to Fri 6 Feb" or "Mon 2 Feb, 1pm to 3pm". */
export function timeOffPeriodLabel(period: Pick<TimeOffPeriod, "date" | "start_time" | "end">) {
  const whole = timeOffWholeDays(period);
  if (whole) return whole.from === whole.to ? `${plainDay(whole.from)}, all day` : `${plainDay(whole.from)} to ${plainDay(whole.to)}`;
  const start = `${plainDay(period.date)}, ${timeLabel(period.start_time)}`;
  return period.end.date === period.date ? `${start} to ${timeLabel(period.end.time)}` : `${start} to ${plainDay(period.end.date)}, ${timeLabel(period.end.time)}`;
}

/** What one day's slice says inside the diary: "All day" or "1pm to 3pm". */
export function timeOffBlockTime(block: CloudBlock) {
  if (isWholeDayBlock(block)) return "All day";
  const end = timeOffEnd(block);
  return `${timeLabel(block.start_time)} to ${end.date === block.date ? timeLabel(end.time) : "midnight"}`;
}

/** Confirmed appointments that sit inside a stretch of time off. They are not moved or cancelled. */
export function timeOffClashes(appointments: AppointmentRow[], from: number, to: number) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  return appointments.filter((appointment) => {
    if (appointment.status !== "confirmed") return false;
    const day = timeOffMoment(appointment.date, "00:00");
    // A booking still waiting for its time only clashes when the whole day is taken.
    if (appointment.time_confirmed === 0) return from <= day && to >= day + (24 * 60 - 1) * 60_000;
    const start = day + timeToMin(appointment.start_time) * 60_000;
    return start < to && start + appointment.duration_min * 60_000 > from;
  });
}
