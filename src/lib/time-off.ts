import { timeLabel, ukDate } from "./format";
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

export function timeOffPeriodLabel(period: ReturnType<typeof timeOffPeriods>[number]) {
  return `${ukDate(period.date)} · ${timeLabel(period.start_time)} – ${period.end.date === period.date ? "" : `${ukDate(period.end.date)} · `}${timeLabel(period.end.time)}`;
}
