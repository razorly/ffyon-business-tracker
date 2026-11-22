import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { isDesktop, isPwa } from "@/lib/access";
import { exportAll, getDeviceDb, setSharedDatabase, type Backup } from "@/lib/db";
import { money, ukDate } from "@/lib/format";
import { reviewCount, type LedgerReview } from "@/lib/ledger-merge";
import type { loadLedgerReview, resolveLedgerReview, SharedLedger } from "@/lib/shared-ledger";
import { syncNow } from "@/lib/sync";
import { Button, Card, ErrorText, Loading, Modal, Notice } from "./ui";
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
          if (latest.review !== old.review) setLedger(latest);
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

  if (!ready || blocked) return <main className="pwa-locked flex h-full items-center justify-center bg-page p-6">
    <div className="w-full max-w-md">
      {blocked ? <Card className="p-5 sm:p-6">
        <h1 className="font-display text-title">Your records aren't available yet</h1>
        <p className="mt-2 text-ink-2">Money and private notes are kept on your home network. Connect to it, then try again.</p>
        <details className="mt-2 text-small text-ink-2"><summary className="cursor-pointer">Show details</summary><span role="alert" className="break-words">{error}</span></details>
        <Button variant="primary" className="mt-4" onClick={() => verifyNow.current()}>Try again</Button>
      </Card> : <Loading label="Opening your records" className="justify-center" />}
    </div>
  </main>;
  return <LedgerContext.Provider value={{ ledger, error, retry: () => verifyNow.current() }}>
    <div key={ledger?.id ?? "local"} className="h-full">{children}</div>
  </LedgerContext.Provider>;
}

