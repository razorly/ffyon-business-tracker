import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Check, Copy, Download, KeyRound, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { checkAccess, connectOwner, getAccessStatus, onAccessChanged, pairDevice, prepareOwnerConnection, type AccessStatus } from "@/lib/access";
import { checkForUpdate } from "@/lib/update";
import { quitApp } from "@/lib/tray";
import { Button, Field, Input, Segmented } from "./ui";

const locked: AccessStatus = { state: "checking", device_id: null, device_name: null, expires_at: null, error: null };
const AccessContext = createContext<AccessStatus>(locked);
export const useAccess = () => useContext(AccessContext);

export function AccessGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AccessStatus>(locked);
  useEffect(() => {
    let alive = true;
    let checking = false;
    let unsubscribe: (() => void) | undefined;
    const apply = (next: AccessStatus) => { if (alive) setStatus(next); };
    onAccessChanged(apply).then((off) => { if (alive) unsubscribe = off; else off(); }).catch(() => {});
    const verify = async () => {
      if (checking) return;
      checking = true;
      try { apply(await checkAccess()); }
      catch (e) { apply({ ...locked, state: "locked", error: e instanceof Error ? e.message : "Could not verify this computer" }); }
      finally { checking = false; }
    };
    getAccessStatus().then((next) => { apply(next); return verify(); }).catch(() => verify());
    const foreground = () => { if (document.visibilityState === "visible") void verify(); };
    const timer = setInterval(foreground, 15_000);
    window.addEventListener("focus", foreground);
    window.addEventListener("online", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      alive = false;
      unsubscribe?.();
      clearInterval(timer);
      window.removeEventListener("focus", foreground);
      window.removeEventListener("online", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, []);

  const authorized = status.state === "online" || status.state === "offline";
  useEffect(() => { if (!authorized) toast.dismiss(); }, [authorized]);
  return <AccessContext.Provider value={status}>
    {authorized ? <div key={status.device_id ?? "authorized"} className="h-full">{children}</div> : <LockedScreen status={status} onStatus={setStatus} />}
  </AccessContext.Provider>;
}

function LockedScreen({ status, onStatus }: { status: AccessStatus; onStatus: (value: AccessStatus) => void }) {
  const [mode, setMode] = useState<"pair" | "owner">("pair");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<{ device_id: string; token_hash: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not connect this computer"); }
    finally { setBusy(false); }
  };
  const retry = () => run(async () => onStatus(await checkAccess()));
  const pairing = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => onStatus(await pairDevice(code.replace(/[\s-]/g, "").toUpperCase(), name.trim())));
  };
  return <main className="flex h-full min-h-[600px] items-center justify-center overflow-y-auto bg-page px-6 py-10">
    <div className="w-full max-w-lg">
      <div className="mb-8 text-center">
        <div className="font-display text-[48px] leading-none">Ffyon</div>
        <div className="eyebrow mt-3 text-muted">Business Tracker</div>
      </div>
      <div className="flex items-center gap-3 border-b border-line pb-4">
        <ShieldCheck size={24} className="shrink-0 text-rose" />
        <div><h1 className="font-display text-[25px]">Admin access required</h1><p className="mt-1 text-sm text-ink-2">This computer needs approval before opening your business records.</p></div>
      </div>
      {status.state === "checking" ? <div role="status" className="flex items-center gap-3 py-8 text-sm text-muted"><LoaderCircle size={18} className="animate-spin" /> Checking authorization</div> : <>
        {(error ?? status.error) && <p role="alert" className="mt-4 break-words text-sm text-bad">{error ?? status.error}</p>}
        {status.device_id && <Button className="mt-4" disabled={busy} onClick={retry}><RefreshCw size={15} /> Verify Connection</Button>}
        <div className="mt-6"><Segmented value={mode} onChange={setMode} options={[{ value: "pair", label: "Pair Device" }, { value: "owner", label: "Set Up First Admin" }]} /></div>
        <form onSubmit={pairing} className="mt-5 space-y-4">
          <Field label="Computer name"><Input autoComplete="off" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Salon Mac" disabled={busy || !!setup} /></Field>
          {mode === "pair" ? <>
            <Field label="Pairing code" hint="Get a ten-minute code from Settings > Site Connection on an approved computer."><Input autoComplete="off" spellCheck={false} maxLength={18} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX" disabled={busy} className="font-mono" /></Field>
            <Button type="submit" variant="primary" disabled={busy || !name.trim() || code.replace(/[\s-]/g, "").length !== 12}>{busy ? <LoaderCircle size={15} className="animate-spin" /> : <KeyRound size={15} />} Pair Device</Button>
          </> : <>
            {!setup ? <Button type="button" variant="primary" disabled={busy || !name.trim()} onClick={() => run(async () => setSetup(await prepareOwnerConnection(name.trim())))}><KeyRound size={15} /> Generate setup values</Button> : <>
              <p className="text-sm text-ink-2">In the trusted Sites project configuration, set these runtime secrets, then verify this connection.</p>
              <SetupValue label="FFYON_BOOTSTRAP_DEVICE_ID" value={setup.device_id} />
              <SetupValue label="FFYON_BOOTSTRAP_TOKEN_HASH" value={setup.token_hash} />
              <Button type="button" variant="primary" disabled={busy} onClick={() => run(async () => onStatus(await connectOwner()))}>{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />} Verify Connection</Button>
            </>}
            <p className="text-xs text-muted">Only the site owner can configure first-admin access or recover access when all approved devices are lost.</p>
          </>}
        </form>
        <p className="mt-6 border-t border-line pt-4 text-xs text-muted">Windows stores the credential in Credential Manager. macOS uses Keychain and may ask you to allow access. This computer stays locked if secure storage is unavailable.</p>
      </>}
      <div className="mt-6 flex items-center justify-between gap-3">
        <Button variant="ghost" disabled={busy} onClick={() => run(async () => { await checkForUpdate(false); })}><Download size={14} /> Check for updates</Button>
        <Button variant="ghost" onClick={() => void quitApp()}>Quit</Button>
      </div>
    </div>
  </main>;
}

function SetupValue({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-line bg-surface p-3">
    <div className="flex items-center justify-between gap-2"><span className="min-w-0 break-all font-mono text-xs text-muted">{label}</span><Button type="button" variant="ghost" size="icon" aria-label={`Copy ${label}`} title={`Copy ${label}`} onClick={async () => { try { await navigator.clipboard.writeText(value); toast.success("Setup value copied"); } catch { toast.error("Select the setup value to copy it"); } }}><Copy size={14} /></Button></div>
    <code className="mt-1 block break-all text-sm select-text">{value}</code>
  </div>;
}
