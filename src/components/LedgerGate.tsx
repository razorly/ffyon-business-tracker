import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, LoaderCircle } from "lucide-react";
import { isDesktop, isPwa } from "@/lib/access";
import { exportAll, getDeviceDb, setSharedDatabase, type Backup } from "@/lib/db";
import { money, ukDate } from "@/lib/format";
import { reviewCount } from "@/lib/ledger-merge";
import type { SharedLedger } from "@/lib/shared-ledger";
import { Button, Modal } from "./ui";
import { useAccess } from "./AccessGate";

const LedgerContext = createContext<{ ledger: SharedLedger | null; error: string; retry: () => void }>({
  ledger: null, error: "", retry: () => {},
});
export const useSharedLedger = () => useContext(LedgerContext);

export function LedgerGate({ children }: { children: ReactNode }) {
  const { device_id, state } = useAccess();
  return (isDesktop() || isPwa()) && device_id
    ? <ApprovedLedger key={device_id} deviceId={device_id} online={state === "online"}>{children}</ApprovedLedger> : children;
}

function ApprovedLedger({ children, deviceId, online }: { children: ReactNode; deviceId: string; online: boolean }) {
  const [ledger, setLedger] = useState<SharedLedger | null>(null);
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const current = useRef<SharedLedger | null>(null);
  const verifyNow = useRef(() => {});
  useEffect(() => {
    let alive = true;
    let busy = false;
    const library = import("@/lib/shared-ledger");
    const verify = async () => {
      if (busy || !alive || document.visibilityState !== "visible" ||
          (!current.current && document.querySelector('[role="dialog"][aria-modal="true"]'))) return;
      busy = true;
      let expected = false;
      try {
        const service = await library;
        if (!alive) return;
        expected = Boolean(service.previousSharedLedger());
        if (!online) throw new Error("Connect to the home network to sync the ledger.");
        const latest = await service.reconcileLedger(deviceId, current.current ?? undefined);
        if (!alive) return;
        const old = current.current;
        current.current = latest;
        if (latest?.id !== old?.id) {
          setSharedDatabase(latest ? service.getSharedDb : null);
          setLedger(latest);
        } else if (old && latest && latest.revision !== old.revision) {
          window.dispatchEvent(new Event("ffyon-ledger-data-changed"));
        }
        setBlocked(false);
        setError("");
      } catch (cause) {
        if (alive) {
          setBlocked(expected && !current.current);
          setError(cause instanceof Error ? cause.message : "Could not sync the ledger.");
        }
      } finally {
        busy = false;
        if (alive) setReady(true);
      }
    };
    const run = () => void verify();
    verifyNow.current = run;
    run();
    const timer = window.setInterval(run, 4000);
    window.addEventListener("focus", run);
    window.addEventListener("online", run);
    window.addEventListener("ffyon-ledger-refresh", run);
    document.addEventListener("visibilitychange", run);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", run);
      window.removeEventListener("online", run);
      window.removeEventListener("ffyon-ledger-refresh", run);
      document.removeEventListener("visibilitychange", run);
    };
  }, [deviceId, online]);

  useEffect(() => () => {
    setSharedDatabase(null);
    void import("@/lib/shared-ledger").then(service => service.resetSharedLedger());
  }, []);

  if (!ready || blocked) return <main className="pwa-locked flex h-full items-center justify-center p-6">
    <div className="max-w-lg">
      {blocked ? <>
        <h1 className="font-display text-2xl">Shared ledger unavailable</h1>
        <p role="alert" className="my-3 text-sm text-ink-2">{error}</p>
        <Button onClick={() => verifyNow.current()}>Retry connection</Button>
      </> : <p role="status" className="flex items-center gap-2 text-muted"><LoaderCircle size={17} className="animate-spin" /> Checking ledger</p>}
    </div>
  </main>;
  return <LedgerContext.Provider value={{ ledger, error, retry: () => verifyNow.current() }}>
    <div key={ledger?.id ?? "local"} className="h-full">{children}</div>
  </LedgerContext.Provider>;
}

export function LedgerStatus() {
  const { ledger, error, retry } = useSharedLedger();
  const [opened, setOpened] = useState(false);
  const [archive, setArchive] = useState<Backup | null>(null);
  const [archiveError, setArchiveError] = useState("");
  const review = ledger?.review;
  const count = review ? reviewCount(review) : 0;
  const show = async () => {
    setOpened(true);
    setArchiveError("");
    try { setArchive(await exportAll(await getDeviceDb())); }
    catch { setArchiveError("Could not open the original records on this device."); }
  };
  if (!error && !count) return null;
  return <div className="mb-4 rounded-xl border border-line bg-surface p-3 text-sm" role="status">
    {error && <div className="flex flex-wrap items-center gap-2">
      <AlertCircle size={16} className="text-bad" /><p>{error}</p>
      <Button size="sm" onClick={retry}>Retry sync</Button>
    </div>}
    {count > 0 && <div className="flex flex-wrap items-center gap-2">
      <AlertCircle size={16} className="text-ink-2" />
      <p>{count} earlier {count === 1 ? "record needs" : "records need"} review. The originals are kept on this device.</p>
      <Button size="sm" onClick={() => void show()}>Review records</Button>
    </div>}
    <Modal open={opened} onClose={() => setOpened(false)} title="Earlier records to review">
      <p className="text-sm text-ink-2">Check these against the shared ledger before adding them. Some may be earlier copies of changes or deletions.</p>
      {archiveError && <p role="alert" className="mt-3 text-sm text-bad">{archiveError}</p>}
      {!archive && !archiveError && <p className="mt-3 text-sm text-muted">Loading records…</p>}
      {archive && review && <ul className="mt-3 divide-y divide-line text-sm">
        {archive.transactions.filter(row => review.entries.includes(row.id)).map(row => <li key={`entry-${row.id}`} className="py-3">
          <strong>{row.type === "income" ? "Income" : "Expense"} · {money(row.amount_pence)} · {ukDate(row.date)}</strong>
          <p className="break-words">{row.description || row.service_name || row.category_name_snapshot}</p>
        </li>)}
        {archive.clients.filter(row => review.clients.includes(row.id)).map(row => <li key={`client-${row.id}`} className="py-3">
          <strong>Client note · {row.name}</strong><p className="whitespace-pre-wrap break-words select-text">{row.notes}</p>
        </li>)}
        {(archive.appointments ?? []).filter(row => review.appointments.includes(row.id)).map(row => <li key={`appointment-${row.id}`} className="py-3">
          <strong>Appointment note · {ukDate(row.date)} · {row.start_time}</strong><p className="whitespace-pre-wrap break-words select-text">{row.notes}</p>
        </li>)}
      </ul>}
    </Modal>
  </div>;
}
