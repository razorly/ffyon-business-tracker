import { format, parseISO } from "date-fns";

const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const gbpWhole = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});
const gbpCompact = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  notation: "compact",
  maximumFractionDigits: 1,
});

/** £1,234.50 */
export const money = (pence: number) => gbp.format(pence / 100);

/** £1,235 — for axis ticks and big figures that don't need pennies */
export const moneyWhole = (pence: number) => gbpWhole.format(pence / 100);

/** £30 for a round amount, £27.50 when it isn't — for tight calendar blocks */
export const moneyNeat = (pence: number) => (pence % 100 === 0 ? gbpWhole.format(pence / 100) : gbp.format(pence / 100));

/** £1.2K — for tight axis labels */
export const moneyCompact = (pence: number) =>
  Math.abs(pence) < 100_000 ? gbpWhole.format(pence / 100) : gbpCompact.format(pence / 100);

/** Parse "10", "£10.50", "1,200" into pence. Returns null if invalid. */
export function parseAmount(input: string): number | null {
  const cleaned = input.replace(/[£,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

export const penceToInput = (pence: number) => (pence / 100).toFixed(2);

/** ISO yyyy-MM-dd for storage */
export const isoDate = (d: Date) => format(d, "yyyy-MM-dd");

/** 02/02/2026 */
export const ukDate = (iso: string) => format(parseISO(iso), "dd/MM/yyyy");

/** Mon 2 Feb */
export const shortDate = (iso: string) => format(parseISO(iso), "EEE d MMM");

/** "2026-02" -> "Feb 26" */
export const monthLabel = (ym: string) => format(parseISO(ym + "-01"), "MMM yy");

/** "14:30" -> 870, minutes past midnight */
export function timeToMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** 870 -> "14:30" */
export function minToTime(min: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

/** "14:30" -> "2.30pm", "09:00" -> "9am" */
export function timeLabel(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  const suffix = h < 12 ? "am" : "pm";
  return m ? `${hour}.${String(m).padStart(2, "0")}${suffix}` : `${hour}${suffix}`;
}

/** 90 -> "1 hr 30 min" */
export function durationLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return [h && `${h} hr`, m && `${m} min`].filter(Boolean).join(" ") || "0 min";
}

export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}
