import { useEffect } from "react";
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
import { InboxPage } from "@/pages/Inbox";
import { Dashboard } from "@/pages/Dashboard";
import { Schedule } from "@/pages/Schedule";
import { Monthly } from "@/pages/Monthly";
import { Clients } from "@/pages/Clients";
import { Settings } from "@/pages/Settings";

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
              <Route index element={<Dashboard />} />
              <Route path="schedule" element={<Schedule />} />
              <Route path="inbox" element={<InboxPage />} />
              <Route path="requests" element={<Navigate to="/inbox" replace />} />
              <Route path="monthly" element={<Monthly />} />
              <Route path="clients" element={<Clients />} />
              <Route path="settings" element={<Settings />} />
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
