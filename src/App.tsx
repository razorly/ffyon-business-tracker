import { Component, lazy, Suspense, useEffect, type ReactNode } from "react";
import { HashRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Toaster, toast } from "sonner";
import { DataProvider } from "@/lib/data";
import { InboxProvider } from "@/lib/inbox";
import { runAutoBackup } from "@/lib/export";
import { checkForUpdate } from "@/lib/update";
import { ThemeProvider, useTheme } from "@/lib/theme";
import { Layout } from "@/components/Layout";
import { WindowFrame } from "@/components/WindowFrame";
import { EntryDialog } from "@/components/EntryDialog";
import { AppointmentDialog } from "@/components/AppointmentDialog";
import { TrayBridge } from "@/components/TrayBridge";
import { AccessGate } from "@/components/AccessGate";
import { SyncBridge } from "@/components/SyncBridge";
import { isDesktop, isPwa } from "@/lib/access";
import { LedgerGate } from "@/components/LedgerGate";
import { useData } from "@/lib/data";
import { Button, Card } from "@/components/ui";
const MailPage = lazy(() => import("@/pages/Mail").then(module => ({ default: module.MailPage })));
const Today = lazy(() => import("@/pages/Today").then(module => ({ default: module.Today })));
const Schedule = lazy(() => import("@/pages/Schedule").then(module => ({ default: module.Schedule })));
const Finances = lazy(() => import("@/pages/Finances").then(module => ({ default: module.Finances })));
const Clients = lazy(() => import("@/pages/Clients").then(module => ({ default: module.Clients })));
const Settings = lazy(() => import("@/pages/Settings").then(module => ({ default: module.Settings })));

function Page({ children }: { children: ReactNode }) {
  const section = useLocation().pathname.split("/")[1];
  return <PageBoundary key={section}>
    <Suspense fallback={<p className="py-6 text-small text-ink-2" role="status">Loading…</p>}>{children}</Suspense>
  </PageBoundary>;
}

class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <Card className="space-y-3 p-5">
      <h1 className="text-heading font-semibold">This page couldn't open</h1>
      <p className="text-small text-ink-2" role="alert">Reload the tracker to try again.</p>
      <Button variant="primary" onClick={() => window.location.reload()}>Reload tracker</Button>
    </Card>;
  }
}

function Shell() {
  // One quiet copy a day, if she's set a folder for it.
  useEffect(() => {
    if (!isDesktop()) return;
    runAutoBackup().catch(() => {
      toast.error("Automatic backup failed — check the folder in Settings");
    });
    // Offline or GitHub unreachable is not worth interrupting anyone over.
    checkForUpdate().catch((e) => console.error("Update check failed", e));
  }, []);

  return (
    <DataProvider>
      <LedgerRefresh />
      <InboxProvider>
        <HashRouter>
          <SyncBridge />
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Page><Today /></Page>} />
              <Route path="schedule" element={<Page><Schedule /></Page>} />
              {/* To do now lives on Today. Push alerts and older bookmarks still link here. */}
              <Route path="todo" element={<Navigate to="/" replace />} />
              <Route path="mail/:conversationId?" element={<Page><MailPage /></Page>} />
              <Route path="finances" element={<Page><Finances /></Page>} />
              {/* Older names and bookmarks */}
              <Route path="inbox" element={<Navigate to="/" replace />} />
              <Route path="requests" element={<Navigate to="/" replace />} />
              <Route path="monthly" element={<Navigate to="/finances" replace />} />
              <Route path="clients" element={<Page><Clients /></Page>} />
              <Route path="settings" element={<Page><Settings /></Page>} />
            </Route>
          </Routes>
        </HashRouter>
        <EntryDialog />
        <AppointmentDialog />
        {isDesktop() && <TrayBridge />}
      </InboxProvider>
    </DataProvider>
  );
}

function LedgerRefresh() {
  const { refresh } = useData();
  useEffect(() => {
    window.addEventListener("ffyon-ledger-data-changed", refresh);
    return () => window.removeEventListener("ffyon-ledger-data-changed", refresh);
  }, [refresh]);
  return null;
}

export default function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
}

function AppContent() {
  const { dark } = useTheme();
  return <>
    <WindowFrame><AccessGate><LedgerGate><Shell /></LedgerGate></AccessGate></WindowFrame>
    {/* On the phone, toasts sit above the tab bar so they never cover a tab. */}
    <Toaster position="bottom-right" theme={dark ? "dark" : "light"} style={{ zIndex: 40 }} richColors closeButton
      mobileOffset={isPwa() ? { bottom: "calc(80px + env(safe-area-inset-bottom))" } : undefined} />
  </>;
}
