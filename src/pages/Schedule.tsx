import { useMemo, useState } from "react";
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
import { BanknoteArrowDown, ChevronLeft, ChevronRight, Clock, Plus } from "lucide-react";
import { isOwed, listAppointments, markAppointmentPaid, unpaidBefore, type AppointmentRow } from "@/lib/db";
import { useData, useLoad } from "@/lib/data";
import { listBlocks } from "@/lib/sync";
import { useAccess } from "@/components/AccessGate";
import { isoDate, money, shortDate, timeLabel } from "@/lib/format";
import { useBusinessNow } from "@/lib/dates";
import { PageHeader } from "@/components/Layout";
import { Button, Card, CardHeader, Input, LoadError, Segmented, Stat } from "@/components/ui";
import { MonthGrid, TimeGrid } from "@/components/calendar";
import { toast } from "sonner";

type View = "day" | "week" | "month";

const WEEK = { weekStartsOn: 1 } as const; // weeks run Monday to Sunday

export function Schedule() {
  const access = useAccess();
  const { openNewAppointment, openEditAppointment, refresh } = useData();
  const now = useBusinessNow();
  const today = isoDate(now);
  const [view, setView] = useState<View>(() => window.matchMedia("(max-width: 639px)").matches ? "day" : "week");
  const [anchor, setAnchor] = useState(() => now);

  const period = useMemo(() => periodFor(view, anchor), [view, anchor]);
  const [rows, loading, loadError] = useLoad(() => listAppointments({ from: period.from, to: period.to }), [period.from, period.to], []);
  const [blocks, , blocksError] = useLoad(listBlocks, [], []);

  // In month view the grid spills into neighbouring months — the totals stay on the month itself.
  const counted = rows.filter(
    (r) => r.date >= period.countFrom && r.date <= period.countTo && r.status === "confirmed",
  );
  const paid = rows.filter((r) => r.date >= period.countFrom && r.date <= period.countTo && r.transaction_id != null)
    .reduce((s, r) => s + (r.paid_amount_pence ?? 0), 0);
  const owed = counted.filter(isOwed).reduce((s, r) => s + (r.price_pence ?? 0), 0);
  const untimed = counted.filter((appointment) => appointment.time_confirmed === 0);

  // Past bookings never marked paid. Not tied to the week on screen — it's a standing to-do list.
  const [overdueRows, , overdueError] = useLoad(() => unpaidBefore(today), [today], []);
  const overdue = overdueRows.filter((appointment) => appointment.price_pence !== 0);

  const showsToday = today >= period.countFrom && today <= period.countTo;
  const unavailable = rows.length === 0 && (loading || Boolean(loadError));
  const placeholder = loadError ? "Unavailable" : "…";
  const openNew = (date: string, start_time: string) => {
    if (access.state !== "online") return toast.info("Reconnect to create a shared booking");
    openNewAppointment({ date, start_time });
  };

  const step = (dir: 1 | -1) =>
    setAnchor((d) => (view === "day" ? addDays(d, dir) : view === "week" ? addWeeks(d, dir) : addMonths(d, dir)));

  return (
    <>
      <PageHeader title="Schedule" subtitle="Your diary — appointments only count as money once they're paid">
        <div className="flex items-center gap-1 rounded-full border border-line bg-surface p-1">
          <Button variant="ghost" size="icon" onClick={() => step(-1)} aria-label={`Previous ${view}`}>
            <ChevronLeft size={16} />
          </Button>
          <span className="min-w-0 px-1 text-center font-display text-[16px] sm:min-w-[200px] sm:px-2 sm:text-[18px]">{period.label}</span>
          <Button variant="ghost" size="icon" onClick={() => step(1)} aria-label={`Next ${view}`}>
            <ChevronRight size={16} />
          </Button>
        </div>
        <Input type="date" aria-label="Go to date" title="Go to date" className="w-36" value={isoDate(anchor)} onChange={(event) => { if (event.target.value) setAnchor(parseISO(event.target.value)); }} />
        {!showsToday && <Button onClick={() => setAnchor(now)}>Today</Button>}
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: "day", label: "Day" },
            { value: "week", label: "Week" },
            { value: "month", label: "Month" },
          ]}
        />
        <Button variant="primary" disabled={access.state !== "online"} onClick={() => openNew(isoDate(showsToday ? now : anchor), "09:00")}>
          <Plus size={15} /> Book
        </Button>
      </PageHeader>

      <LoadError error={loadError || blocksError || overdueError} onRetry={refresh} />
      {loading && <p role="status" className="mb-3 text-sm text-muted">Loading schedule…</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <Stat label="Confirmed appointments" value={unavailable ? placeholder : String(counted.length)} />
        <Stat label="Paid" value={unavailable ? placeholder : money(paid)} tone="good" hint="Counted in your money" />
        <Stat label="Still to collect" value={unavailable ? placeholder : money(owed)} hint="Not in your money until you mark it paid" />
      </div>

      {untimed.length > 0 && <section className="mt-4 border-l-2 border-accent pl-3" aria-label="Appointments needing a confirmed time">
        <p className="flex items-center gap-2 text-sm font-medium"><Clock size={15} /> Time to confirm ({untimed.length})</p>
        <div className="mt-2 flex flex-wrap gap-2">{untimed.map((appointment) => <Button key={appointment.id} size="sm" className="max-w-full" onClick={() => openEditAppointment(appointment)} title={`Confirm time for ${appointment.client_name || "appointment"}`}><Clock size={12} className="shrink-0" /><span className="min-w-0 truncate">{shortDate(appointment.date)} · {appointment.client_name || appointment.service_name || "Appointment"}</span></Button>)}</div>
      </section>}

      <Card className="mt-4 max-w-full overflow-x-auto">
        {view === "month" ? (
          <div className="min-w-[640px]"><MonthGrid
            month={anchor}
            days={period.days}
            rows={rows}
            blocks={blocks}
            onOpen={openEditAppointment}
            onNew={openNew}
            onShowDay={(d) => {
              setAnchor(d);
              setView("day");
            }}
          /></div>
        ) : (
          <div className={view === "week" ? "min-w-[640px] py-3 pr-3" : "py-3 pr-3"}>
            <TimeGrid days={period.days} rows={rows} blocks={blocks} onOpen={openEditAppointment} onNew={openNew} onShowDay={(day) => { setAnchor(day); setView("day"); }} />
          </div>
        )}
      </Card>

      {overdue.length > 0 && <OwedCard rows={overdue} onOpen={openEditAppointment} onPaid={refresh} />}
    </>
  );
}