export function LedgerStatus() {
  const { ledger, error, retry } = useSharedLedger();
  const { device_id, state } = useAccess();
  const [opened, setOpened] = useState(false);
  const [archive, setArchive] = useState<Backup | null>(null);
  const [details, setDetails] = useState<Awaited<ReturnType<typeof loadLedgerReview>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const count = ledger ? reviewCount(ledger.review) : 0;

  const loadReview = async () => {
    if (!device_id || busy) return;
    setBusy(true);
    setDetails(null);
    setReviewError("");
    try {
      setArchive(await exportAll(await getDeviceDb()));
      if (state !== "online") return;
      const service = await import("@/lib/shared-ledger");
      await syncNow();
      setDetails(await service.loadLedgerReview(device_id));
    } catch (cause) { setReviewError(cause instanceof Error ? cause.message : "Could not open the earlier records."); }
    finally { setBusy(false); }
  };
  const resolve = async (kind: keyof LedgerReview, id: number, note?: Parameters<typeof resolveLedgerReview>[3]) => {
    if (!device_id || busy) return;
    setBusy(true);
    setReviewError("");
    try {
      const { resolveLedgerReview } = await import("@/lib/shared-ledger");
      const review = await resolveLedgerReview(device_id, kind, id, note);
      setDetails(current => current && { ...current, review });
      if (!reviewCount(review)) setOpened(false);
      toast.success(note ? "Private note saved" : "Review dismissed. The device copy was kept.");
    } catch (cause) { setReviewError(cause instanceof Error ? cause.message : "Could not save the review decision."); }
    finally { setBusy(false); }
  };

  if (!error && !count && !opened) return null;
  const review = details?.review ?? ledger?.review;
  const archiveClients = new Map(archive?.clients.map(row => [row.id, row]));
  const archiveAppointments = new Map(archive?.appointments?.map(row => [row.id, row]));
  const archiveEntries = new Map(archive?.transactions.map(row => [row.id, row]));
  const canResolve = !busy && state === "online";
  return <div>
    {error && <Notice tone="bad" action={<Button size="sm" onClick={retry}>Try again</Button>}>
      Couldn't reach your records just now. Money and private notes may be out of date.
      <details className="mt-1 text-ink-2"><summary className="cursor-pointer">Show details</summary><span className="break-words">{error}</span></details>
    </Notice>}
    {count > 0 && <Notice action={<Button size="sm" onClick={() => { setOpened(true); setArchive(null); void loadReview(); }}>Review records</Button>}>
      {count} earlier {count === 1 ? "record needs" : "records need"} a look. The originals are kept on this device.
    </Notice>}
    <Modal open={opened} onClose={() => { if (!busy) setOpened(false); }} title="Earlier records to review" width="max-w-lg">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-[1_1_14rem] text-small text-ink-2">These are copies from before the update. Dismissing one keeps the original on this device.</p>
        <Button size="sm" disabled={busy} onClick={() => void loadReview()}>Refresh</Button>
      </div>
      {reviewError && <ErrorText className="mt-3">{reviewError}</ErrorText>}
      {state !== "online" && <p className="mt-3 text-small text-ink-2">Connect to the home network to save or dismiss one.</p>}
      {!archive && busy && <Loading label="Loading records" className="px-0" />}
      {review && !reviewCount(review) && <p className="mt-3 text-ink-2">Everything has been reviewed.</p>}
      {archive && review && <ul className="mt-3 divide-y divide-line">
        {review.entries.map(id => {
          const row = archiveEntries.get(id);
          return <li key={`entry-${id}`} className="space-y-2 py-3">
            <strong className="block font-semibold">{row ? `${row.type === "income" ? "Income" : "Expense"} · ${money(row.amount_pence)} · ${ukDate(row.date)}` : "Earlier finance entry"}</strong>
            <p className="break-words text-small text-ink-2">{row ? row.description || row.service_name || row.category_name_snapshot : "The original entry is unavailable."}</p>
            <Button size="sm" disabled={!canResolve} onClick={() => void resolve("entries", id)}>Dismiss</Button>
          </li>;
        })}
        {(["clients", "appointments"] as const).flatMap(kind => review[kind].map(id => {
          const appointment = kind === "appointments" ? archiveAppointments.get(id) : undefined;
          const client = kind === "clients" ? archiveClients.get(id) : appointment?.client_id == null ? undefined : archiveClients.get(appointment.client_id);
          const text = kind === "clients" ? client?.notes : appointment?.notes;
          const matchedAppointment = appointment?.remote_id ? details?.appointments.get(appointment.remote_id) : undefined;
          const matchedClient = client?.remote_id ? details?.clients.get(client.remote_id) : undefined;
          const target = matchedAppointment ?? matchedClient;
          const title = kind === "clients" ? "Client note" : "Appointment note";
          return <li key={`${kind}-${id}`} className="space-y-2 py-3">
            <strong className="block font-semibold">{title}{client && ` · ${client.name}`}{appointment && ` · ${ukDate(appointment.date)}${appointment.time_confirmed ? ` · ${appointment.start_time}` : ""}`}</strong>
            <p className="select-text whitespace-pre-wrap break-words text-small">{text || "The original note is unavailable."}</p>
            {details && text && !matchedAppointment && appointment && <p className="text-small text-ink-2">No matching appointment was found in the Diary. {matchedClient ? "You can keep the note on the client’s profile." : "You can copy the note to keep it elsewhere."}</p>}
            {text && target && <div className="rounded-lg bg-surface-2 p-3 text-small text-ink-2">
              {matchedAppointment
                ? <p>Shared appointment · {matchedAppointment.client_name ?? "No client"} · {ukDate(matchedAppointment.date)}{matchedAppointment.time_confirmed ? ` · ${matchedAppointment.start_time}` : ""}</p>
                : <p>Client notes · {matchedClient?.name}</p>}
              {target.notes && <p className="mt-1 whitespace-pre-wrap break-words select-text">{target.notes}</p>}
            </div>}
            <div className="flex flex-wrap gap-2">
              {text && target && <Button size="sm" variant="primary" disabled={!canResolve} onClick={() => void resolve(kind, id, {
                table: matchedAppointment ? "appointments" : "clients", target, text, missingAppointmentId: matchedAppointment ? null : appointment?.remote_id,
              })}>{target.notes === text ? "Mark as reviewed" : matchedAppointment ? "Add to appointment note" : "Add to client notes"}</Button>}
              {text && <Button size="sm" onClick={async () => {
                try { await navigator.clipboard.writeText(text); toast.success("Private note copied"); }
                catch { setReviewError("Select the earlier note to copy it."); }
              }}>Copy note</Button>}
              <Button size="sm" disabled={!canResolve} onClick={() => void resolve(kind, id)}>Dismiss</Button>
            </div>
          </li>;
        }))}
      </ul>}
    </Modal>
  </div>;
}
