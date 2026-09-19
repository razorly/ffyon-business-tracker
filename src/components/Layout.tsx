import { NavLink, Outlet } from "react-router-dom";
import { CalendarDays, LayoutDashboard, Plus, Settings, Sun, Users } from "lucide-react";
import { useData } from "@/lib/data";
import { cn } from "@/lib/utils";
import { Button } from "./ui";

const nav = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/monthly", label: "Monthly", icon: CalendarDays },
  { to: "/clients", label: "Clients", icon: Users },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Layout() {
  const { openNewEntry } = useData();
  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface px-3 py-5">
        <div className="mb-6 flex items-center gap-2.5 px-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#e8a15f] to-[#a9531d] text-white shadow-sm">
            <Sun size={19} strokeWidth={2.25} />
          </div>
          <div className="leading-tight">
            <div className="font-semibold">Ffyon</div>
            <div className="text-[12px] text-muted">Business Tracker</div>
          </div>
        </div>

        <Button variant="primary" className="mb-5 w-full" onClick={() => openNewEntry()}>
          <Plus size={16} /> New entry
        </Button>

        <nav className="space-y-0.5">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
                  isActive ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                )
              }
            >
              <Icon size={17} /> {label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto px-2 text-[11px] text-muted">Data is stored on this computer.</div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-7">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}
