import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DataProvider, useLoad } from "../src/lib/data";

/** Loopback-only browser harness for the actual asynchronous data hook. */
export function mount() {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;top:0;left:0;z-index:999;background:white";
  document.body.appendChild(host);
  const pending = new Map<string, (value: string) => void>();
  let changeScope: (value: string) => void = () => {};
  function Scope() {
    const [scope, setScope] = useState("first");
    changeScope = setScope;
    const [value, loading, error] = useLoad(() => new Promise<string>(resolve => pending.set(scope, resolve)), [scope], "empty");
    return <output id="load-scope" data-loading={String(loading)}>{value}:{error ?? ""}</output>;
  }
  createRoot(host).render(<DataProvider><Scope /></DataProvider>);
  return { resolve: (key: string, value: string) => pending.get(key)?.(value), scope: (value: string) => changeScope(value) };
}
