import { useEffect, useState } from "react";
import { Check, Copy, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, Trash2, Unplug } from "lucide-react";
import { toast } from "sonner";
import { checkAccess, disconnectDevice } from "@/lib/access";
import { createPairingCode, listDevices, retryPendingMutation, revokeDevice, syncNow, type Device } from "@/lib/sync";
import { useData, useLoad } from "@/lib/data";
import { useAccess } from "./AccessGate";
import { Button, Card, CardHeader, ConfirmModal, Modal } from "./ui";

export function SiteConnection() {
  const access = useAccess();
  const { refresh } = useData();
  const [devices, loading] = useLoad(() => access.state === "online" ? listDevices() : Promise.resolve([]), [access.state], []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expires_at: string | number } | null>(null);
  const [revoke, setRevoke] = useState<Device | null>(null);
  const [disconnect, setDisconnect] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!pairing) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [pairing]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not update the connection"); }
    finally { setBusy(false); }
  };
  const expiry = pairing ? typeof pairing.expires_at === "number" ? pairing.expires_at * 1000 : Date.parse(pairing.expires_at) : 0;
  const expired = pairing != null && now >= expiry;
  const code = pairing?.code.replace(/-/g, "").match(/.{1,4}/g)?.join("-") ?? "";
  return <Card className="min-w-0 lg:col-span-2">
    <CardHeader title="Site Connection" subtitle={access.device_name || "Approved computer"} action={<ShieldCheck size={19} className="text-good" />} />
    <div className="space-y-4 px-5 pb-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm"><span className={access.state === "online" ? "text-good" : "text-ink-2"}>{access.state === "online" ? "Connected to Tanned by Ffy" : "Offline access"}</span><p className="mt-1 break-all text-xs text-muted">ffyon-customer.razorly.chatgpt.site</p>{access.expires_at && <p className="mt-1 text-xs text-muted">Offline access until {new Date(access.expires_at * 1000).toLocaleString("en-GB")}</p>}</div>
        <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void run(async () => { const status = await checkAccess(); if (status.state === "online") { await retryPendingMutation(); await syncNow(); refresh(); toast.success("Connection verified"); } else throw new Error(status.error || "Could not reach the site"); })}><RefreshCw size={14} /> Verify Connection</Button><Button disabled={busy || access.state !== "online"} variant="primary" onClick={() => void run(async () => { setPairing(await createPairingCode()); setNow(Date.now()); })}><KeyRound size={14} /> Add Device</Button></div>
      </div>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      <div className="border-t border-line pt-3">
        <h4 className="eyebrow mb-2 text-ink-2">Approved computers</h4>
        {loading ? <p className="text-sm text-muted">Loading devices</p> : access.state !== "online" ? <p className="text-sm text-muted">Reconnect to manage approved computers.</p> : <ul className="divide-y divide-line">
          {devices.map((device) => <li key={device.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0"><p className="break-words text-sm font-medium">{device.name}{device.id === access.device_id && <span className="ml-2 text-xs font-normal text-muted">This computer</span>}</p><p className="mt-0.5 text-xs text-muted">{device.revoked_at ? "Revoked" : device.last_seen_at ? `Last connected ${new Date(device.last_seen_at).toLocaleString("en-GB")}` : "Not connected yet"}</p></div>
            {!device.revoked_at && <Button variant="ghost" size="icon" className="shrink-0" title={`Revoke ${device.name}`} aria-label={`Revoke ${device.name}`} disabled={busy} onClick={() => setRevoke(device)}><Trash2 size={15} /></Button>}
          </li>)}
        </ul>}
      </div>
      <div className="flex flex-col items-start justify-between gap-3 border-t border-line pt-3 sm:flex-row sm:items-center"><p className="min-w-0 text-xs text-muted">Credential Manager on Windows; Keychain on macOS. Restoring a backup on another computer requires pairing.</p><Button variant="ghost" className="shrink-0" disabled={busy} onClick={() => setDisconnect(true)}><Unplug size={14} /> Disconnect</Button></div>
    </div>
    <Modal open={!!pairing} onClose={() => setPairing(null)} title="Pair another computer" width="max-w-sm">
      <p className="text-sm text-ink-2">On the new computer, select Pair Device and enter this code.</p>
      <div className="my-5 flex items-center justify-between gap-2 rounded-lg bg-surface-2 p-4"><code className="min-w-0 break-all text-[22px]">{code}</code><Button variant="ghost" size="icon" disabled={expired} title="Copy pairing code" aria-label="Copy pairing code" onClick={async () => { try { await navigator.clipboard.writeText(code); toast.success("Pairing code copied"); } catch { toast.error("Select the code to copy it"); } }}><Copy size={15} /></Button></div>
      <p className="text-xs text-muted">{expired ? "Code expired. Close this window and create another." : `Single use. Expires in ${Math.max(0, Math.ceil((expiry - now) / 60_000))} minutes.`}</p>
      <div className="mt-5 flex justify-end"><Button onClick={() => setPairing(null)}><Check size={14} /> Done</Button></div>
    </Modal>
    <ConfirmModal open={!!revoke} onClose={() => setRevoke(null)} title="Revoke this computer?" confirmLabel="Revoke" message={<>{revoke?.name} will lose access when it reconnects, or when its offline authorization expires.</>} onConfirm={() => { if (revoke) void run(async () => { await revokeDevice(revoke.id); refresh(); if (revoke.id === access.device_id) await checkAccess(); toast.success("Device revoked"); }); }} />
    <ConfirmModal open={disconnect} onClose={() => setDisconnect(false)} title="Disconnect this computer?" confirmLabel="Disconnect" message="Your local records stay on this computer. Pair it again to reopen the tracker." onConfirm={() => { void run(async () => { await disconnectDevice(); }); }} />
    {busy && <span className="sr-only" role="status"><LoaderCircle size={16} /> Working</span>}
  </Card>;
}
