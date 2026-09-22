import { invoke } from "@tauri-apps/api/core";
import { format } from "date-fns";
import {
  isTauri,
  listAppointments,
  listCategories,
  listTransactions,
  unpaidBefore,
  type AppointmentRow,
} from "./db";
import { readAutoBackup } from "./export";
import { isoDate, moneyNeat, shortDate, timeLabel } from "./format";

/**
 * The tray menu is built here, not in Rust: this side knows what an
 * appointment is worth and which services have a usual price. Rust draws
 * whatever it's handed and sends the clicks back as the events below.
 */

export const TRAY_EVENT = {
  newEntry: "tray://new-entry",
  quickAdd: "tray://quick-add",
  markPaid: "tray://mark-paid",
  backup: "tray://backup",
  askClose: "tray://ask-close",
} as const;

/** Ctrl + Shift + N on Windows, Cmd + Shift + N on a Mac. */
export const QUICK_KEYS = "CommandOrControl+Shift+N";
export const QUICK_KEYS_LABEL = "Ctrl/⌘ + Shift + N";

interface TrayItem {
  id: number;
  label: string;
}

interface TrayState {
  tooltip: string;
  lines: string[];
  quickAdd: TrayItem[];
  markPaid: TrayItem[];
  backup: boolean;
}

/** How many appointments the "Mark paid" submenu will hold before it gets silly. */
const MAX_WAITING = 8;

/** Today as the menu sees it: what's come in, what's next, what's still to collect. */
async function trayState(): Promise<TrayState> {
  const today = isoDate(new Date());
  const now = format(new Date(), "HH:mm");

  const [income, todays, txs, overdue] = await Promise.all([
    listCategories("income"),
    listAppointments({ from: today, to: today }),
    listTransactions({ from: today, to: today }),
    unpaidBefore(today),
  ]);

  const total = (type: "income" | "expense") =>
    txs.filter((t) => t.type === type).reduce((s, t) => s + t.amount_pence, 0);
  const inToday = total("income");
  const outToday = total("expense");

  const booked = todays.filter((a) => a.status === "booked");
  const next = booked.find((a) => a.start_time >= now);
  const takings = `Today: ${moneyNeat(inToday)} in${outToday ? ` · ${moneyNeat(outToday)} out` : ""}`;
  const diary = next
    ? `Next: ${timeLabel(next.start_time)} ${next.client_name ?? "appointment"}`
    : todays.length
      ? "Nothing else booked today"
      : "Nothing booked today";

  // Today's bookings first, then the oldest debts working backwards.
  const waiting = [...booked, ...[...overdue].reverse()].slice(0, MAX_WAITING);

  return {
    tooltip: [`Ffyon — ${moneyNeat(inToday)} in today`, next && `next ${timeLabel(next.start_time)}`]
      .filter(Boolean)
      .join(" · "),
    lines: [takings, diary],
    quickAdd: income
      .filter((c) => c.default_pence != null && c.default_pence > 0)
      .map((c) => ({ id: c.id, label: `${c.name} — ${moneyNeat(c.default_pence!)}` })),
    markPaid: waiting.map((a) => ({ id: a.id, label: waitingLabel(a, today) })),
    backup: readAutoBackup() != null,
  };
}

function waitingLabel(a: AppointmentRow, today: string): string {
  const when = a.date === today ? timeLabel(a.start_time) : shortDate(a.date);
  const who = a.client_name ?? a.category_name ?? "Appointment";
  return `${when} · ${who}${a.price_pence ? ` — ${moneyNeat(a.price_pence)}` : ""}`;
}

/**
 * Redraws the menu. Called whenever the data moves, and on a timer for the
 * clock. A tray that won't redraw isn't worth interrupting anyone over.
 */
export async function syncTray() {
  if (!isTauri()) return;
  try {
    await invoke("set_tray_state", { state: await trayState() });
  } catch (e) {
    console.error("Couldn't update the tray", e);
  }
}

// ---------- The window ----------

export const showWindow = () => invokeQuietly("show_main_window");
export const hideWindow = () => invokeQuietly("hide_main_window");
export const quitApp = () => invokeQuietly("quit_app");

/** True when she's actually looking at the window — an on-screen message will do. */
export async function windowIsActive(): Promise<boolean> {
  if (!isTauri()) return true;
  try {
    return await invoke<boolean>("window_is_active");
  } catch {
    return true;
  }
}

/**
 * Says what just happened when the window is out of sight, so a one-click tray
 * action is never silent.
 */
export async function notifyFromTray(title: string, body: string) {
  if (!isTauri() || (await windowIsActive())) return;
  try {
    const n = await import("@tauri-apps/plugin-notification");
    const granted = (await n.isPermissionGranted()) || (await n.requestPermission()) === "granted";
    if (granted) n.sendNotification({ title, body });
  } catch (e) {
    console.error("Notification failed", e);
  }
}

async function invokeQuietly(cmd: string) {
  if (!isTauri()) return;
  try {
    await invoke(cmd);
  } catch (e) {
    console.error(`${cmd} failed`, e);
  }
}

// ---------- Preferences ----------

/** What the window's close button does. Asked once, then remembered. */
export type CloseAction = "ask" | "tray" | "quit";

const CLOSE_KEY = "ffyon-close-action";
const SHORTCUT_KEY = "ffyon-quick-shortcut";

export function readCloseAction(): CloseAction {
  try {
    const v = localStorage.getItem(CLOSE_KEY);
    if (v === "tray" || v === "quit") return v;
  } catch {
    /* storage unavailable */
  }
  return "ask";
}

/** Rust keeps its own copy, so the window still closes if the page is busy. */
export async function writeCloseAction(action: CloseAction) {
  try {
    if (action === "ask") localStorage.removeItem(CLOSE_KEY);
    else localStorage.setItem(CLOSE_KEY, action);
  } catch {
    /* storage unavailable */
  }
  if (!isTauri()) return;
  try {
    await invoke("set_close_action", { action });
  } catch (e) {
    console.error("Couldn't set the close action", e);
  }
}

export function readShortcutEnabled(): boolean {
  try {
    return localStorage.getItem(SHORTCUT_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeShortcutEnabled(on: boolean) {
  try {
    localStorage.setItem(SHORTCUT_KEY, on ? "on" : "off");
  } catch {
    /* storage unavailable */
  }
}

/** What the icon sits in, in her words. */
export const trayName = () => (navigator.userAgent.includes("Mac") ? "menu bar" : "system tray");

/**
 * Registers (or drops) the shortcut that opens a new entry from any other app.
 * Returns false if something else on the computer already owns those keys.
 *
 * Calls queue up behind each other: registering and unregistering the same keys
 * at the same time (a toggle flicked twice, or React's double-run in dev) would
 * otherwise land in either order.
 */
export function applyShortcut(on: boolean, onFire: () => void): Promise<boolean> {
  const next = () => setShortcut(on, onFire);
  shortcutQueue = shortcutQueue.then(next, next);
  return shortcutQueue;
}

let shortcutQueue: Promise<boolean> = Promise.resolve(true);

async function setShortcut(on: boolean, onFire: () => void): Promise<boolean> {
  if (!isTauri()) return on;
  try {
    const g = await import("@tauri-apps/plugin-global-shortcut");
    if (await g.isRegistered(QUICK_KEYS)) await g.unregister(QUICK_KEYS);
    if (!on) return true;
    await g.register(QUICK_KEYS, (event) => {
      // Fires on the way down and the way up — once is plenty.
      if (event.state === "Released") return;
      onFire();
    });
    return true;
  } catch (e) {
    console.error("Global shortcut unavailable", e);
    return false;
  }
}
