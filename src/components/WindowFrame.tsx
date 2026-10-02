import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { toast } from "sonner";
import { isDesktop } from "@/lib/access";

/** Window chrome lives outside authorization, so even the lock screen can be moved or closed. */
export function WindowFrame({ children }: { children: ReactNode }) {
  const desktop = isDesktop();
  const mac = navigator.userAgent.includes("Mac");
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    if (!desktop) return;
    const appWindow = getCurrentWindow();
    let disposed = false;
    const unlisten: (() => void)[] = [];
    const updateMaximized = async () => {
      const value = await appWindow.isMaximized();
      if (!disposed) setMaximized(value);
    };
    const keep = (stop: () => void) => disposed ? stop() : unlisten.push(stop);
    void updateMaximized().catch(console.error);
    void appWindow.isFocused().then(value => { if (!disposed) setFocused(value); }).catch(console.error);
    void appWindow.onResized(() => { void updateMaximized().catch(console.error); }).then(keep).catch(console.error);
    void appWindow.onFocusChanged(({ payload }) => { if (!disposed) setFocused(payload); }).then(keep).catch(console.error);
    return () => { disposed = true; unlisten.forEach(stop => stop()); };
  }, [desktop]);

  if (!desktop) return <>{children}</>;

  const run = (action: () => Promise<void>) => {
    void action().catch(() => toast.error("Could not change the window. Please try again."));
  };
  const toggleMaximize = async () => {
    await getCurrentWindow().toggleMaximize();
    setMaximized(await getCurrentWindow().isMaximized());
  };

  return <div className="window-frame" data-platform={mac ? "mac" : "desktop"}>
    <header className="window-titlebar" aria-label="Window title bar" data-focused={focused}>
      <div className="window-drag-region" onMouseDown={event => {
        if (event.button !== 0) return;
        run(event.detail === 2 ? toggleMaximize : () => getCurrentWindow().startDragging());
      }}>
      </div>
      {!mac && <div className="window-controls">
        <button type="button" className="window-control" aria-label="Minimize window" title="Minimize" onClick={() => run(() => getCurrentWindow().minimize())}><Minus size={14} aria-hidden /></button>
        <button type="button" className="window-control" aria-label={maximized ? "Restore window" : "Maximize window"} title={maximized ? "Restore" : "Maximize"} onClick={() => run(toggleMaximize)}>{maximized ? <Copy size={12} aria-hidden /> : <Square size={12} aria-hidden />}</button>
        {/* close() follows the existing close-to-tray / ask / quit preference. */}
        <button type="button" className="window-control window-close" aria-label="Close window" title="Close" onClick={() => run(() => getCurrentWindow().close())}><X size={16} aria-hidden /></button>
      </div>}
    </header>
    <div className="window-content">{children}</div>
  </div>;
}
