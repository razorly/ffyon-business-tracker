import { HashRouter, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { DataProvider } from "@/lib/data";
import { ThemeProvider, useTheme } from "@/lib/theme";
import { Layout } from "@/components/Layout";
import { EntryDialog } from "@/components/EntryDialog";
import { Dashboard } from "@/pages/Dashboard";
import { Monthly } from "@/pages/Monthly";
import { Clients } from "@/pages/Clients";
import { Settings } from "@/pages/Settings";

function Shell() {
  const { dark } = useTheme();
  return (
    <DataProvider>
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="monthly" element={<Monthly />} />
            <Route path="clients" element={<Clients />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Routes>
      </HashRouter>
      <EntryDialog />
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
