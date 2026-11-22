import { useMemo } from "react";
import { format, isSameDay, isSameMonth } from "date-fns";
import { Check, Clock, MapPin, Plus } from "lucide-react";
import { isOwed, type AppointmentRow } from "@/lib/db";
import type { CloudBlock } from "@/lib/sync";
import { durationLabel, isoDate, minToTime, money, moneyNeat, timeLabel, timeToMin } from "@/lib/format";
import { isWholeDayBlock, timeOffBlockTime } from "@/lib/time-off";
import { cn } from "@/lib/utils";
import { useBusinessNow } from "@/lib/dates";

const HOUR_PX = 64;
const PX_PER_MIN = HOUR_PX / 60;
const SNAP_MIN = 15;
const MIN_BLOCK_PX = 28;
/** The hours shown when her opening hours aren't known. Earlier or later bookings widen it. */
const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 20;
/** The shortest stretch worth offering as "Free ... Book" on a phone. */
const MIN_FREE_MIN = 30;
/** Time off is striped so it never reads as an appointment. */
const STRIPES = { backgroundImage: "repeating-linear-gradient(135deg, transparent 0, transparent 5px, var(--border) 5px, var(--border) 6px)" };

/** Her usual working week, as saved with the booking settings. */
export type OpeningHours = { weekday: number; open: string; close: string }[];

export interface CalendarProps {
  days: Date[];
  rows: AppointmentRow[];
  blocks?: CloudBlock[];
  /** Missing or empty means her hours aren't known: nothing is shaded as closed. */
  hours?: OpeningHours | null;
  onOpen: (a: AppointmentRow) => void;
  /** Clicking an empty slot books a new appointment there. */
  onNew: (date: string, startTime: string) => void;
  onShowDay?: (day: Date) => void;
  /** Clicking time off shows what it is and lets her remove it. */
  onOpenBlock?: (block: CloudBlock) => void;
}

const endMin = (a: AppointmentRow) => timeToMin(a.start_time) + a.duration_min;
const showDay = (d: Date) => `Show ${format(d, "EEEE d MMMM yyyy")}`;

/** Her hours that day: undefined when unknown, null when she doesn't work it. */
function openOn(hours: OpeningHours | null | undefined, day: Date) {
  if (!hours?.length) return undefined;
  const found = hours.find((item) => item.weekday === day.getDay());
  return found ? { open: timeToMin(found.open), close: timeToMin(found.close) } : null;
}

function blocksByDay(blocks: CloudBlock[]) {
  const grouped = new Map<string, CloudBlock[]>();
  for (const block of blocks) {
    const day = grouped.get(block.date);
    if (day) day.push(block);
    else grouped.set(block.date, [block]);
  }
  return grouped;
}

function groupByDay(rows: AppointmentRow[]) {
  const byDay = new Map<string, AppointmentRow[]>();
  for (const a of rows) {
    const day = byDay.get(a.date);
    if (day) day.push(a);
    else byDay.set(a.date, [a]);
  }
  for (const day of byDay.values()) day.sort((a, b) => a.time_confirmed - b.time_confirmed || timeToMin(a.start_time) - timeToMin(b.start_time) || a.id - b.id);
  return byDay;
}

/**
 * Side-by-side placement for appointments that clash, the way Outlook does it:
 * a run of overlapping appointments is one cluster, and each one takes the
 * first column that's free by the time it starts.
 */
function place(dayRows: AppointmentRow[]) {
  const clusters: AppointmentRow[][] = [];
  let current: AppointmentRow[] = [];
  let clusterEnd = -1;
  for (const a of dayRows) {
    if (current.length && timeToMin(a.start_time) < clusterEnd) {
      current.push(a);
      clusterEnd = Math.max(clusterEnd, endMin(a));
    } else {
      if (current.length) clusters.push(current);
      current = [a];
      clusterEnd = endMin(a);
    }
  }
  if (current.length) clusters.push(current);

  return clusters.flatMap((cluster) => {
    const colEnds: number[] = [];
    const placed = cluster.map((a) => {
      let col = colEnds.findIndex((end) => end <= timeToMin(a.start_time));
      if (col === -1) col = colEnds.length;
      colEnds[col] = endMin(a);
      return { a, col };
    });
    return placed.map((p) => ({ ...p, cols: colEnds.length }));
  });
}