/** Appointments that have been and gone without being marked paid. */
function OwedCard({
  rows,
  onOpen,
  onPaid,
}: {
  rows: AppointmentRow[];
  onOpen: (a: AppointmentRow) => void;
  onPaid: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const total = rows.reduce((s, r) => s + (r.price_pence ?? 0), 0);
  return (
    <Card className="mt-4">
      <CardHeader
        title="Money you're owed"
        subtitle={`${rows.length} past appointment${rows.length === 1 ? "" : "s"} you haven't marked paid`}
        action={<span className="font-display text-[22px] leading-none">{money(total)}</span>}
      />
      <ul className="divide-y divide-line">
        {rows.map((a) => (
          <li key={a.id} className="flex items-center gap-3 px-5 py-2.5">
            <button
              onClick={() => onOpen(a)}
              className="min-w-0 flex-1 text-left text-[13.5px] cursor-pointer hover:underline decoration-rose underline-offset-4"
            >
              <span className="font-medium">{a.client_name || a.service_name || a.category_name || "Appointment"}</span>
              <span className="block text-[12px] text-muted">
                {shortDate(a.date)} · {a.time_confirmed === 0 ? "Time to confirm" : timeLabel(a.start_time)}
                {a.client_name && (a.service_name || a.category_name) ? ` · ${a.service_name || a.category_name}` : ""}
              </span>
            </button>
            <span className="tabular text-[13.5px] font-semibold">
              {a.price_pence != null ? money(a.price_pence) : <span className="text-muted">No price</span>}
            </span>
            {a.price_pence != null ? (
              <Button
                size="sm"
                disabled={busy != null}
                onClick={async () => {
                  if (busy != null) return;
                  setBusy(a.id);
                  try {
                    await markAppointmentPaid(a.id);
                    toast.success(`${money(a.price_pence!)} added to your money`);
                    onPaid();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Couldn't record the payment");
                  } finally { setBusy(null); }
                }}
              >
                <BanknoteArrowDown size={14} /> Paid
              </Button>
            ) : (
              <Button size="sm" onClick={() => onOpen(a)}>
                Add a price
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="h-2" />
    </Card>
  );
}

/** The days on screen, the dates to load, and the dates the totals cover. */
function periodFor(view: View, anchor: Date) {
  if (view === "day") {
    const day = isoDate(anchor);
    return {
      days: [anchor],
      from: day,
      to: day,
      countFrom: day,
      countTo: day,
      label: format(anchor, "EEE d MMM yyyy"),
    };
  }

  if (view === "week") {
    const start = startOfWeek(anchor, WEEK);
    const end = endOfWeek(anchor, WEEK);
    const sameMonth = isSameMonth(start, end);
    return {
      days: eachDayOfInterval({ start, end }),
      from: isoDate(start),
      to: isoDate(end),
      countFrom: isoDate(start),
      countTo: isoDate(end),
      label: `${format(start, sameMonth ? "d" : "d MMM")} – ${format(end, "d MMM yyyy")}`,
    };
  }

  const monthStart = startOfMonth(anchor);
  const monthEnd = endOfMonth(anchor);
  const start = startOfWeek(monthStart, WEEK);
  const end = endOfWeek(monthEnd, WEEK);
  return {
    days: eachDayOfInterval({ start, end }),
    from: isoDate(start),
    to: isoDate(end),
    countFrom: isoDate(monthStart),
    countTo: isoDate(monthEnd),
    label: format(anchor, "MMMM yyyy"),
  };
}
