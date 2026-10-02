import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface AccessStatus {
  state: "locked" | "checking" | "online" | "offline";
  device_id: string | null;
  device_name: string | null;
  expires_at: number | null;
  error: string | null;
}

export const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const isBrowserFixture = () => import.meta.env.DEV && import.meta.env.VITE_FFYON_BROWSER_FIXTURE === "1";
const DESKTOP_REQUIRED = "Admin connection requires the installed desktop app. Open Tanned by Ffy on Windows or macOS.";

export async function getAccessStatus(): Promise<AccessStatus> {
  if (!isDesktop()) return { state: "locked", device_id: null, device_name: null, expires_at: null, error: DESKTOP_REQUIRED };
  return invoke("access_status");
}

async function nativeAccess<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new Error(DESKTOP_REQUIRED);
  return invoke<T>(command, args);
}

export const checkAccess = () => nativeAccess<AccessStatus>("access_check");
export const prepareOwnerConnection = (name: string) => nativeAccess<{ device_id: string; token_hash: string }>("access_prepare", { name });
export const connectOwner = () => nativeAccess<AccessStatus>("access_connect");
export const pairDevice = (code: string, name: string) => nativeAccess<AccessStatus>("access_pair", { code, name });
export const disconnectDevice = () => nativeAccess<AccessStatus>("access_disconnect");
export const onAccessChanged = (listener: (status: AccessStatus) => void): Promise<UnlistenFn> =>
  listen<AccessStatus>("app-access-changed", (event) => listener(event.payload));

export async function requireLocalAccess() {
  if (isBrowserFixture() && !isDesktop()) return;
  const status = await getAccessStatus();
  if (status.state !== "online" && status.state !== "offline") throw new Error(status.error || "Connect an approved device to access business data.");
}

export async function requireOnlineAccess() {
  const status = await getAccessStatus();
  if (status.state !== "online") throw new Error("Shared changes require an online connection to Tanned by Ffy.");
}