const title = (a: AppointmentRow) => a.client_name || a.service_name || a.category_name || "Appointment";
const service = (a: AppointmentRow) => a.service_name || a.category_name || "Appointment";

const offStatus = (a: AppointmentRow) => a.status === "cancelled" || a.status === "no_show" || a.status === "rejected";

const statusNote = (status: AppointmentRow["status"]) =>
  status === "pending" ? "Awaiting approval" : status === "confirmed" ? "Confirmed" : status === "cancelled" ? "Cancelled" : status === "no_show" ? "Didn't show" : "Declined";

const hoverTitle = (a: AppointmentRow) =>
  `${a.time_confirmed === 0 ? "Time to confirm" : timeLabel(a.start_time)} · ${title(a)}${a.price_pence != null ? ` · ${money(a.price_pence)}` : ""} · ${statusNote(a.status)}${a.transaction_id != null ? " · paid" : ""}${a.is_remote ? " · home visit" : ""}`;

/**
 * How an appointment is drawn. One brand palette, not a colour per service:
 * blush for booked, solid chocolate for the next one today, a rose outline once
 * it's finished and still to be paid, dashed for a request, faded once it's off.
 */
type Tone = "confirmed" | "next" | "owed" | "paid" | "pending" | "off";

const toneClass: Record<Tone, string> = {
  confirmed: "border border-line bg-surface-2 text-ink hover:border-line-strong",
  paid: "border border-line bg-surface-2 text-ink hover:border-line-strong",
  next: "border border-transparent bg-accent text-accent-ink hover:bg-accent-hover",
  owed: "border border-rose-ink bg-surface text-ink hover:bg-surface-2/60",
  pending: "border border-dashed border-line-strong bg-surface text-ink hover:bg-surface-2/60",
  off: "border border-line bg-surface text-ink-2 opacity-60 hover:opacity-80",
};
const quiet = (tone: Tone) => tone === "next" ? "text-accent-ink/85" : "text-ink-2";
const toCollect = (a: AppointmentRow) => a.price_pence ? `${moneyNeat(a.price_pence)} to collect` : "Payment to collect";

