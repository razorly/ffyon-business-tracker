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
  isToday,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { BanknoteArrowDown, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { isOwed, listAppointments, markAppointmentPaid, unpaidBefore, type AppointmentRow } from "@/lib/db";
import { useData, useLoad } from "@/lib/data";
import { isoDate, money, shortDate, timeLabel } from "@/lib/format";
import { PageHeader } from "@/components/Layout";
import { Button, Card, CardHeader, Segmented, Stat } from "@/components/ui";
import { MonthGrid, TimeGrid } from "@/components/calendar";
import { toast } from "sonner";

type View = "day" | "week" | "month";

const WEEK = { weekStartsOn: 1 } as const; // weeks run Monday to Sunday

export function Schedule() {
  const { openNewAppointment, openEditAppointment, refresh } = useData();
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState(() => new Date());

  const period = useMemo(() => periodFor(view, anchor), [view, anchor]);
  const [rows] = useLoad(() => listAppointments({ from: period.from, to: period.to }), [period.from, period.to], []);

  // In month view the grid spills into neighbouring months — the totals stay on the month itself.
  const counted = rows.filter(
    (r) => r.date >= period.countFrom && r.date <= period.countTo && r.status !== "cancelled" && r.status !== "no_show",
  );
  const paid = counted.filter((r) => r.status === "paid").reduce((s, r) => s + (r.price_pence ?? 0), 0);
  const owed = counted.filter(isOwed).reduce((s, r) => s + (r.price_pence ?? 0), 0);

  // Past bookings never marked paid. Not tied to the week on screen — it's a standing to-do list.
  const [overdue] = useLoad(() => unpaidBefore(isoDate(new Date())), [], []);

  const showsToday = period.days.some((d) => isToday(d));
  const openNew = (date: string, start_time: string) => openNewAppointment({ date, start_time });

  const step = (dir: 1 | -1) =>
    setAnchor((d) => (view === "day" ? addDays(d, dir) : view === "week" ? addWeeks(d, dir) : addMonths(d, dir)));

  return (
    <>
      <PageHeader title="Schedule" subtitle="Your diary — appointments only count as money once they're paid">
        <div className="flex items-center gap-1 rounded-full border border-line bg-surface p-1">
          <Button variant="ghost" size="icon" onClick={() => step(-1)} aria-label={`Previous ${view}`}>
            <ChevronLeft size={16} />
          </Button>
          <span className="min-w-[200px] px-2 text-center font-display text-[18px]">{period.label}</span>
          <Button variant="ghost" size="icon" onClick={() => step(1)} aria-label={`Next ${view}`}>
            <ChevronRight size={16} />
          </Button>
        </div>
        {!showsToday && <Button onClick={() => setAnchor(new Date())}>Today</Button>}
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: "day", label: "Day" },
            { value: "week", label: "Week" },
            { value: "month", label: "Month" },
          ]}
        />
        <Button variant="primary" onClick={() => openNew(isoDate(showsToday ? new Date() : period.days[0]), "09:00")}>
          <Plus size={15} /> Book
        </Button>
      </PageHeader>

      <div className="grid grid-cols-3 gap-4">
        <Stat label="Appointments" value={String(counted.length)} />
        <Stat label="Paid" value={money(paid)} tone="good" hint="Counted in your money" />
        <Stat label="Still to collect" value={money(owed)} hint="Not in your money until you mark it paid" />
      </div>

      <Card className="mt-4 overflow-hidden">
        {view === "month" ? (
          <MonthGrid
            month={anchor}
            days={period.days}
            rows={rows}
            onOpen={openEditAppointment}
            onNew={openNew}
            onShowDay={(d) => {
              setAnchor(d);
              setView("day");
            }}
          />
        ) : (
          <div className="py-3 pr-3">
            <TimeGrid days={period.days} rows={rows} onOpen={openEditAppointment} onNew={openNew} />
          </div>
        )}
      </Card>

      <p className="mt-3 text-center text-[12.5px] text-muted">
        Click any empty time to book · click an appointment to open it and mark it paid
      </p>

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
              <span className="font-medium">{a.client_name ?? a.category_name ?? "Appointment"}</span>
              <span className="block text-[12px] text-muted">
                {shortDate(a.date)} · {timeLabel(a.start_time)}
                {a.client_name && a.category_name ? ` · ${a.category_name}` : ""}
              </span>
            </button>
            <span className="tabular text-[13.5px] font-semibold">
              {a.price_pence != null ? money(a.price_pence) : <span className="text-muted">No price</span>}
            </span>
            {a.price_pence != null ? (
              <Button
                size="sm"
                onClick={async () => {
                  await markAppointmentPaid(a.id);
                  toast.success(`${money(a.price_pence!)} added to your money`);
                  onPaid();
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
