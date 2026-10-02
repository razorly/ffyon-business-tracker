import { addMonths, endOfMonth, format, startOfMonth } from "date-fns";
import { isoDate } from "./format";
import { useEffect, useState } from "react";

const businessClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** A local Date containing the salon's London wall-clock fields. */
export function businessNow(now = new Date()): Date {
  const parts = Object.fromEntries(businessClock.formatToParts(now).map((part) => [part.type, part.value]));
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

/** Refresh day-dependent views after midnight and when the app regains focus. */
export function useBusinessNow(): Date {
  const [now, setNow] = useState(businessNow);
  useEffect(() => {
    const tick = () => setNow(businessNow());
    const timer = window.setInterval(tick, 60_000);
    window.addEventListener("focus", tick);
    const visible = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  return now;
}

export const monthRange = (d: Date) => ({ from: isoDate(startOfMonth(d)), to: isoDate(endOfMonth(d)) });

/** UK tax year runs 6 April – 5 April. Returns the tax year containing `d` (offset in years). */
export function taxYear(d: Date, offset = 0) {
  const startYear = (d.getMonth() > 3 || (d.getMonth() === 3 && d.getDate() >= 6) ? d.getFullYear() : d.getFullYear() - 1) + offset;
  return {
    from: `${startYear}-04-06`,
    to: `${startYear + 1}-04-05`,
    label: `${startYear}/${String(startYear + 1).slice(2)}`,
  };
}

/** The last `n` months ending with the month of `d`, as yyyy-MM keys. */
export function lastMonths(d: Date, n: number): string[] {
  return Array.from({ length: n }, (_, i) => format(addMonths(startOfMonth(d), i - (n - 1)), "yyyy-MM"));
}
