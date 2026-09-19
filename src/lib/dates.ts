import { addMonths, endOfMonth, format, startOfMonth } from "date-fns";
import { isoDate } from "./format";

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
