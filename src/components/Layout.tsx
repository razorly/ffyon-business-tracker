import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { CalendarDays, Mail, Plus, RefreshCw, SlidersHorizontal, Sun, Users, Wallet } from "lucide-react";
import { useData } from "@/lib/data";
import { useInbox } from "@/lib/inbox";
import { businessNow } from "@/lib/dates";
import { isoDate } from "@/lib/format";
import { getSyncState, retryPendingMutation, subscribeSync, syncNow } from "@/lib/sync";
import { checkAccess, isPwa } from "@/lib/access";
import { cn } from "@/lib/utils";
import { Badge, Button, Notice } from "./ui";
import { useAccess } from "./AccessGate";
import { BrandLogo } from "./BrandLogo";
import { LedgerStatus, useSharedLedger } from "./LedgerGate";

/** The four places she works in, then the two she visits. To do lives on Today. */
const main = [
  { to: "/", label: "Today", icon: Sun },
  { to: "/schedule", label: "Diary", icon: CalendarDays },
  { to: "/finances", label: "Money", icon: Wallet },
  { to: "/clients", label: "Clients", icon: Users },
];
const side = [
  { to: "/mail", label: "Mail", icon: Mail },
  { to: "/settings", label: "Settings", icon: SlidersHorizontal },
];

export function Layout() {
  const { openNewAppointment, openNewEntry } = useData();
  const { requests, payments, mail } = useInbox();
  const webApp = isPwa();
  // Today counts appointments needing her; unread email has its own badge on Mail.
  const todo = new Set([...requests, ...payments].map(row => row.id)).size;
  const badge = (to: string) => to === "/" ? todo : to === "/mail" ? mail.unread_count : 0;
  const describe = (to: string, label: string) => to === "/" && todo ? `Today, ${todo} thing${todo === 1 ? "" : "s"} need you`
    : to === "/mail" && mail.unread_count ? `Mail, ${mail.unread_count} unread conversation${mail.unread_count === 1 ? "" : "s"}` : label;
  const link = ({ to, label, icon: Icon }: typeof main[number]) => (
    <NavLink key={to} to={to} end={to === "/"} title={label} aria-label={describe(to, label)}
      className={({ isActive }) => cn(
        "relative flex h-11 items-center gap-3 rounded-xl px-3 transition-colors",
        isActive ? "bg-surface-2 font-semibold text-ink" : "font-medium text-ink-2 hover:bg-surface-2/60 hover:text-ink",
      )}>
      <Icon size={20} className="shrink-0" aria-hidden /><span className="hidden sm:inline">{label}</span>
      {badge(to) > 0 && <Badge data-testid={to === "/mail" ? "mail-badge" : "todo-badge"} tone={to === "/" ? "strong" : "soft"} className="absolute -right-1 -top-1 sm:static sm:ml-auto">{badge(to)}</Badge>}
    </NavLink>
  );
  return (
    <div className="app-layout flex h-full">
      {webApp && <header className="pwa-header">
        <BrandLogo size="small" />
        <div className="flex">
          {side.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} aria-label={describe(to, label)} className={({ isActive }) => cn("relative flex h-11 w-11 items-center justify-center rounded-xl", isActive ? "bg-surface-2 text-ink" : "text-ink-2")}>
            <Icon size={22} aria-hidden />{badge(to) > 0 && <Badge aria-hidden className="absolute right-0 top-0">{badge(to)}</Badge>}
          </NavLink>)}
        </div>
      </header>}
      <aside className={cn("flex w-16 shrink-0 flex-col border-r border-line bg-surface px-2 pb-5 pt-7 sm:w-[232px] sm:px-4", webApp && "pwa-sidebar")}>
        <div className="mb-6 hidden sm:block"><BrandLogo /></div>

        <Button variant="primary" className="mb-4 w-full px-0" aria-label="New" title="New booking, money in or money out" onClick={() => openNewEntry()}>
          <Plus size={18} aria-hidden /><span className="hidden sm:inline">New</span>
        </Button>

        <nav aria-label="Main" className="space-y-1">
          {main.map(link)}
          <div className="mx-3 my-3 h-px bg-line" />
          {side.map(link)}
        </nav>

        <div className="mt-auto pt-5"><ConnectionStatus /></div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 pb-10 pt-4 sm:px-10 sm:pt-9">
          <ConnectionNotice />
          <LedgerStatus />
          <Outlet />
        </div>
      </main>
      {webApp && <nav className="pwa-tabs" aria-label="Main">
        {main.slice(0, 2).map(tab(badge, describe))}
        <button type="button" className="pwa-tab-new" aria-label="New"
          onClick={() => openNewAppointment({ date: isoDate(businessNow()), start_time: "09:00", fromEntry: true })}>
          <span><Plus size={24} aria-hidden /></span>
        </button>
        {main.slice(2).map(tab(badge, describe))}
      </nav>}
    </div>
  );
}

