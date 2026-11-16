import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { disablePwaPush, enablePwaPush, getPwaPush } from "@/lib/pwa-access";
import { Button, Card, CardHeader } from "./ui";

function installed() {
  return Boolean((navigator as Navigator & { standalone?: boolean }).standalone) || matchMedia("(display-mode: standalone)").matches;
}

function decodeKey(key: string) {
  const base64 = key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error("The push settings returned an invalid key.");
  return bytes;
}

async function activeWorker() {
  await navigator.serviceWorker.register("/sw.js");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("The notification worker did not start. Reopen the app and try again.")), 8000); }),
    ]);
  } finally { clearTimeout(timer); }
}

interface State {
  manager: PushManager;
  key: Uint8Array<ArrayBuffer>;
  subscription: PushSubscription | null;
  enabled: boolean;
}

export function PushNotifications() {
  const standalone = installed();
  const available = window.isSecureContext && "serviceWorker" in navigator && "Notification" in window;
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!standalone || !available) return;
    let alive = true;
    void Promise.all([activeWorker(), getPwaPush()]).then(async ([registration, status]) => {
      const manager = registration.pushManager;
      if (!manager) throw new Error("This iPhone needs an iOS update to use push notifications.");
      const subscription = await manager.getSubscription();
      const key = decodeKey(status.public_key);
      if (alive) setState({ manager, key, subscription, enabled: status.enabled });
    }).catch(cause => {
      if (alive) setError(cause instanceof Error ? cause.message : "Could not load notification settings.");
    });
    return () => { alive = false; };
  }, [standalone, available, reload]);

  const enable = async () => {
    if (!state || busy) return;
    setBusy(true);
    setError("");
    try {
      // Invoke subscribe from the button gesture. Safari requires a direct user interaction.
      const subscription = state.subscription ?? await state.manager.subscribe({
        userVisibleOnly: true, applicationServerKey: state.key,
      });
      setState({ ...state, subscription });
      const status = await enablePwaPush(subscription.toJSON());
      setState({ ...state, subscription, enabled: status.enabled });
    } catch (cause) {
      setError(Notification.permission === "denied"
        ? "Allow notifications for Tanned by Ffy in your iPhone notification settings."
        : cause instanceof Error ? cause.message : "Could not enable notifications.");
    } finally { setBusy(false); }
  };

  const disable = async () => {
    if (!state || busy) return;
    setBusy(true);
    setError("");
    try {
      await disablePwaPush();
      await state.subscription?.unsubscribe().catch(() => {});
      setState({ ...state, enabled: false, subscription: await state.manager.getSubscription() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disable notifications.");
    } finally { setBusy(false); }
  };

  return <Card>
    <CardHeader title="Push notifications" subtitle="Booking requests, payments to confirm and new Mail" action={<Bell size={18} className="text-rose" />} />
    <div className="space-y-3 px-5 pb-5 text-sm">
      {!standalone ? <p className="text-muted">Add the tracker to your Home Screen in Safari and open it from the icon to enable alerts.</p> :
        !available ? <p className="text-muted">Push notifications require iOS 16.4 or later and a trusted HTTPS connection.</p> :
        state ? <>
          <p className="text-ink-2">{state.enabled && state.subscription && Notification.permission === "granted"
            ? "Alerts are enabled on this iPhone." : "Enable alerts to receive updates while the app is closed."}</p>
          {state.enabled ? <Button disabled={busy} onClick={() => void disable()}>Disable push notifications</Button> :
            <Button variant="primary" disabled={busy} onClick={() => void enable()}>Enable push notifications</Button>}
        </> : error ? <Button size="sm" onClick={() => { setError(""); setReload(value => value + 1); }}>Retry</Button> :
          <p role="status" className="text-muted">Checking notification settings…</p>}
      {error && <p role="alert" className="break-words text-bad">{error}</p>}
    </div>
  </Card>;
}
