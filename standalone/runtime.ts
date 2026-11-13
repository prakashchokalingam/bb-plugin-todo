import { useEffect, useRef, useSyncExternalStore } from "react";
import type { PluginRpcClient, PluginRpcContract } from "@get-bb/plugin-sdk";

const base = new URL(".", window.location.href).pathname.replace(/\/$/, "");
const rpcBase = base.replace(/\/http$/, "/rpc");
const listeners = new Set<() => void>();
let events: EventSource | null = null;
let connection: "connected" | "reconnecting" = "reconnecting";
const connectionListeners = new Set<() => void>();
function setConnection(value: typeof connection) {
  connection = value;
  for (const callback of connectionListeners) callback();
}
function refresh() { for (const callback of listeners) callback(); }

function subscribe(callback: () => void) {
  listeners.add(callback);
  if (!events) {
    const url = new URL(`${base}/events`, window.location.origin);
    const desktopSession = new URLSearchParams(window.location.search).get("desktopSession");
    if (desktopSession) url.searchParams.set("desktopSession", desktopSession);
    events = new EventSource(url.href);
    events.addEventListener("board", refresh);
    events.onopen = () => { setConnection("connected"); refresh(); };
    events.onerror = () => setConnection("reconnecting");
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshVisible);
  }
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0) {
      events?.close();
      events = null;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshVisible);
    }
  };
}
function refreshVisible() { if (document.visibilityState === "visible") refresh(); }

const client = {
  async call(method: string, input: unknown = null) {
    const response = await fetch(`${rpcBase}/${encodeURIComponent(method)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    let envelope;
    try { envelope = await response.json(); }
    catch { throw new Error("Cannot reach Todo. Keep BB open and retry."); }
    if (!response.ok || envelope.ok !== true) {
      throw new Error(envelope.error?.message ?? "Cannot save the change. Retry.");
    }
    return envelope.result;
  },
};

/** The standalone build replaces only the three SDK hooks that the board uses. */
export function useRpc<C extends PluginRpcContract>(): PluginRpcClient<C> {
  return client as PluginRpcClient<C>;
}
export function useRealtime(channel: string, callback: (payload: unknown) => void): void {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => channel === "board" ? subscribe(() => ref.current({})) : undefined, [channel]);
}
const navigate = {
  toPluginPanel(_path: string, options?: { subPath?: string; replace?: boolean }) {
    const url = new URL(window.location.href);
    if (options?.subPath) url.searchParams.set("list", options.subPath);
    else url.searchParams.delete("list");
    if (options?.replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  },
  openUrl() { return false; },
};
export function useBbNavigate() { return navigate; }
export function useConnection() {
  return useSyncExternalStore((callback) => {
    connectionListeners.add(callback);
    return () => { connectionListeners.delete(callback); };
  }, () => connection);
}
