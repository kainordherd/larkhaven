import type { EventView, LogEntry } from "./types.ts";

type EventListener = (e: EventView) => void;
type LogListener = (l: LogEntry) => void;

const tunnelSubs = new Map<string, Set<EventListener>>();
const logSubs = new Set<LogListener>();

// Fans messages out to other isolates/instances on the same host (e.g. Deno Deploy).
const channel = new BroadcastChannel("meowhook");
(channel as unknown as { unref?: () => void }).unref?.();
channel.onmessage = (m) => {
  const msg = m.data;
  if (msg?.t === "event") deliverEvent(msg.event);
  else if (msg?.t === "log") deliverLog(msg.entry);
};

function deliverEvent(e: EventView) {
  for (const fn of tunnelSubs.get(e.tunnelId) ?? []) {
    try {
      fn(e);
    } catch { /* subscriber closed */ }
  }
}

function deliverLog(l: LogEntry) {
  for (const fn of logSubs) {
    try {
      fn(l);
    } catch { /* subscriber closed */ }
  }
}

export function publishEvent(e: EventView) {
  deliverEvent(e);
  channel.postMessage({ t: "event", event: e });
}

export function publishLog(entry: LogEntry) {
  deliverLog(entry);
  channel.postMessage({ t: "log", entry });
}

export function subscribeTunnel(tunnelId: string, fn: EventListener): () => void {
  let set = tunnelSubs.get(tunnelId);
  if (!set) tunnelSubs.set(tunnelId, set = new Set());
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) tunnelSubs.delete(tunnelId);
  };
}

export function subscribeLogs(fn: LogListener): () => void {
  logSubs.add(fn);
  return () => logSubs.delete(fn);
}

export function connectionCount(tunnelId: string): number {
  return tunnelSubs.get(tunnelId)?.size ?? 0;
}
