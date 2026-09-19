import { NavLink, Outlet } from "react-router-dom";
import { CalendarDays, Heart, LayoutDashboard, Plus, Settings, Users } from "lucide-react";
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
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface px-4 py-6">
        <div className="mb-7 px-2 pt-1 text-center">
          <div className="relative inline-block font-display text-[40px] leading-[0.95] text-ink">
            Ffyon
            <Heart
              size={18}
              strokeWidth={2.5}
              className="absolute -right-6 top-1 rotate-12 text-rose"
              aria-hidden
            />
          </div>
          <div className="eyebrow mt-1.5 text-[10px] text-ink-2">Business Tracker</div>
          <div className="mx-auto mt-3 h-px w-3/4 bg-rose" />
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
                  "flex items-center gap-3 rounded-full px-4 py-2.5 text-[14.5px] font-medium transition-colors",
                  isActive ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                )
              }
            >
              <Icon size={17} /> {label}
            </NavLink>
          ))}
        </nav>

        <div className="eyebrow mt-auto text-center text-[9.5px] text-muted">Track · Glow · Grow</div>
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
        <h1 className="font-display text-[38px] leading-none text-ink">{title}</h1>
        <div className="mt-3 h-px w-16 bg-rose" />
        {subtitle && <p className="eyebrow mt-3 text-ink-2">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}
