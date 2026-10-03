import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
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
const TodoPage = lazy(() => import("@/pages/Todo").then(module => ({ default: module.TodoPage })));
const MailPage = lazy(() => import("@/pages/Mail").then(module => ({ default: module.MailPage })));
const Dashboard = lazy(() => import("@/pages/Dashboard").then(module => ({ default: module.Dashboard })));
const Schedule = lazy(() => import("@/pages/Schedule").then(module => ({ default: module.Schedule })));
const Finances = lazy(() => import("@/pages/Finances").then(module => ({ default: module.Finances })));
const Clients = lazy(() => import("@/pages/Clients").then(module => ({ default: module.Clients })));
const Settings = lazy(() => import("@/pages/Settings").then(module => ({ default: module.Settings })));

function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<p className="p-6 text-muted" role="status">Loading…</p>}>{children}</Suspense>;
}

function Shell() {
  // One quiet copy a day, if she's set a folder for it.
  useEffect(() => {
    runAutoBackup().catch(() => {
      toast.error("Automatic backup failed — check the folder in Settings");
    });
    // Offline or GitHub unreachable is not worth interrupting anyone over.
    checkForUpdate().catch((e) => console.error("Update check failed", e));
  }, []);

  return (
    <DataProvider>
      <InboxProvider>
        <HashRouter>
          <SyncBridge />
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Page><Dashboard /></Page>} />
              <Route path="schedule" element={<Page><Schedule /></Page>} />
              <Route path="todo" element={<Page><TodoPage /></Page>} />
              <Route path="mail/:conversationId?" element={<Page><MailPage /></Page>} />
              <Route path="finances" element={<Page><Finances /></Page>} />
              {/* Older names and bookmarks */}
              <Route path="inbox" element={<Navigate to="/todo" replace />} />
              <Route path="requests" element={<Navigate to="/todo" replace />} />
              <Route path="monthly" element={<Navigate to="/finances" replace />} />
              <Route path="clients" element={<Page><Clients /></Page>} />
              <Route path="settings" element={<Page><Settings /></Page>} />
            </Route>
          </Routes>
        </HashRouter>
        <EntryDialog />
        <AppointmentDialog />
        <TrayBridge />
      </InboxProvider>
    </DataProvider>
  );
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
    <WindowFrame><AccessGate><Shell /></AccessGate></WindowFrame>
    <Toaster position="bottom-right" theme={dark ? "dark" : "light"} style={{ zIndex: 40 }} richColors closeButton />
  </>;
}
