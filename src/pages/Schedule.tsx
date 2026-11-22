import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  addDays,
  addMonths,
  addWeeks,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  parseISO,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { BanknoteArrowDown, CalendarOff, ChevronLeft, ChevronRight, Clock, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { isOwed, listAppointments } from "@/lib/db";
import { useData, useLoad } from "@/lib/data";
import { useInbox } from "@/lib/inbox";
import { listBlocks, listCloudSettings, type CloudBlock } from "@/lib/sync";
import { timeOffPeriods } from "@/lib/time-off";
import { useAccess } from "@/components/AccessGate";
import { isoDate, money, shortDate } from "@/lib/format";
import { useBusinessNow } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/Layout";
import { Button, Card, Input, LoadError, Segmented } from "@/components/ui";
import { DayAgenda, MonthGrid, TimeGrid, WeekList, WeekStrip } from "@/components/calendar";
import { TimeOffDetails, TimeOffDialog } from "@/components/TimeOff";
import { toast } from "sonner";

type View = "day" | "week" | "month";

const WEEK = { weekStartsOn: 1 } as const; // weeks run Monday to Sunday
/** Below this width the hour grid can't be read: the diary becomes lists instead. */
const COMPACT_BELOW_PX = 600;
const PHONE = "(max-width: 639px)";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The Diary: her appointments by day, week or month, and the time she's taken off. */
export function Schedule() {
  const access = useAccess();
  const online = access.state === "online";
  const { openNewAppointment, openEditAppointment, refresh } = useData();
  const now = useBusinessNow();
  const today = isoDate(now);
  const [view, setView] = useState<View>(() => window.matchMedia(PHONE).matches ? "day" : "week");
  const [anchor, setAnchor] = useState(() => now);
  const [page, compact] = useCompact();

  const period = useMemo(() => periodFor(view, anchor, now.getFullYear()), [view, anchor, now]);
  const [rows, loading, loadError] = useLoad(() => listAppointments({ from: period.from, to: period.to }), [period.from, period.to], []);
  const [blocks, , blocksError] = useLoad(listBlocks, [], []);
  // Her opening hours decide which hours the grid shows and which days read as closed.
  const [settings] = useLoad(listCloudSettings, [], null);
  const hours = settings?.opening_hours ?? null;

  // In month view the grid spills into neighbouring months — the totals stay on the month itself.
  const counted = rows.filter(
    (r) => r.date >= period.countFrom && r.date <= period.countTo && r.status === "confirmed",
  );
  const paid = rows.filter((r) => r.date >= period.countFrom && r.date <= period.countTo && r.transaction_id != null)
    .reduce((s, r) => s + (r.paid_amount_pence ?? 0), 0);
  const owed = counted.filter(isOwed).reduce((s, r) => s + (r.price_pence ?? 0), 0);
  const untimed = counted.filter((appointment) => appointment.time_confirmed === 0);

  // Finished bookings waiting for payment are handled in one place: Today.
  const { payments } = useInbox();
  const waiting = payments.reduce((sum, row) => sum + (row.price_pence ?? 0), 0);

  const showsToday = today >= period.countFrom && today <= period.countTo;
  const unavailable = rows.length === 0 && (loading || Boolean(loadError));
  const summary = unavailable ? loadError ? "Unavailable" : "…"
    : [counted.length ? plural(counted.length, "appointment") : "No appointments", paid > 0 && `${money(paid)} paid`, owed > 0 && `${money(owed)} to collect`].filter(Boolean).join(" · ");

  const openNew = (date: string, start_time: string) => {
    if (!online) return toast.info("Reconnect to create a shared booking");
    openNewAppointment({ date, start_time, fromSchedule: true });
  };
  const showDay = (day: Date) => { setAnchor(day); setView("day"); };

  const step = (dir: 1 | -1) =>
    setAnchor((d) => (view === "day" ? addDays(d, dir) : view === "week" ? addWeeks(d, dir) : addMonths(d, dir)));

  const [addingTimeOff, setAddingTimeOff] = useState(false);
  const [openBlock, setOpenBlock] = useState<string | null>(null);
  const openPeriod = useMemo(() => openBlock ? timeOffPeriods(blocks).find((item) => item.blocks.some((block) => block.id === openBlock)) ?? null : null, [blocks, openBlock]);
  const showBlock = (block: CloudBlock) => setOpenBlock(block.id);

  return (
    <div ref={page}>
      {/* On a phone the summary sits just above the day's list, so the title and its two buttons share one row. */}
      <PageHeader title="Diary" subtitle={compact ? undefined : `${period.label} · ${summary}`}>
        <Button onClick={() => setAddingTimeOff(true)}>
          <CalendarOff size={16} aria-hidden /> Time off
        </Button>
        <Button variant="primary" disabled={!online} onClick={() => openNew(isoDate(showsToday ? now : anchor), "09:00")}>
          <Plus size={16} aria-hidden /> Book
        </Button>
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className={cn("flex items-center gap-1", compact && "flex-1")}>
          <Button size="icon" onClick={() => step(-1)} aria-label={`Previous ${view}`} title={`Previous ${view}`}>
            <ChevronLeft size={18} aria-hidden />
          </Button>
          <Button className={cn("px-3", compact && "flex-1")} disabled={showsToday} onClick={() => setAnchor(now)}>
            {view === "day" ? "Today" : view === "week" ? "This week" : "This month"}
          </Button>
          <Button size="icon" onClick={() => step(1)} aria-label={`Next ${view}`} title={`Next ${view}`}>
            <ChevronRight size={18} aria-hidden />
          </Button>
        </div>
        <Input type="date" aria-label="Go to date" title="Go to date" className={cn("px-3 text-small", compact ? "min-w-32 flex-1" : "w-40")}
          value={isoDate(anchor)} onChange={(event) => { if (event.target.value) setAnchor(parseISO(event.target.value)); }} />
        <Segmented
          label="View"
          className={compact ? "w-full" : "ml-auto"}
          value={view}
          onChange={setView}
          options={[
            { value: "day", label: "Day" },
            { value: "week", label: "Week" },
            { value: "month", label: "Month" },
          ]}
        />
      </div>

      <LoadError error={loadError || blocksError} onRetry={refresh} />
      {loading && rows.length === 0 && <p role="status" className="mb-3 text-small text-ink-2">Loading diary…</p>}

      {payments.length > 0 && <Link to="/" className="mb-4 flex min-h-11 items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 hover:bg-surface-2/60">
        <BanknoteArrowDown size={20} className="shrink-0 text-rose-ink" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className={cn("block", compact && "text-small")}><span className="font-semibold">{plural(payments.length, "finished appointment")}</span> waiting for payment{waiting ? <> · <span className="tabular">{money(waiting)}</span></> : ""}</span>
          {!compact && <span className="block text-small text-ink-2">Mark them paid on Today</span>}
        </span>
        <ChevronRight size={16} className="shrink-0 text-ink-2" aria-hidden />
      </Link>}

      {untimed.length > 0 && <section className="mb-4 rounded-xl border border-line bg-surface px-4 py-3" aria-label="Appointments needing a confirmed time">
        <p className="flex items-center gap-2 text-small font-medium"><Clock size={16} className="shrink-0 text-ink-2" aria-hidden /> Time to confirm ({untimed.length})</p>
        <div className="mt-2 flex flex-wrap gap-2">{untimed.map((appointment) => <Button key={appointment.id} size="sm" className="max-w-full" onClick={() => openEditAppointment(appointment)} title={`Confirm time for ${appointment.client_name || "appointment"}`}><span className="min-w-0 truncate">{shortDate(appointment.date)} · {appointment.client_name || appointment.service_name || "Appointment"}</span></Button>)}</div>
      </section>}

      {compact && <p className="mb-3 text-small text-ink-2"><span className="font-semibold text-ink">{period.label}</span> · {summary}</p>}

      {compact ? (
        view === "day" ? (
          <div className="flex flex-col gap-4">
            <WeekStrip days={period.week} selected={anchor} rows={rows} blocks={blocks} onShowDay={setAnchor} />
            <DayAgenda day={anchor} rows={rows} blocks={blocks} hours={hours} onOpen={openEditAppointment} onNew={openNew} onOpenBlock={showBlock} />
          </div>
        ) : view === "week" ? (
          <WeekList days={period.days} rows={rows} blocks={blocks} hours={hours} onOpen={openEditAppointment} onNew={openNew} onShowDay={showDay} onOpenBlock={showBlock} />
        ) : (
          <Card className="overflow-hidden">
            <MonthGrid compact month={anchor} days={period.days} rows={rows} blocks={blocks} hours={hours} onOpen={openEditAppointment} onNew={openNew} onShowDay={showDay} onOpenBlock={showBlock} />
          </Card>
        )
      ) : (
        <Card className="overflow-hidden">
          {view === "month" ? (
            <MonthGrid month={anchor} days={period.days} rows={rows} blocks={blocks} hours={hours} onOpen={openEditAppointment} onNew={openNew} onShowDay={showDay} onOpenBlock={showBlock} />
          ) : (
            <div className="py-3 pr-3">
              <TimeGrid days={period.days} rows={rows} blocks={blocks} hours={hours} onOpen={openEditAppointment} onNew={openNew} onShowDay={showDay} onOpenBlock={showBlock} />
            </div>
          )}
        </Card>
      )}

      {addingTimeOff && <TimeOffDialog online={online} initialDate={isoDate(showsToday ? now : anchor)} onClose={() => setAddingTimeOff(false)} onSaved={() => { setAddingTimeOff(false); refresh(); }} />}
      {openPeriod && <TimeOffDetails period={openPeriod} online={online} onClose={() => setOpenBlock(null)} onChanged={refresh} />}
    </div>
  );
}

/** True while the page is too narrow for an hour grid: a phone, or a slim window beside the menu. */
function useCompact() {
  const ref = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(() => window.matchMedia(PHONE).matches);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setCompact(element.clientWidth < COMPACT_BELOW_PX);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, compact] as const;
}

