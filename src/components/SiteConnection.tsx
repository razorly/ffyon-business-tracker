import { useEffect, useState } from "react";
import { Copy, KeyRound, RefreshCw, Trash2, Unplug } from "lucide-react";
import { toast } from "sonner";
import { checkAccess, disconnectDevice, isPwa } from "@/lib/access";
import { createPairingCode, listDevices, retryPendingMutation, revokeDevice, syncNow, type Device } from "@/lib/sync";
import { useData, useLoad } from "@/lib/data";
import { useAccess } from "./AccessGate";
import { Actions, Button, Card, CardHeader, ConfirmModal, ErrorText, LoadError, Modal } from "./ui";
import { Help, SubHeading } from "./settings/parts";

const seen = (value: string | number) => new Date(value).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** Whether this device is connected, which devices may open the tracker, and adding or removing one. */
export function SiteConnection() {
  const webApp = isPwa();
  const deviceLabel = webApp ? "device" : "computer";
  const access = useAccess();
  const { refresh } = useData();
  const [devices, loading, loadError] = useLoad(() => access.state === "online" ? listDevices() : Promise.resolve([]), [access.state], []);
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
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't update the connection. Try again."); }
    finally { setBusy(false); }
  };
  const expiry = pairing ? typeof pairing.expires_at === "number" ? pairing.expires_at * 1000 : Date.parse(pairing.expires_at) : 0;
  const expired = pairing != null && now >= expiry;
  const code = pairing?.code.replace(/-/g, "").match(/.{1,4}/g)?.join("-") ?? "";
  const online = access.state === "online";
  return <Card>
    <CardHeader title="Connection" subtitle={access.device_name || `Approved ${deviceLabel}`} />
    <div className="space-y-4 px-5 pb-5">
      <LoadError error={loadError} onRetry={refresh} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-medium"><span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-good" : "bg-line-strong"}`} />{online ? "Connected to Tanned by Ffy" : "Working offline"}</p>
          {access.expires_at && <Help className="tabular">Works offline until {seen(access.expires_at * 1000)}</Help>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void run(async () => { const status = await checkAccess(); if (status.state === "online") { await retryPendingMutation(); await syncNow({ full: true }); refresh(); toast.success("Connection checked"); } else throw new Error(status.error || "Could not reach the site"); })}><RefreshCw size={16} aria-hidden /> Check connection</Button>
          <Button disabled={busy || !online} variant="primary" onClick={() => void run(async () => { setPairing(await createPairingCode()); setNow(Date.now()); })}><KeyRound size={16} aria-hidden /> Add a device</Button>
        </div>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
      <div className="border-t border-line pt-4">
        <SubHeading>Devices that can open the tracker</SubHeading>
        {loading ? <Help className="mt-1">Loading devices…</Help> : !online ? <Help className="mt-1">Reconnect to see and remove devices.</Help> : <ul className="mt-1 divide-y divide-line">
          {devices.map((device) => <li key={device.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="break-words font-medium">{device.name}</p>
              <p className="tabular text-small text-ink-2">{device.id === access.device_id && `This ${deviceLabel} · `}{device.revoked_at ? "Access removed" : device.last_seen_at ? `Last used ${seen(device.last_seen_at)}` : "Not used yet"}</p>
            </div>
            {!device.revoked_at && <Button variant="ghost" size="icon" className="shrink-0" title={`Remove ${device.name}`} aria-label={`Remove ${device.name}`} disabled={busy} onClick={() => setRevoke(device)}><Trash2 size={18} aria-hidden /></Button>}
          </li>)}
        </ul>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <Help className="min-w-0 flex-[1_1_14rem]">{webApp ? "This app checks it is still approved each time it opens your records." : "Each device needs its own approval, even after restoring a backup."}</Help>
        <Button className="shrink-0" disabled={busy} onClick={() => setDisconnect(true)}><Unplug size={16} aria-hidden /> Disconnect</Button>
      </div>
    </div>
    <Modal open={!!pairing} onClose={() => setPairing(null)} title="Add a device" width="max-w-sm">
      <p className="text-ink-2">On the new device, choose Pair device and type in this code.</p>
      <div className="my-4 flex items-center justify-between gap-2 rounded-xl bg-surface-2 py-2 pl-4 pr-2">
        <code className="tabular min-w-0 break-all font-sans text-heading font-semibold">{code}</code>
        <Button variant="ghost" size="icon" disabled={expired} title="Copy pairing code" aria-label="Copy pairing code" onClick={async () => { try { await navigator.clipboard.writeText(code); toast.success("Pairing code copied"); } catch { toast.error("Select the code to copy it"); } }}><Copy size={18} aria-hidden /></Button>
      </div>
      <Help>{expired ? "This code has run out. Close this and make another." : `Works once. Runs out in ${Math.max(0, Math.ceil((expiry - now) / 60_000))} minutes.`}</Help>
      <Actions className="mt-4"><Button variant="primary" onClick={() => setPairing(null)}>Done</Button></Actions>
    </Modal>
    <ConfirmModal open={!!revoke} onClose={() => setRevoke(null)} title="Remove this device?" confirmLabel="Remove" message={<>{revoke?.name} will lose access the next time it connects, or when its offline access runs out.</>} onConfirm={() => { if (revoke) void run(async () => { await revokeDevice(revoke.id); refresh(); if (revoke.id === access.device_id) await checkAccess(); toast.success("Device removed"); }); }} />
    <ConfirmModal open={disconnect} onClose={() => setDisconnect(false)} title={`Disconnect this ${deviceLabel}?`} confirmLabel="Disconnect" message={`Your records stay on this ${deviceLabel}. Pair it again to reopen the tracker.`} onConfirm={() => { void run(async () => { await disconnectDevice(); }); }} />
    {busy && <span className="sr-only" role="status">Working</span>}
  </Card>;
}
