import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Check, Copy, Download, KeyRound, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { checkAccess, connectOwner, getAccessStatus, isPwa, onAccessChanged, pairDevice, prepareOwnerConnection, type AccessStatus } from "@/lib/access";
import { checkForUpdate } from "@/lib/update";
import { quitApp } from "@/lib/tray";
import { Button, Card, ErrorText, Field, Input, Loading, Segmented } from "./ui";
import { BrandLogo } from "./BrandLogo";

const locked: AccessStatus = { state: "checking", device_id: null, device_name: null, expires_at: null, error: null };
const AccessContext = createContext<AccessStatus>(locked);
export const useAccess = () => useContext(AccessContext);

export function AccessGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AccessStatus>(locked);
  useEffect(() => {
    let alive = true;
    let checking = false;
    let lastCheck = -Infinity;
    let unsubscribe: (() => void) | undefined;
    const apply = (next: AccessStatus) => { if (alive) setStatus(next); };
    onAccessChanged(apply).then((off) => { if (alive) unsubscribe = off; else off(); }).catch(() => {});
    const verify = async (force = false) => {
      if (!alive || checking || (!force && Date.now() - lastCheck < 1000)) return;
      checking = true;
      lastCheck = Date.now();
      try { apply(await checkAccess()); }
      catch (e) { apply({ ...locked, state: "locked", error: e instanceof Error ? e.message : "Could not verify this computer" }); }
      finally { checking = false; }
    };
    getAccessStatus().then((next) => { apply(next); return verify(); }).catch(() => verify());
    const foreground = () => { if (document.visibilityState === "visible") void verify(); };
    const reconnect = () => { if (document.visibilityState === "visible") void verify(true); };
    const timer = setInterval(foreground, 2 * 60_000);
    window.addEventListener("focus", foreground);
    window.addEventListener("online", reconnect);
    if (isPwa()) window.addEventListener("offline", reconnect);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      alive = false;
      unsubscribe?.();
      clearInterval(timer);
      window.removeEventListener("focus", foreground);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("offline", reconnect);
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
  const webApp = isPwa();
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
  return <main className={webApp ? "pwa-locked h-full overflow-y-auto bg-page" : "flex h-full min-h-[600px] items-center justify-center overflow-y-auto bg-page px-6 py-10"}>
    <div className="mx-auto w-full max-w-md">
      <div className="mb-8"><BrandLogo /></div>
      <Card className="p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <ShieldCheck size={22} className="mt-1.5 shrink-0 text-rose-ink" aria-hidden />
          <div className="min-w-0"><h1 className="font-display text-title">Admin access required</h1><p className="mt-1 text-small text-ink-2">This {webApp ? "device" : "computer"} needs approval before opening your business records.</p></div>
        </div>
        {status.state === "checking" ? <Loading label="Checking this device" className="px-0" /> : <>
          {(error ?? status.error) && <ErrorText className="mt-4">{error ?? status.error}</ErrorText>}
          {(status.device_id || (webApp && status.error)) && <Button className="mt-4" disabled={busy} onClick={retry}><RefreshCw size={16} aria-hidden /> Verify connection</Button>}
          {!webApp && <div className="mt-5"><Segmented label="How to connect" className="w-full" value={mode} onChange={setMode} options={[{ value: "pair", label: "Pair device" }, { value: "owner", label: "Set up first admin" }]} /></div>}
          <form onSubmit={pairing} className="mt-5 space-y-4">
            <Field label={webApp ? "Device name" : "Computer name"}><Input autoComplete="off" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder={webApp ? "e.g. Salon iPhone" : "e.g. Salon Mac"} disabled={busy || !!setup} /></Field>
            {mode === "pair" ? <>
              <Field label="Pairing code" hint="Get a ten-minute code from Settings, This device, on a computer that is already approved."><Input autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={18} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX" disabled={busy} className="tabular font-mono" /></Field>
              <Button type="submit" variant="primary" className="w-full" disabled={busy || !name.trim() || code.replace(/[\s-]/g, "").length !== 12}>{busy ? <LoaderCircle size={16} className="animate-spin" aria-hidden /> : <KeyRound size={16} aria-hidden />} Pair device</Button>
            </> : <>
              {!setup ? <Button type="button" variant="primary" className="w-full" disabled={busy || !name.trim()} onClick={() => run(async () => setSetup(await prepareOwnerConnection(name.trim())))}><KeyRound size={16} aria-hidden /> Generate setup values</Button> : <>
                <p className="text-small text-ink-2">In the trusted Sites project configuration, set these runtime secrets, then verify this connection.</p>
                <SetupValue label="FFYON_BOOTSTRAP_DEVICE_ID" value={setup.device_id} />
                <SetupValue label="FFYON_BOOTSTRAP_TOKEN_HASH" value={setup.token_hash} />
                <Button type="button" variant="primary" className="w-full" disabled={busy} onClick={() => run(async () => onStatus(await connectOwner()))}>{busy ? <LoaderCircle size={16} className="animate-spin" aria-hidden /> : <Check size={16} aria-hidden />} Verify connection</Button>
              </>}
              <p className="text-small text-ink-2">Only the site owner can set up the first admin, or recover access when every approved device is lost.</p>
            </>}
          </form>
          <p className="mt-5 border-t border-line pt-4 text-small text-ink-2">{webApp
            ? "On iPhone, add this page to your Home Screen in Safari, then open it from the new icon before pairing."
            : "Windows stores the credential in Credential Manager. macOS uses Keychain and may ask you to allow access. This computer stays locked if secure storage is unavailable."}</p>
        </>}
      </Card>
      {!webApp && <div className="mt-4 flex items-center justify-between gap-3">
        <Button variant="ghost" disabled={busy} onClick={() => run(async () => { await checkForUpdate(false); })}><Download size={16} aria-hidden /> Check for updates</Button>
        <Button variant="ghost" onClick={() => void quitApp()}>Quit</Button>
      </div>}
    </div>
  </main>;
}

function SetupValue({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-line bg-surface-2/50 p-3">
    <div className="flex items-center justify-between gap-2"><span className="min-w-0 break-all font-mono text-label text-ink-2">{label}</span><Button type="button" variant="ghost" size="sm" aria-label={`Copy ${label}`} title={`Copy ${label}`} onClick={async () => { try { await navigator.clipboard.writeText(value); toast.success("Setup value copied"); } catch { toast.error("Select the setup value to copy it"); } }}><Copy size={14} aria-hidden /> Copy</Button></div>
    <code className="mt-1 block select-text break-all text-small">{value}</code>
  </div>;
}
