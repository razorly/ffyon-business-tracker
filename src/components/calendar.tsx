import { useMemo } from "react";
import { format, isSameDay, isSameMonth } from "date-fns";
import { Check, Clock, MapPin } from "lucide-react";
import type { AppointmentRow } from "@/lib/db";
import type { CloudBlock } from "@/lib/sync";
import { isoDate, minToTime, money, moneyNeat, timeLabel, timeToMin } from "@/lib/format";
import { themedColour, tint } from "@/lib/palette";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useBusinessNow } from "@/lib/dates";

const HOUR_PX = 56;
const PX_PER_MIN = HOUR_PX / 60;
const SNAP_MIN = 15;
/** The hours always shown, even on an empty day. Earlier or later bookings widen it. */
const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 20;
const FALLBACK_COLOUR = "#a88a7d";

export interface CalendarProps {
  days: Date[];
  rows: AppointmentRow[];
  blocks?: CloudBlock[];
  onOpen: (a: AppointmentRow) => void;
  /** Clicking an empty slot books a new appointment there. */
  onNew: (date: string, startTime: string) => void;
  onShowDay?: (day: Date) => void;
}

const endMin = (a: AppointmentRow) => timeToMin(a.start_time) + a.duration_min;

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

/** Day and week view: hours down the side, appointments as blocks. */
export function TimeGrid({ days, rows, blocks = [], onOpen, onNew, onShowDay }: CalendarProps) {
  const now = useBusinessNow();
  const byDay = useMemo(() => groupByDay(rows), [rows]);
  const byBlockDay = useMemo(() => blocksByDay(blocks), [blocks]);

  const [startHour, endHour] = useMemo(() => {
    let from = DEFAULT_START_HOUR;
    let to = DEFAULT_END_HOUR;
    for (const a of rows) {
      if (a.time_confirmed === 0) continue;
      from = Math.min(from, Math.floor(timeToMin(a.start_time) / 60));
      to = Math.max(to, Math.ceil(endMin(a) / 60));
    }
    for (const b of blocks.filter((block) => days.some((day) => isoDate(day) === block.date))) {
      from = Math.min(from, Math.floor(timeToMin(b.start_time) / 60));
      to = Math.max(to, Math.ceil((timeToMin(b.start_time) + b.duration_min) / 60));
    }
    return [from, Math.min(24, Math.max(to, from + 1))];
  }, [rows, blocks, days]);

  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const gridStart = startHour * 60;
  const height = (endHour - startHour) * HOUR_PX;
  const hasUntimed = rows.some((appointment) => appointment.time_confirmed === 0);

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowVisible = nowMin >= gridStart && nowMin <= endHour * 60;

  return (
    <div>
      <div className="flex pl-14">
        {days.map((d) => (
          <div key={d.toISOString()} className="min-w-0 flex-1 border-l border-line px-1 pb-2 text-center">
            <div className="eyebrow text-[10px] text-muted">{format(d, "EEE")}</div>
            <button
              type="button"
              onClick={() => onShowDay?.(d)}
              aria-label={`Show ${format(d, "EEEE d MMMM yyyy")}`}
              className={cn(
                "mx-auto mt-0.5 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full font-display text-[17px] hover:bg-accent-soft",
                isSameDay(d, now) ? "bg-accent text-accent-ink" : "text-ink",
              )}
            >
              {format(d, "d")}
            </button>
          </div>
        ))}
      </div>

      {hasUntimed && <div className="relative flex border-t border-line bg-surface-2/40 pl-14" aria-label="All-day appointments awaiting a time">
        <span className="absolute left-0 top-3 w-12 text-right text-[10px] text-muted">All day</span>
        {days.map((day) => <div key={day.toISOString()} className="min-w-0 flex-1 space-y-1 border-l border-line px-1 py-2">
          {(byDay.get(isoDate(day)) ?? []).filter((appointment) => appointment.time_confirmed === 0).map((appointment) => <button key={appointment.id} type="button" onClick={() => onOpen(appointment)} title={`${title(appointment)} · Time to confirm · ${statusNote(appointment.status)}`} className={cn("w-full min-w-0 rounded-md border border-dashed border-line bg-surface px-2 py-1.5 text-left text-[11px] hover:bg-accent-soft cursor-pointer", offStatus(appointment) && "opacity-60")}>
            <span className="flex items-center gap-1 font-medium"><Clock size={11} className="shrink-0" /><span className="truncate">{title(appointment)}</span>{!!appointment.is_remote && <MapPin size={11} className="ml-auto shrink-0" />}</span>
            <span className="mt-0.5 block text-[10px] text-muted">Time to confirm</span>
          </button>)}
        </div>)}
      </div>}

      {/* Hour labels and hour lines share the same offsets, so they can't drift apart. */}
      <div className="relative border-t border-line" style={{ height }}>
        {hours.map((h, i) => (
          <div key={h} className="pointer-events-none absolute inset-x-0" style={{ top: i * HOUR_PX }} aria-hidden>
            <span className="absolute -top-[7px] left-0 w-12 text-right text-[11px] tabular text-muted">
              {timeLabel(minToTime(h * 60))}
            </span>
            {i > 0 && <div className="ml-14 border-t border-line/70" />}
          </div>
        ))}

        <div className="flex h-full pl-14">
          {days.map((d) => {
            const dayRows = (byDay.get(isoDate(d)) ?? []).filter((appointment) => appointment.time_confirmed !== 0);
            return (
              <div
                key={d.toISOString()}
                className="relative min-w-0 flex-1 border-l border-line"
                onClick={(e) => {
                  const box = e.currentTarget.getBoundingClientRect();
                  const min = gridStart + (e.clientY - box.top) / PX_PER_MIN;
                  onNew(isoDate(d), minToTime(Math.floor(min / SNAP_MIN) * SNAP_MIN));
                }}
                role="presentation"
              >
                {(byBlockDay.get(isoDate(d)) ?? []).map((b) => <div key={b.id} onClick={(e) => e.stopPropagation()} title={`${b.label || "Time off"} · ${timeLabel(b.start_time)}`} className="absolute inset-x-0 z-[1] overflow-hidden border-y border-line bg-surface-2 px-2 py-1 text-[11px] text-muted" style={{ top: (timeToMin(b.start_time) - gridStart) * PX_PER_MIN, height: Math.max(22, b.duration_min * PX_PER_MIN - 2), backgroundImage: "repeating-linear-gradient(135deg, transparent 0, transparent 5px, var(--border) 5px, var(--border) 6px)" }}>{b.label || "Time off"}</div>)}
                {place(dayRows).map(({ a, col, cols }) => (
                  <Block
                    key={a.id}
                    appointment={a}
                    onOpen={onOpen}
                    style={{
                      top: (timeToMin(a.start_time) - gridStart) * PX_PER_MIN,
                      height: Math.max(22, a.duration_min * PX_PER_MIN - 2),
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
  onOpen,
  style,
}: {
  appointment: AppointmentRow;
  onOpen: (a: AppointmentRow) => void;
  style: React.CSSProperties;
}) {
  const { dark } = useTheme();
  const colour = themedColour(a.category_colour ?? FALLBACK_COLOUR, dark);
  const paid = a.transaction_id != null;
  // Cancelled and no-shows stay in the diary as a record, faded and struck through.
  const off = offStatus(a);
  // Short blocks only have room for one line; tall ones can also name the service.
  const short = a.duration_min < 40;
  const tall = a.duration_min >= 60;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(a);
      }}
      title={`${timeLabel(a.start_time)} · ${title(a)}${a.price_pence != null ? ` · ${money(a.price_pence)}` : ""} · ${statusNote(a.status)}${paid ? " · paid" : ""}${a.is_remote ? " · home visit" : ""}`}
      className={cn(
        "absolute z-[1] overflow-hidden rounded-lg border-l-[3px] px-2 py-1 text-left leading-tight cursor-pointer",
        "transition-[filter] hover:brightness-[0.97] dark:hover:brightness-110",
        "border-y border-r",
        a.status === "pending" && "border-dashed",
        off && "opacity-65",
      )}
      style={{
        ...style,
        borderColor: tint(colour, off ? 0.3 : paid ? 0.45 : 0.55),
        borderLeftColor: off ? tint(colour, 0.5) : colour,
        background: tint(colour, off ? 0.05 : paid ? (dark ? 0.3 : 0.2) : dark ? 0.14 : 0.09),
      }}
    >
      <span className="flex items-center gap-1 text-[11.5px] text-ink">
        {short && <span className="tabular shrink-0 text-ink-2">{timeLabel(a.start_time)}</span>}
        <span className={cn("truncate font-medium", off && "line-through")}>{title(a)}</span>
        {a.status === "pending" && <Clock size={11} className="ml-auto shrink-0 text-muted" />}
        {!!a.is_remote && <MapPin size={11} className="shrink-0 text-muted" />}
        {paid && <Check size={11} strokeWidth={3} className="ml-auto shrink-0 text-good" />}
      </span>
      {!short && (
        <span className="mt-0.5 block truncate text-[11px] text-muted">
          <span className="tabular">{timeLabel(a.start_time)}</span>
          {a.price_pence != null && <> · {moneyNeat(a.price_pence)}</>}
        </span>
      )}
      {tall && <span className="mt-0.5 block truncate text-[11px] text-muted">{a.service_name || a.category_name || "Appointment"}</span>}
    </button>
  );
}

const title = (a: AppointmentRow) => a.client_name || a.service_name || a.category_name || "Appointment";

const offStatus = (a: AppointmentRow) => a.status === "cancelled" || a.status === "no_show" || a.status === "rejected";

const statusNote = (status: AppointmentRow["status"]) =>
  status === "pending" ? "Awaiting approval" : status === "confirmed" ? "Confirmed" : status === "cancelled" ? "Cancelled" : status === "no_show" ? "Didn't show" : "Rejected";

/** Month view: a chip per appointment, the way Outlook's month grid reads. */
export function MonthGrid({
  days,
  rows,
  blocks = [],
  month,
  onOpen,
  onNew,
  onShowDay,
}: CalendarProps & { month: Date; onShowDay: (d: Date) => void }) {
  const { dark } = useTheme();
  const now = useBusinessNow();
  const byDay = useMemo(() => groupByDay(rows), [rows]);
  const byBlockDay = useMemo(() => blocksByDay(blocks), [blocks]);
  const weeks = Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7));

  return (
    <div>
      <div className="flex border-b border-line">
        {days.slice(0, 7).map((d) => (
          <div key={d.toISOString()} className="eyebrow flex-1 py-2 text-center text-[10px] text-muted">
            {format(d, "EEE")}
          </div>
        ))}
      </div>
      {weeks.map((week) => (
        <div key={week[0].toISOString()} className="flex border-b border-line last:border-b-0">
          {week.map((d) => {
            const dayRows = byDay.get(isoDate(d)) ?? [];
            const shown = dayRows.slice(0, 3);
            const outside = !isSameMonth(d, month);
            return (
              <div
                key={d.toISOString()}
                onClick={() => onNew(isoDate(d), "09:00")}
                role="presentation"
                className={cn(
                  "min-h-[104px] min-w-0 flex-1 border-l border-line p-1.5 first:border-l-0 cursor-pointer hover:bg-surface-2/40",
                  outside && "bg-surface-2/25",
                )}
              >
                <button
                  type="button"
                  aria-label={`Show ${format(d, "EEEE d MMMM yyyy")}`}
                  onClick={(event) => { event.stopPropagation(); onShowDay(d); }}
                  className={cn(
                    "mb-1 ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded-full font-display text-[15px] hover:bg-accent-soft",
                    isSameDay(d, now) ? "bg-accent text-accent-ink" : outside ? "text-muted" : "text-ink",
                  )}
                >
                  {format(d, "d")}
                </button>
                <div className="space-y-0.5">
                  {(byBlockDay.get(isoDate(d)) ?? []).map((b) => <div key={b.id} className="truncate rounded-md border border-dashed border-line px-1.5 py-0.5 text-[11px] text-muted" onClick={(e) => e.stopPropagation()} title={`${b.label || "Time off"} · ${timeLabel(b.start_time)}`}>{timeLabel(b.start_time)} · {b.label || "Time off"}</div>)}
                  {shown.map((a) => {
                    const colour = themedColour(a.category_colour ?? FALLBACK_COLOUR, dark);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        title={`${title(a)} · ${a.time_confirmed === 0 ? "Time to confirm · " : ""}${statusNote(a.status)}${a.transaction_id != null ? " · paid" : ""}${a.is_remote ? " · home visit" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(a);
                        }}
                        className="flex w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md px-1.5 py-[3px] text-left text-[11.5px] cursor-pointer hover:brightness-[0.97] dark:hover:brightness-110"
                        style={{ background: tint(colour, dark ? 0.2 : 0.12) }}
                      >
                        {/* filled dot = paid, hollow = still to be paid */}
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={
                            a.transaction_id != null
                              ? { background: colour }
                              : { boxShadow: `inset 0 0 0 1.5px ${colour}` }
                          }
                        />
                        {a.time_confirmed !== 0 && <span className="tabular shrink-0 text-muted">{timeLabel(a.start_time)}</span>}
                        <span className={cn("min-w-0 flex-1 truncate text-ink", offStatus(a) && "line-through opacity-65")}>
                          {title(a)}
                        </span>
                        {(a.status === "pending" || a.time_confirmed === 0) && <Clock size={10} className="ml-auto shrink-0 text-muted" />}
                        {a.time_confirmed === 0 && <span className="basis-full text-[10px] text-muted">Time to confirm</span>}
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
                      className="px-1.5 text-[11px] text-ink-2 underline decoration-rose underline-offset-2 cursor-pointer hover:text-ink"
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
