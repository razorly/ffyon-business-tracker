import { useEffect } from "react";
import { useData } from "@/lib/data";
import { getSyncState, syncNow } from "@/lib/sync";
import { useAccess } from "./AccessGate";

export function SyncBridge() {
  const { refresh } = useData();
  const { state } = useAccess();
  useEffect(() => {
    if (state !== "online") return;
    let alive = true;
    let running = false;
    const pull = async () => {
      if (running || document.visibilityState !== "visible") return;
      running = true;
      const cursor = getSyncState().cursor;
      try {
        const next = await syncNow();
        if (alive && (cursor == null || next.cursor !== cursor)) refresh();
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
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", foreground);
      window.removeEventListener("online", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [state, refresh]);
  return null;
}