/** The days on screen, the dates to load, and the dates the totals cover. */
function periodFor(view: View, anchor: Date, thisYear: number) {
  // The year is only said when it isn't this one.
  const year = (d: Date) => d.getFullYear() === thisYear ? "" : ` ${d.getFullYear()}`;
  const start = startOfWeek(anchor, WEEK);
  const end = endOfWeek(anchor, WEEK);
  const week = eachDayOfInterval({ start, end });

  if (view === "day") {
    const day = isoDate(anchor);
    // The whole week is loaded so the week strip can show which days have bookings.
    return {
      days: [anchor],
      week,
      from: isoDate(start),
      to: isoDate(end),
      countFrom: day,
      countTo: day,
      label: `${format(anchor, "EEEE d MMMM")}${year(anchor)}`,
    };
  }

  if (view === "week") {
    return {
      days: week,
      week,
      from: isoDate(start),
      to: isoDate(end),
      countFrom: isoDate(start),
      countTo: isoDate(end),
      label: `${format(start, isSameMonth(start, end) ? "d" : "d MMMM")} to ${format(end, "d MMMM")}${year(end)}`,
    };
  }

  const monthStart = startOfMonth(anchor);
  const monthEnd = endOfMonth(anchor);
  const gridStart = startOfWeek(monthStart, WEEK);
  const gridEnd = endOfWeek(monthEnd, WEEK);
  return {
    days: eachDayOfInterval({ start: gridStart, end: gridEnd }),
    week,
    from: isoDate(gridStart),
    to: isoDate(gridEnd),
    countFrom: isoDate(monthStart),
    countTo: isoDate(monthEnd),
    label: format(anchor, "MMMM yyyy"),
  };
}
