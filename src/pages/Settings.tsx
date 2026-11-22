import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Clock, Globe, Monitor, Plus, Smartphone, Sparkles, Wallet } from "lucide-react";
import { isPwa } from "@/lib/access";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/Layout";
import { SiteConnection } from "@/components/SiteConnection";
import { PushNotifications } from "@/components/PushNotifications";
import { CustomerBookingsCard, hasOlderRecords, ImportReviewCard, OpeningHoursCard, RequestEmailCard, ServicesCard, useSiteSettings, type SiteSettings } from "@/components/SiteBusinessSettings";
import { VisitSettingsCard } from "@/components/VisitSettingsCard";
import { LegacyIncomeReview } from "@/components/LegacyIncomeReview";
import { TimeOffDialog, TimeOffList } from "@/components/TimeOff";
import { CategoriesCard } from "@/components/settings/MoneySettings";
import { AboutCard, AppearanceCard, BackupCard, TrayCard } from "@/components/settings/DeviceSettings";
import { Help, OnlineNotice } from "@/components/settings/parts";
import { useNarrow } from "@/components/useNarrow";
import { Button, Card, CardHeader, ErrorText } from "@/components/ui";

type Section = "services" | "hours" | "website" | "money" | "device";
const SECTIONS: { value: Section; label: string; about: string; icon: typeof Clock }[] = [
  { value: "services", label: "Services and prices", about: "What you offer, how long it takes and what it costs", icon: Sparkles },
  { value: "hours", label: "When I work", about: "Opening hours and time off", icon: Clock },
  { value: "website", label: "Website and bookings", about: "Online bookings, home visits and contact details", icon: Globe },
  { value: "money", label: "Money", about: "Other income and expense categories", icon: Wallet },
  { value: "device", label: "This device", about: "Connection, backups and how the app looks", icon: Smartphone },
];
const SECTION_KEY = "ffyon-settings-section";
const isSection = (value: string | null): value is Section => SECTIONS.some((item) => item.value === value);
const remembered = (): Section => {
  try { const saved = sessionStorage.getItem(SECTION_KEY); return isSection(saved) ? saved : "services"; }
  catch { return "services"; }
};

/**
 * Settings in five plain sections. The section is in the address (`/settings?section=hours`), so other
 * pages can link straight to one. A phone opens on the list of sections; a wider screen shows the list
 * beside the chosen section.
 */