function useTones(rows: AppointmentRow[]) {
  const now = useBusinessNow();
  const today = isoDate(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nextId = useMemo(() => rows
    .filter((a) => a.date === today && a.status === "confirmed" && a.time_confirmed !== 0 && endMin(a) > nowMin)
    .sort((a, b) => timeToMin(a.start_time) - timeToMin(b.start_time) || a.id - b.id)[0]?.id ?? null, [rows, today, nowMin]);
  return (a: AppointmentRow): Tone => {
    if (offStatus(a)) return "off";
    if (a.status === "pending") return "pending";
    if (a.id === nextId) return "next";
    if (a.transaction_id != null) return "paid";
    const finished = a.date < today || (a.date === today && a.time_confirmed !== 0 && endMin(a) <= nowMin);
    return finished && isOwed(a) ? "owed" : "confirmed";
  };
}

/** Earliest opening to latest closing across her week, widened by anything booked outside it. */
function visibleHours(rows: AppointmentRow[], blocks: CloudBlock[], hours: OpeningHours | null | undefined) {
  let from = DEFAULT_START_HOUR;
  let to = DEFAULT_END_HOUR;
  if (hours?.length) {
    from = Math.min(...hours.map((item) => Math.floor(timeToMin(item.open) / 60)));
    to = Math.max(...hours.map((item) => Math.ceil(timeToMin(item.close) / 60)));
  }
  for (const a of rows) {
    if (a.time_confirmed === 0) continue;
    from = Math.min(from, Math.floor(timeToMin(a.start_time) / 60));
    to = Math.max(to, Math.ceil(endMin(a) / 60));
  }
  for (const b of blocks) {
    // A holiday runs midnight to midnight: it fills the day shown, it doesn't stretch the grid to 24 hours.
    const start = timeToMin(b.start_time), end = start + b.duration_min;
    if (start > 0) from = Math.min(from, Math.floor(start / 60));
    if (end < 24 * 60 - 1) to = Math.max(to, Math.ceil(end / 60));
  }
  from = Math.max(0, Math.min(from, 23));
  return [from, Math.min(24, Math.max(to, from + 1))] as const;
}

/** Day and week view: hours down the side, appointments as blocks. */
export function TimeGrid({ days, rows, blocks = [], hours, onOpen, onNew, onShowDay, onOpenBlock }: CalendarProps) {
  const now = useBusinessNow();
  const shownDays = days.map(isoDate).join(",");
  const shown = useMemo(() => {
    const dates = new Set(shownDays.split(","));
    return { rows: rows.filter((a) => dates.has(a.date)), blocks: blocks.filter((b) => dates.has(b.date)) };
  }, [rows, blocks, shownDays]);
  const byDay = useMemo(() => groupByDay(shown.rows), [shown]);
  const byBlockDay = useMemo(() => blocksByDay(shown.blocks), [shown]);
  const tone = useTones(rows);
  const [startHour, endHour] = useMemo(() => visibleHours(shown.rows, shown.blocks, hours), [shown, hours]);

  const hourMarks = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const gridStart = startHour * 60;
  const gridEnd = endHour * 60;
  const height = (endHour - startHour) * HOUR_PX;
  // Bookings still waiting for a time, and whole days off, sit in a row above the hours.
  const hasAllDay = shown.rows.some((appointment) => appointment.time_confirmed === 0) || shown.blocks.some(isWholeDayBlock);

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowVisible = nowMin >= gridStart && nowMin <= gridEnd;

  return (
    <div>
      <div className="flex pl-14">
        {days.map((d) => (
          <div key={d.toISOString()} className="min-w-0 flex-1 border-l border-line px-1 pb-2 text-center">
            <div className="text-label text-ink-2">{format(d, "EEE")}</div>
            <button
              type="button"
              onClick={() => onShowDay?.(d)}
              aria-label={showDay(d)}
              className={cn(
                "btn-sm tabular mx-auto mt-0.5 flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-small font-semibold",
                isSameDay(d, now) ? "bg-accent text-accent-ink" : "text-ink hover:bg-surface-2",
              )}
            >
              {format(d, "d")}
            </button>
          </div>
        ))}
      </div>

      {hasAllDay && <div className="relative flex border-t border-line pl-14" aria-label="All-day appointments awaiting a time">
        <span className="absolute left-0 top-3 w-12 text-right text-label text-ink-2">All day</span>
        {days.map((day) => <div key={day.toISOString()} className="min-w-0 flex-1 space-y-1 border-l border-line px-0.5 py-2">
          {(byBlockDay.get(isoDate(day)) ?? []).filter(isWholeDayBlock).map((b) => <button key={b.id} type="button" onClick={() => onOpenBlock?.(b)} title={`${b.label || "Time off"} · ${timeOffBlockTime(b)}`}
            className="block w-full min-w-0 cursor-pointer truncate rounded-lg border border-line bg-page px-2 py-1 text-left text-small font-medium hover:border-line-strong" style={STRIPES}>
            {b.label || "Time off"}
          </button>)}
          {(byDay.get(isoDate(day)) ?? []).filter((appointment) => appointment.time_confirmed === 0).map((appointment) => <button key={appointment.id} type="button" onClick={() => onOpen(appointment)} title={hoverTitle(appointment)}
            className={cn("w-full min-w-0 cursor-pointer rounded-lg border border-dashed border-line-strong bg-surface px-2 py-1 text-left hover:bg-surface-2/60", offStatus(appointment) && "opacity-60")}>
            <span className="flex items-center gap-1 text-small font-medium"><span className={cn("truncate", offStatus(appointment) && "line-through")}>{title(appointment)}</span>{!!appointment.is_remote && <MapPin size={14} className="ml-auto shrink-0 text-ink-2" aria-hidden />}</span>
            <span className="flex items-center gap-1 text-label text-ink-2"><Clock size={12} className="shrink-0" aria-hidden /><span className="truncate">Time to confirm</span></span>
          </button>)}
        </div>)}
      </div>}

      {/* Hour labels and hour lines share the same offsets, so they can't drift apart. */}
      <div className="relative border-t border-line" style={{ height }}>
        {hourMarks.map((h, i) => (
          <div key={h} className="pointer-events-none absolute inset-x-0 z-[1]" style={{ top: i * HOUR_PX }} aria-hidden>
            <span className="tabular absolute -top-2 left-0 w-12 text-right text-label text-ink-2">
              {timeLabel(minToTime(h * 60))}
            </span>
            {i > 0 && <div className="ml-14 border-t border-line" />}
          </div>
        ))}

        <div className="flex h-full pl-14">
          {days.map((d) => {
            const date = isoDate(d);
            const dayRows = (byDay.get(date) ?? []).filter((appointment) => appointment.time_confirmed !== 0);
            const open = openOn(hours, d);
            return (
              <div
                key={d.toISOString()}
                className="relative min-w-0 flex-1 cursor-pointer border-l border-line"
                onClick={(e) => {
                  const box = e.currentTarget.getBoundingClientRect();
                  const min = gridStart + (e.clientY - box.top) / PX_PER_MIN;
                  onNew(date, minToTime(Math.floor(min / SNAP_MIN) * SNAP_MIN));
                }}
                role="presentation"
              >
                {/* Days and hours she doesn't usually work are shaded, and still take a booking. */}
                {open === null && <div className="pointer-events-none absolute inset-0 bg-surface-2/50"><span className="block truncate px-1 pt-2 text-center text-label text-ink-2">Closed</span></div>}
                {open && open.open > gridStart && <div className="pointer-events-none absolute inset-x-0 top-0 bg-surface-2/50" style={{ height: (Math.min(open.open, gridEnd) - gridStart) * PX_PER_MIN }} />}
                {open && open.close < gridEnd && <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-surface-2/50" style={{ height: (gridEnd - Math.max(open.close, gridStart)) * PX_PER_MIN }} />}

                {(byBlockDay.get(date) ?? []).map((b) => {
                  const from = Math.max(timeToMin(b.start_time), gridStart);
                  const to = Math.min(timeToMin(b.start_time) + b.duration_min, gridEnd);
                  if (to <= from) return null;
                  const box = { top: (from - gridStart) * PX_PER_MIN + 1, height: Math.max(MIN_BLOCK_PX, (to - from) * PX_PER_MIN - 2), ...STRIPES };
                  // A whole day off is named in the All day row; here it only stripes the day, and a click still opens it.
                  if (isWholeDayBlock(b)) return <div key={b.id} aria-hidden onClick={(e) => { e.stopPropagation(); onOpenBlock?.(b); }} title={`${b.label || "Time off"} · ${timeOffBlockTime(b)}`}
                    className="absolute inset-x-0.5 z-[2] cursor-pointer rounded-lg border border-line bg-page hover:border-line-strong" style={box} />;
                  return <button key={b.id} type="button" onClick={(e) => { e.stopPropagation(); onOpenBlock?.(b); }} title={`${b.label || "Time off"} · ${timeOffBlockTime(b)}`}
                    className="absolute inset-x-0.5 z-[2] flex cursor-pointer flex-col justify-start overflow-hidden rounded-lg border border-line bg-page px-2 py-1 text-left hover:border-line-strong" style={box}>
                    <span className="block truncate text-small font-medium text-ink">{b.label || "Time off"}</span>
                    {to - from >= 40 && <span className="tabular block truncate text-label text-ink-2">{timeOffBlockTime(b)}</span>}
                  </button>;
                })}
                {place(dayRows).map(({ a, col, cols }) => (
                  <Block
                    key={a.id}
                    appointment={a}
                    tone={tone(a)}
                    onOpen={onOpen}
                    style={{
                      top: (timeToMin(a.start_time) - gridStart) * PX_PER_MIN + 1,
                      height: Math.max(MIN_BLOCK_PX, a.duration_min * PX_PER_MIN - 2),
                      left: `calc(${(col * 100) / cols}% + 2px)`,
                      width: `calc(${100 / cols}% - 4px)`,
                    }}
                  />
                ))}

                {nowVisible && isSameDay(d, now) && (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-rose"
                    style={{ top: (nowMin - gridStart) * PX_PER_MIN }}
                    aria-hidden
                  >
                    <span className="absolute -left-1 -top-[5px] h-2 w-2 rounded-full bg-rose" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Block({
  appointment: a,
  tone,
  onOpen,
  style,
}: {
  appointment: AppointmentRow;
  tone: Tone;
  onOpen: (a: AppointmentRow) => void;
  style: React.CSSProperties;
}) {
  // Short blocks only have room for one line; tall ones can also name the service.
  const short = a.duration_min < 40;
  const tall = a.duration_min >= 60;
  const sub = quiet(tone);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(a);
      }}
      title={hoverTitle(a)}
      className={cn("absolute z-[3] flex cursor-pointer flex-col justify-start overflow-hidden rounded-lg px-2 py-[3px] text-left transition-colors", toneClass[tone])}
      style={style}
    >
      <span className="flex items-center gap-1 text-small">
        {short && <span className={cn("tabular shrink-0", sub)}>{timeLabel(a.start_time)}</span>}
        <span className={cn("truncate font-medium", tone === "off" && "line-through")}>{title(a)}</span>
        {tone === "pending" && <Clock size={14} className="ml-auto shrink-0 text-ink-2" aria-hidden />}
        {!!a.is_remote && <MapPin size={14} className={cn("shrink-0", tone !== "pending" && "ml-auto", sub)} aria-hidden />}
        {short && a.transaction_id != null && <Check size={14} strokeWidth={3} className={cn("shrink-0", !a.is_remote && "ml-auto", tone === "next" ? "text-accent-ink" : "text-good")} aria-hidden />}
      </span>
      {!short && (
        <span className={cn("flex items-center gap-1 text-label", sub)}>
          {/* What's owed takes the line: where the block sits already says when. */}
          {tone !== "owed" && <span className="tabular shrink-0">{timeLabel(a.start_time)}</span>}
          {tone === "owed" ? <span className="tabular truncate font-medium text-rose-ink">{toCollect(a)}</span>
            : a.transaction_id != null ? <span className={cn("flex min-w-0 items-center gap-0.5 font-medium", tone === "next" ? "text-accent-ink" : "text-good")}>· <Check size={12} strokeWidth={3} className="shrink-0" aria-hidden /><span className="truncate">Paid</span></span>
            : a.price_pence != null && <span className="tabular truncate">· {moneyNeat(a.price_pence)}</span>}
        </span>
      )}
      {tall && <span className={cn("block truncate text-label", sub)}>{service(a)}</span>}
    </button>
  );
}

/** Month view: a line per appointment on a wide screen, a count per day on a phone. */
export function MonthGrid({
  days,
  rows,
  blocks = [],
  hours,
  month,
  compact,
  onOpen,
  onNew,
  onShowDay,
  onOpenBlock,
}: CalendarProps & { month: Date; onShowDay: (d: Date) => void; compact?: boolean }) {
  const now = useBusinessNow();
  const byDay = useMemo(() => groupByDay(rows), [rows]);
  const byBlockDay = useMemo(() => blocksByDay(blocks), [blocks]);
  const tone = useTones(rows);
  const weeks = Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7));

  return (
    <div>
      <div className="flex border-b border-line">
        {days.slice(0, 7).map((d) => (
          <div key={d.toISOString()} className="min-w-0 flex-1 py-2 text-center text-label text-ink-2">
            {format(d, compact ? "EEEEE" : "EEE")}
          </div>
        ))}
      </div>
      {weeks.map((week) => (
        <div key={week[0].toISOString()} className="flex border-b border-line last:border-b-0">
          {week.map((d) => {
            const date = isoDate(d);
            const dayRows = byDay.get(date) ?? [];
            const dayBlocks = byBlockDay.get(date) ?? [];
            const outside = !isSameMonth(d, month);
            const closed = openOn(hours, d) === null;
            const today = isSameDay(d, now);

            if (compact) {
              const booked = dayRows.filter((a) => !offStatus(a)).length;
              const off = dayBlocks.some(isWholeDayBlock);
              return (
                <button
                  key={d.toISOString()}
                  type="button"
                  aria-label={showDay(d)}
                  title={[booked ? `${booked} booked` : "", dayBlocks.length ? "Time off" : "", closed ? "Closed" : ""].filter(Boolean).join(" · ") || undefined}
                  onClick={() => onShowDay(d)}
                  className={cn("flex min-h-16 min-w-0 flex-1 cursor-pointer flex-col items-center gap-0.5 border-l border-line py-1.5 first:border-l-0 hover:bg-surface-2/60", closed && "bg-surface-2/50", off && "bg-page")}
                  style={off ? STRIPES : undefined}
                >
                  <span className={cn("tabular flex h-7 w-7 items-center justify-center rounded-lg text-small font-medium", today ? "bg-accent text-accent-ink" : outside ? "text-ink-2 opacity-60" : "text-ink")}>{format(d, "d")}</span>
                  {booked > 0 && <span className="tabular text-label font-semibold text-rose-ink">{booked}</span>}
                  {booked === 0 && (off || dayBlocks.length > 0) && <span className="text-label text-ink-2">Off</span>}
                </button>
              );
            }

            const shown = dayRows.slice(0, 3);
            return (
              <div
                key={d.toISOString()}
                onClick={() => onNew(date, "09:00")}
                role="presentation"
                className={cn(
                  "min-h-[112px] min-w-0 flex-1 cursor-pointer border-l border-line p-1.5 first:border-l-0 hover:bg-surface-2/60",
                  closed && "bg-surface-2/50",
                )}
              >
                <div className="mb-1 flex items-center justify-between gap-1">
                  <span className="min-w-0 truncate pl-1 text-label text-ink-2">{closed ? "Closed" : ""}</span>
                  <button
                    type="button"
                    aria-label={showDay(d)}
                    onClick={(event) => { event.stopPropagation(); onShowDay(d); }}
                    className={cn(
                      "tabular flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-small font-medium",
                      today ? "bg-accent text-accent-ink" : outside ? "text-ink-2 opacity-60 hover:bg-surface-2" : "text-ink hover:bg-surface-2",
                    )}
                  >
                    {format(d, "d")}
                  </button>
                </div>
                <div className={cn("space-y-0.5", outside && "opacity-70")}>
                  {dayBlocks.map((b) => <button key={b.id} type="button" onClick={(e) => { e.stopPropagation(); onOpenBlock?.(b); }} title={`${b.label || "Time off"} · ${timeOffBlockTime(b)}`}
                    className="block w-full cursor-pointer truncate rounded-lg border border-line bg-page px-1.5 py-0.5 text-left text-label text-ink-2 hover:border-line-strong" style={STRIPES}>
                    {isWholeDayBlock(b) ? "" : <span className="tabular">{timeLabel(b.start_time)} · </span>}<span className="font-medium text-ink">{b.label || "Time off"}</span>
                  </button>)}
                  {shown.map((a) => {
                    const kind = tone(a);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        title={hoverTitle(a)}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(a);
                        }}
                        className={cn("flex w-full cursor-pointer items-center gap-1 rounded-lg px-1.5 py-0.5 text-left text-label transition-colors", toneClass[kind])}
                      >
                        {a.time_confirmed !== 0 && <span className={cn("tabular shrink-0", quiet(kind))}>{timeLabel(a.start_time)}</span>}
                        <span className={cn("min-w-0 flex-1 truncate font-medium", kind === "off" && "line-through")}>{title(a)}</span>
                        {(a.status === "pending" || a.time_confirmed === 0) && <Clock size={12} className={cn("shrink-0", quiet(kind))} aria-hidden />}
                        {a.transaction_id != null && <Check size={12} strokeWidth={3} className={cn("shrink-0", kind === "next" ? "text-accent-ink" : "text-good")} aria-hidden />}
                      </button>
                    );
                  })}
                  {dayRows.length > shown.length && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onShowDay(d);
                      }}
                      className="cursor-pointer px-1.5 text-label font-medium text-ink-2 underline underline-offset-2 hover:text-ink"
                    >
                      {dayRows.length - shown.length} more
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Phone: the week as seven buttons, so any day is one tap away. */
export function WeekStrip({ days, selected, rows, blocks = [], onShowDay }: {
  days: Date[]; selected: Date; rows: AppointmentRow[]; blocks?: CloudBlock[]; onShowDay: (day: Date) => void;
}) {
  const now = useBusinessNow();
  const byDay = useMemo(() => groupByDay(rows), [rows]);
  const byBlockDay = useMemo(() => blocksByDay(blocks), [blocks]);
  return (
    <div className="grid grid-cols-7 gap-1">
      {days.map((d) => {
        const date = isoDate(d);
        const chosen = isSameDay(d, selected);
        const today = isSameDay(d, now);
        const booked = (byDay.get(date) ?? []).filter((a) => !offStatus(a)).length;
        const off = (byBlockDay.get(date) ?? []).length > 0;
        return (
          <button
            key={date}
            type="button"
            aria-label={showDay(d)}
            aria-pressed={chosen}
            aria-current={today ? "date" : undefined}
            title={[booked ? `${booked} booked` : "", off ? "Time off" : ""].filter(Boolean).join(" · ") || undefined}
            onClick={() => onShowDay(d)}
            className={cn(
              "flex min-h-16 min-w-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-xl py-1.5 transition-colors",
              chosen ? "bg-accent text-accent-ink" : today ? "bg-surface-2 text-ink" : "text-ink hover:bg-surface-2/60",
            )}
          >
            <span className={cn("text-label", chosen ? "text-accent-ink/85" : "text-ink-2")}>{format(d, "EEEEE")}</span>
            <span className="tabular text-body font-semibold">{format(d, "d")}</span>
            <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", booked ? chosen ? "bg-accent-ink" : "bg-rose" : off ? "border border-current opacity-60" : "bg-transparent")} />
          </button>
        );
      })}
    </div>
  );
}

type AgendaItem =
  | { kind: "appointment"; start: number; a: AppointmentRow }
  | { kind: "off"; start: number; b: CloudBlock }
  | { kind: "free"; start: number; end: number };

/**
 * Phone: one day as a list in time order. Between bookings, the free stretches of her
 * working day are offered as "Free 10.45am to 1.30pm · Book".
 */
export function DayAgenda({ day, rows, blocks = [], hours, gaps = true, onOpen, onNew, onOpenBlock }: {
  day: Date; rows: AppointmentRow[]; blocks?: CloudBlock[]; hours?: OpeningHours | null; gaps?: boolean;
  onOpen: (a: AppointmentRow) => void; onNew: (date: string, startTime: string) => void; onOpenBlock?: (block: CloudBlock) => void;
}) {
  const now = useBusinessNow();
  const tone = useTones(rows);
  const date = isoDate(day);
  const today = isoDate(now);
  const open = openOn(hours, day);

  const items = useMemo(() => {
    const dayRows = groupByDay(rows.filter((a) => a.date === date)).get(date) ?? [];
    const dayBlocks = blocks.filter((b) => b.date === date);
    const list: AgendaItem[] = [
      ...dayRows.map((a) => ({ kind: "appointment" as const, start: a.time_confirmed === 0 ? -1 : timeToMin(a.start_time), a })),
      ...dayBlocks.map((b) => ({ kind: "off" as const, start: timeToMin(b.start_time), b })),
    ];
    if (gaps && open && date >= today) {
      const busy = [
        ...dayRows.filter((a) => a.time_confirmed !== 0 && !offStatus(a)).map((a) => [timeToMin(a.start_time), endMin(a)] as const),
        ...dayBlocks.map((b) => [timeToMin(b.start_time), timeToMin(b.start_time) + b.duration_min] as const),
      ].sort((x, y) => x[0] - y[0]);
      // Today, what's already gone isn't free: start from the next quarter hour.
      const nowMin = now.getHours() * 60 + now.getMinutes();
      let cursor = date === today ? Math.max(open.open, Math.ceil(nowMin / SNAP_MIN) * SNAP_MIN) : open.open;
      for (const [start, end] of [...busy, [open.close, open.close] as const]) {
        const until = Math.min(start, open.close);
        if (until - cursor >= MIN_FREE_MIN) list.push({ kind: "free", start: cursor, end: until });
        cursor = Math.max(cursor, end);
      }
    }
    const order = { off: 0, appointment: 1, free: 2 };
    return list.sort((x, y) => x.start - y.start || order[x.kind] - order[y.kind]);
    // `now` moves every minute; the list only needs to follow the minute for today.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, blocks, date, gaps, open?.open, open?.close, date === today ? now.getTime() : today]);

  const closedNote = gaps && open === null ? `You don't usually work ${format(day, "EEEE")}s.` : "";
  if (!items.length) return <p className="text-small text-ink-2">{closedNote ? `${closedNote} Nothing booked.` : "Nothing booked."}</p>;

  return (
    <ul className="flex flex-col gap-2">
      {closedNote && <li className="text-small text-ink-2">{closedNote}</li>}
      {items.map((item) => {
        if (item.kind === "free") return (
          <li key={`free-${item.start}`}>
            <button type="button" onClick={() => onNew(date, minToTime(item.start))}
              className="flex min-h-11 w-full min-w-0 cursor-pointer flex-wrap items-center justify-between gap-x-3 rounded-xl border border-dashed border-line-strong px-4 py-2 text-left text-small text-ink-2 hover:bg-surface-2/60">
              <span className="tabular">Free {timeLabel(minToTime(item.start))} to {timeLabel(minToTime(item.end))}</span>
              <span className="flex shrink-0 items-center gap-1 font-medium text-ink"><Plus size={16} aria-hidden /> Book</span>
            </button>
          </li>
        );
        if (item.kind === "off") {
          const whole = isWholeDayBlock(item.b);
          return (
            <li key={`off-${item.b.id}`}>
              <button type="button" onClick={() => onOpenBlock?.(item.b)}
                className="flex w-full min-w-0 cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left hover:border-line-strong" style={STRIPES}>
                <span className="tabular w-[4.5rem] shrink-0 text-small font-semibold">{whole ? "All day" : timeLabel(item.b.start_time)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-medium">{item.b.label || "Time off"}</span>
                  <span className="block text-small text-ink-2">Time off{whole ? "" : ` · ${timeOffBlockTime(item.b)}`}</span>
                </span>
              </button>
            </li>
          );
        }
        const a = item.a;
        const kind = tone(a);
        const sub = quiet(kind);
        return (
          <li key={a.id}>
            <button type="button" onClick={() => onOpen(a)} title={hoverTitle(a)}
              className={cn("flex w-full min-w-0 cursor-pointer items-start gap-3 rounded-xl px-4 py-3 text-left transition-colors", toneClass[kind])}>
              <span className="w-[4.5rem] shrink-0">
                <span className="tabular block text-small font-semibold">{a.time_confirmed === 0 ? "To agree" : timeLabel(a.start_time)}</span>
                <span className={cn("tabular block text-label", sub)}>{durationLabel(a.duration_min)}</span>
              </span>
              <span className="min-w-0 flex-1">
                {kind === "next" && <span className={cn("block text-label font-medium", sub)}>Next up</span>}
                <span className={cn("block break-words font-medium", kind === "off" && "line-through")}>{title(a)}</span>
                <span className={cn("block break-words text-small", sub)}>
                  {service(a)}{a.price_pence != null && kind !== "owed" && <> · <span className="tabular">{moneyNeat(a.price_pence)}</span></>}{!!a.is_remote && " · home visit"}
                </span>
                {kind === "owed" && <span className="block text-small font-medium text-rose-ink">{toCollect(a)}</span>}
                {kind === "off" && <span className="block text-small">{statusNote(a.status)}</span>}
                {kind === "pending" && <span className="block text-small text-ink-2">Booking request</span>}
                {a.time_confirmed === 0 && kind !== "off" && <span className={cn("flex items-center gap-1 text-small", sub)}><Clock size={14} className="shrink-0" aria-hidden /> Time to confirm</span>}
                {a.transaction_id != null && kind !== "off" && <span className={cn("flex items-center gap-1 text-small font-medium", kind === "next" ? "text-accent-ink" : "text-good")}><Check size={14} strokeWidth={3} className="shrink-0" aria-hidden /> Paid</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Phone: the week as seven short lists, one under another, so nothing scrolls sideways. */
export function WeekList({ days, rows, blocks = [], hours, onOpen, onNew, onShowDay, onOpenBlock }: CalendarProps) {
  const now = useBusinessNow();
  return (
    <div className="flex flex-col gap-5">
      {days.map((d) => (
        <section key={d.toISOString()} aria-label={format(d, "EEEE d MMMM")}>
          <div className="mb-1 flex items-center justify-between gap-3">
            <button type="button" aria-label={showDay(d)} onClick={() => onShowDay?.(d)}
              className="btn-sm -ml-1 flex h-9 min-w-0 cursor-pointer items-center gap-2 rounded-lg px-1 text-body font-semibold hover:bg-surface-2">
              {format(d, "EEE d MMM")}
              {isSameDay(d, now) && <span className="text-label font-medium text-rose-ink">Today</span>}
            </button>
            {openOn(hours, d) === null && <span className="text-small text-ink-2">Closed</span>}
          </div>
          <DayAgenda day={d} rows={rows} blocks={blocks} hours={hours} gaps={false} onOpen={onOpen} onNew={onNew} onOpenBlock={onOpenBlock} />
        </section>
      ))}
    </div>
  );
}
