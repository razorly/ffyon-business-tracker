import { useEffect } from "react";
import { useData } from "@/lib/data";
import { getSyncState, subscribeSync, syncNow } from "@/lib/sync";
import { useAccess } from "./AccessGate";

export function SyncBridge() {
  const { refresh } = useData();
  const { state } = useAccess();
  useEffect(() => {
    if (state !== "online") return;
    let running = false;
    let lastPull = -Infinity;
    let previous = getSyncState();
    const unsubscribe = subscribeSync(next => {
      if (next.state !== "synced") return;
      if (next.cursor !== previous.cursor || next.last_full_sync_at !== previous.last_full_sync_at) refresh();
      previous = next;
    });
    const pull = async (force = false) => {
      if (running || document.visibilityState !== "visible" || (!force && Date.now() - lastPull < 1000)) return;
      running = true;
      lastPull = Date.now();
      try {
        await syncNow();
      } catch { /* The connection status shows background failures. */ }
      finally { running = false; }
    };
    void pull();
    const foreground = () => void pull();
    const reconnect = () => void pull(true);
    const timer = setInterval(foreground, 2 * 60_000);
    window.addEventListener("focus", foreground);
    window.addEventListener("online", reconnect);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener("focus", foreground);
      window.removeEventListener("online", reconnect);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [state, refresh]);
  return null;
}
