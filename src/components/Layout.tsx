import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { CalendarHeart, Cloud, CloudOff, LayoutDashboard, ListChecks, LoaderCircle, Mail, Plus, RefreshCw, Settings, Users, Wallet } from "lucide-react";
import { useData } from "@/lib/data";
import { useInbox } from "@/lib/inbox";
import { getSyncState, retryPendingMutation, subscribeSync, syncNow } from "@/lib/sync";
import { checkAccess } from "@/lib/access";
import { cn } from "@/lib/utils";
import { Button } from "./ui";
import { useAccess } from "./AccessGate";
import { BrandLogo } from "./BrandLogo";

const nav = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/schedule", label: "Schedule", icon: CalendarHeart },
  { to: "/todo", label: "To do", icon: ListChecks },
  { to: "/mail", label: "Mail", icon: Mail },
  { to: "/finances", label: "Finances", icon: Wallet },
  { to: "/clients", label: "Clients", icon: Users },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Layout() {
  const { openNewEntry } = useData();
  const { requests, payments, mail } = useInbox();
  // To do counts appointments only; unread email has its own badge on Mail.
  const todo = new Set([...requests, ...payments].map(row => row.id)).size;
  const badge = (to: string) => to === "/todo" ? todo : to === "/mail" ? mail.unread_count : 0;
  const describe = (to: string, label: string) => to === "/todo" && todo ? `To do, ${todo} appointment${todo === 1 ? "" : "s"} needing attention`
    : to === "/mail" && mail.unread_count ? `Mail, ${mail.unread_count} unread conversation${mail.unread_count === 1 ? "" : "s"}` : label;
  return (
    <div className="app-layout flex h-full">
      <aside className="flex w-16 shrink-0 flex-col border-r border-line bg-surface px-2 py-6 sm:w-60 sm:px-4">
        <div className="mb-7 hidden px-2 pt-1 text-center sm:block">
          <BrandLogo />
          <div className="eyebrow mt-1.5 text-[10px] text-ink-2">Business Tracker</div>
          <div className="mx-auto mt-3 h-px w-3/4 bg-rose" />
        </div>

        <Button variant="primary" className="mb-5 w-full" aria-label="New entry" title="New appointment, income or expense" onClick={() => openNewEntry()}>
          <Plus size={16} /><span className="hidden sm:inline">New entry</span>
        </Button>

        <nav className="space-y-0.5">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              title={label}
              aria-label={describe(to, label)}
              className={({ isActive }) =>
                cn(
                  "relative flex items-center gap-3 rounded-full px-3 py-2.5 text-[14.5px] font-medium transition-colors sm:px-4",
                  isActive ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                )
              }
            >
              <Icon size={17} className="shrink-0" /><span className="hidden sm:inline">{label}</span>{badge(to) > 0 && <span data-testid={to === "/mail" ? "mail-badge" : "todo-badge"} className="absolute right-0 top-0 rounded-full bg-accent px-1.5 py-0.5 text-[11px] text-accent-ink sm:static sm:ml-auto sm:px-2">{badge(to)}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto pt-5"><ConnectionStatus /></div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-7 sm:px-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function ConnectionStatus() {
  const access = useAccess();
  const { refresh } = useData();
  const [sync, setSync] = useState(getSyncState);
  useEffect(() => subscribeSync(setSync), []);
  const offline = access.state !== "online";
  const label = offline ? "Offline" : sync.state === "error" ? "Sync needs attention" : sync.state === "syncing" ? "Syncing" : "Connected";
  return <div className="border-t border-line pt-3">
    <div className="flex items-center gap-2 text-xs text-ink-2" title={label}>{sync.state === "syncing" ? <LoaderCircle size={14} className="shrink-0 animate-spin" /> : offline || sync.state === "error" ? <CloudOff size={14} className="shrink-0" /> : <Cloud size={14} className="shrink-0 text-good" />}<span className="hidden sm:inline">{label}</span><Button variant="ghost" size="icon" className="ml-auto hidden sm:inline-flex" title="Retry Sync" aria-label="Retry Sync" disabled={offline || sync.state === "syncing"} onClick={async () => { try { const status = await checkAccess(); if (status.state !== "online") return; await retryPendingMutation(); await syncNow(); refresh(); } catch { /* The status below shows the error. */ } }}><RefreshCw size={12} /></Button></div>
    <p className="mt-1 hidden text-[11px] text-muted sm:block">{sync.last_synced_at ? `Last synced ${new Date(sync.last_synced_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : "No synchronization yet"}</p>
    {sync.error && <p role="status" className="mt-1 hidden break-words text-[11px] text-bad sm:block">{sync.error}</p>}
  </div>;
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-[38px] leading-none text-ink">{title}</h1>
        <div className="mt-3 h-px w-16 bg-rose" />
        {subtitle && <p className="eyebrow mt-3 text-ink-2">{subtitle}</p>}
      </div>
      {children && <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
