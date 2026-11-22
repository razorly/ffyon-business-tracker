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
    let previous = getSyncState();
    const unsubscribe = subscribeSync(next => {
      if (next.state !== "synced") return;
      if (next.cursor !== previous.cursor || next.last_full_sync_at !== previous.last_full_sync_at) refresh();
      previous = next;
    });
    const pull = async () => {
      if (running || document.visibilityState !== "visible") return;
      running = true;
      try {
        await syncNow();
      } catch { /* The connection status shows background failures. */ }
      finally { running = false; }
    };
    void pull();
    const timer = setInterval(() => void pull(), 15_000);
    const foreground = () => void pull();
    window.addEventListener("focus", foreground);
    window.addEventListener("online", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener("focus", foreground);
      window.removeEventListener("online", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [state, refresh]);
  return null;
}
