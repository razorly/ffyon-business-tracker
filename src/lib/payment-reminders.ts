import { invoke } from "@tauri-apps/api/core";
import { getAccessStatus, isDesktop } from "./access";
import type { AppointmentRow } from "./db";

const PREF_KEY = "ffyon-payment-reminders";
const seenByDevice = new Map<string, Set<string>>();
let permissionRequested = false;
let sessionPreference: boolean | null = null;
let queue: Promise<unknown> = Promise.resolve();
export type ReminderResult = "idle" | "sent" | "blocked" | "error";

export function readPaymentRemindersEnabled(): boolean {
  if (sessionPreference != null) return sessionPreference;
  try { return localStorage.getItem(PREF_KEY) !== "off"; }
  catch { return true; }
}

export function writePaymentRemindersEnabled(enabled: boolean) {
  sessionPreference = enabled;
  try { localStorage.setItem(PREF_KEY, enabled ? "on" : "off"); }
  catch { /* The current session still respects the preference. */ }
}

function reminderKey(row: AppointmentRow): string {
  return JSON.stringify([row.remote_id ?? row.id, row.date, row.time_confirmed, row.start_time, row.duration_min]);
}

function readSeen(device: string): Set<string> {
  if (seenByDevice.has(device)) return seenByDevice.get(device)!;
  let seen = new Set<string>();
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`ffyon-payment-reminders-seen:${device}`) ?? "[]");
    if (Array.isArray(saved)) seen = new Set(saved.filter((key): key is string => typeof key === "string"));
  } catch { /* Missing or damaged notification bookkeeping is safe to replace. */ }
  seenByDevice.set(device, seen);
  return seen;
}

function saveSeen(device: string, seen: Set<string>) {
  seenByDevice.set(device, seen);
  try { localStorage.setItem(`ffyon-payment-reminders-seen:${device}`, JSON.stringify([...seen])); }
  catch { /* In-memory deduplication still prevents repeat alerts this session. */ }
}

/** Serialize sends so overlapping refreshes cannot notify twice. Store no customer details. */
export function notifyPaymentConfirmations(rows: AppointmentRow[], current: () => boolean): Promise<ReminderResult> {
  const send = async (): Promise<ReminderResult> => {
    if (!isDesktop() || !current()) return "idle";
    try {
      const access = await getAccessStatus();
      if (!current() || !access.device_id || (access.state !== "online" && access.state !== "offline")) return "idle";
      const seen = readSeen(access.device_id);
      const keys = rows.map(reminderKey);
      if (!keys.some(key => !seen.has(key))) {
        saveSeen(access.device_id, new Set(keys));
        return "idle";
      }
      const notifications = await import("@tauri-apps/plugin-notification");
      let granted = await notifications.isPermissionGranted();
      if (!granted && !permissionRequested) {
        if (!current()) return "idle";
        permissionRequested = true;
        granted = await notifications.requestPermission() === "granted";
      }
      if (!current()) return "idle";
      if (!granted) return "blocked";
      // The native command checks the approved-device lease again and awaits OS submission.
      await invoke("notify_payment_confirmation", { count: rows.length });
      saveSeen(access.device_id, new Set(keys));
      return "sent";
    } catch (error) {
      console.error("Payment reminder failed", error);
      return "error";
    }
  };
  const next = queue.then(send, send);
  queue = next;
  return next;
}
