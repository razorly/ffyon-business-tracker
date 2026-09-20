import { useEffect } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { Toaster, toast } from "sonner";
import { DataProvider } from "@/lib/data";
import { runAutoBackup } from "@/lib/export";
import { checkForUpdate } from "@/lib/update";
import { ThemeProvider, useTheme } from "@/lib/theme";
import { Layout } from "@/components/Layout";
import { EntryDialog } from "@/components/EntryDialog";
import { AppointmentDialog } from "@/components/AppointmentDialog";
import { Dashboard } from "@/pages/Dashboard";
import { Schedule } from "@/pages/Schedule";
import { Monthly } from "@/pages/Monthly";
import { Clients } from "@/pages/Clients";
import { Settings } from "@/pages/Settings";

function Shell() {
  const { dark } = useTheme();

  // One quiet copy a day, if she's set a folder for it.
  useEffect(() => {
    runAutoBackup().catch((e) => {
      console.error(e);
      toast.error("Automatic backup failed — check the folder in Settings");
    });
    // Offline or GitHub unreachable is not worth interrupting anyone over.
    checkForUpdate().catch((e) => console.error("Update check failed", e));
  }, []);

  return (
    <DataProvider>
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="schedule" element={<Schedule />} />
            <Route path="monthly" element={<Monthly />} />
            <Route path="clients" element={<Clients />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Routes>
      </HashRouter>
      <EntryDialog />
      <AppointmentDialog />
      <Toaster position="bottom-right" theme={dark ? "dark" : "light"} richColors closeButton />
    </DataProvider>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}
