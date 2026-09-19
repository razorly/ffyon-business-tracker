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

export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}