export function Settings() {
  const webApp = isPwa();
  const narrow = useNarrow();
  const [params] = useSearchParams();
  const asked = params.get("section");
  const chosen = isSection(asked) ? asked : null;
  // Remembered for the session so returning to Settings lands where you left off.
  useEffect(() => {
    if (!chosen) return;
    try { sessionStorage.setItem(SECTION_KEY, chosen); } catch { /* Only a convenience. */ }
  }, [chosen]);
  const section = chosen ?? (narrow ? null : remembered());
  const site = useSiteSettings();
  const label = (item: typeof SECTIONS[number]) => item.value === "device" && !webApp ? "This computer" : item.label;
  const icon = (item: typeof SECTIONS[number]) => {
    const Glyph = item.value === "device" && !webApp ? Monitor : item.icon;
    return <Glyph size={20} className="shrink-0" aria-hidden />;
  };
  const current = SECTIONS.find((item) => item.value === section);

  if (narrow && !current) return (
    <>
      <PageHeader title="Settings" />
      <Card>
        <nav aria-label="Settings sections">
          <ul className="divide-y divide-line">
            {SECTIONS.map((item) => <li key={item.value}>
              <Link to={`/settings?section=${item.value}`} className="flex min-h-11 items-center gap-3 px-5 py-3 hover:bg-surface-2/60">
                <span className="text-ink-2">{icon(item)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-ink">{label(item)}</span>
                  <span className="block text-small text-ink-2">{item.about}</span>
                </span>
                <ChevronRight size={18} className="shrink-0 text-ink-2" aria-hidden />
              </Link>
            </li>)}
          </ul>
        </nav>
      </Card>
    </>
  );

  return (
    <>
      {narrow && <Link to="/settings" aria-label="Back to Settings" className="-ml-2 mb-1 inline-flex min-h-11 items-center gap-1 rounded-xl px-2 font-medium text-ink-2 hover:text-ink"><ChevronLeft size={18} aria-hidden /> Settings</Link>}
      <PageHeader title={narrow && current ? label(current) : "Settings"} subtitle={narrow ? current?.about : undefined} />
      <div className="grid min-w-0 items-start gap-6 sm:grid-cols-[13rem_minmax(0,1fr)] lg:grid-cols-[15rem_minmax(0,1fr)]">
        {!narrow && <nav aria-label="Settings sections" className="space-y-1">
          {SECTIONS.map((item) => <Link key={item.value} to={`/settings?section=${item.value}`} replace aria-current={item.value === section ? "page" : undefined}
            className={cn("flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 transition-colors", item.value === section ? "bg-surface-2 font-semibold text-ink" : "font-medium text-ink-2 hover:bg-surface-2/60 hover:text-ink")}>
            {icon(item)}{label(item)}
          </Link>)}
        </nav>}
        <div className="flex min-w-0 max-w-3xl flex-col gap-6">
          {(section === "services" || section === "hours" || section === "website") && site.error && <ErrorText>{site.error}</ErrorText>}
          {section === "services" && <ServicesCard site={site} />}
          {section === "hours" && <>
            <OpeningHoursCard site={site} />
            <TimeOffCard site={site} />
          </>}
          {section === "website" && <>
            <CustomerBookingsCard site={site} />
            <VisitSettingsCard settings={site.settings} online={site.online} onSaved={site.refresh} />
            <RequestEmailCard site={site} />
            {hasOlderRecords(site) && <ImportReviewCard preview={site.preview} appointments={site.appointments} blocks={site.blocks} online={site.online} loaded={site.loaded} onSaved={site.refresh} />}
          </>}
          {section === "money" && <>
            <LegacyIncomeReview />
            <CategoriesCard type="income" />
            <CategoriesCard type="expense" />
            <Pointer to="/finances?export=1">Need your figures for your accountant or tax return? <span className="font-medium text-ink">Export from the Money page</span></Pointer>
          </>}
          {section === "device" && <>
            <SiteConnection />
            {webApp && <PushNotifications />}
            <BackupCard />
            {!webApp && <TrayCard />}
            <AppearanceCard />
            <AboutCard />
          </>}
        </div>
      </div>
    </>
  );
}

/** Days she is not working. Adding and removing them is shared with the diary. */
function TimeOffCard({ site }: { site: SiteSettings }) {
  const [adding, setAdding] = useState(false);
  return (
    <Card>
      <CardHeader title="Time off" subtitle="Holidays and days you can't be booked"
        action={<Button disabled={!site.online} onClick={() => setAdding(true)}><Plus size={18} aria-hidden /> Add time off</Button>} />
      <div className="px-5 pb-3">
        {site.loaded ? <TimeOffList blocks={site.blocks} online={site.online} onChanged={site.refresh} /> : <Help className="py-3">Loading…</Help>}
        {!site.online && !site.blocks.length && <OnlineNotice online={site.online} />}
      </div>
      {adding && <TimeOffDialog online={site.online} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); site.refresh(); }} />}
    </Card>
  );
}

/** A quiet line that sends her somewhere else for a related job. */
function Pointer({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="flex min-h-11 items-center gap-3 rounded-2xl border border-line px-5 py-3 text-small text-ink-2 hover:bg-surface-2/60">
      <span className="min-w-0 flex-1">{children}</span>
      <ChevronRight size={18} className="shrink-0" aria-hidden />
    </Link>
  );
}