const tab = (badge: (to: string) => number, describe: (to: string, label: string) => string) => ({ to, label, icon: Icon }: typeof main[number]) => (
  <NavLink key={to} to={to} end={to === "/"} aria-label={describe(to, label)}>
    <span className="relative"><Icon size={24} aria-hidden />{badge(to) > 0 && <span aria-hidden className="pwa-tab-badge">{badge(to)}</span>}</span>
    <span>{label}</span>
  </NavLink>
);

function useSync() {
  const [sync, setSync] = useState(getSyncState);
  useEffect(() => subscribeSync(setSync), []);
  return sync;
}

async function retrySync(refresh: () => void) {
  try {
    const status = await checkAccess();
    if (status.state !== "online") return;
    await retryPendingMutation();
    await syncNow({ full: true });
    refresh();
  } catch { /* The status shows the error. */ }
}

/** Plain words first; the technical reason is there for whoever is helping her fix it. */
function ConnectionNotice() {
  const access = useAccess();
  const { ledger } = useSharedLedger();
  const { refresh } = useData();
  const sync = useSync();
  if (access.state !== "online") return <Notice>{ledger
    ? "You're offline. Reconnect to update bookings, record payments or edit private notes."
    : "You're offline. You can still take payments and add private notes. Bookings need a connection."}</Notice>;
  if (sync.state !== "error") return null;
  return <Notice tone="bad" action={<Button size="sm" onClick={() => void retrySync(refresh)}><RefreshCw size={14} aria-hidden /> Try again</Button>}>
    Couldn't update just now. What you see may be a little out of date.
    {sync.error && <details className="mt-1 text-ink-2"><summary className="cursor-pointer">Show details</summary><span className="break-words">{sync.error}</span></details>}
  </Notice>;
}

function ConnectionStatus() {
  const access = useAccess();
  const { refresh } = useData();
  const sync = useSync();
  const offline = access.state !== "online";
  const label = offline ? "Offline" : sync.state === "error" ? "Couldn't update" : sync.state === "syncing" ? "Updating" : "Up to date";
  const checked = sync.last_synced_at ? new Date(sync.last_synced_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null;
  return <div className="flex items-center gap-2 px-3 text-label text-ink-2" title={label}>
    <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", offline ? "bg-line-strong" : sync.state === "error" ? "bg-bad" : sync.state === "syncing" ? "animate-pulse bg-rose" : "bg-good")} />
    <span role="status" className="hidden min-w-0 flex-1 sm:block">{label}{!offline && sync.state !== "syncing" && checked ? ` · ${checked}` : ""}</span>
    <Button variant="ghost" size="icon" className="hidden h-8 w-8 sm:inline-flex" title="Check for changes now" aria-label="Check for changes now" disabled={offline || sync.state === "syncing"} onClick={() => void retrySync(refresh)}>
      <RefreshCw size={14} className={cn(sync.state === "syncing" && "animate-spin")} aria-hidden />
    </Button>
  </div>;
}

/** The top of every page: a serif title, one line beneath, and the page's own controls. */
export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="font-display text-title text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-small text-ink-2">{subtitle}</p>}
      </div>
      {children && <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
