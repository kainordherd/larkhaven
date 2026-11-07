import { config } from "./config.ts";
import { kv, newId } from "./store.ts";
import { publishLog } from "./hub.ts";
import { LEVELS, type LogEntry, type LogLevel } from "./types.ts";

interface Extra {
  tunnelId?: string;
  userId?: string;
  data?: Record<string, unknown>;
}

/** Writes a log entry to KV, stdout, and live subscribers. Never throws. */
export function log(level: LogLevel, source: string, message: string, extra: Extra = {}): void {
  const entry: LogEntry = { id: newId(), ts: Date.now(), level, source, message, ...extra };
  console.log(JSON.stringify(entry));
  publishLog(entry);
  kv.set(["logs", entry.id], entry, { expireIn: config.logTtlMs }).catch((e) =>
    console.error("log write failed", e)
  );
}

export interface LogQuery {
  level?: LogLevel;
  source?: string;
  tunnelId?: string;
  q?: string;
  before?: string;
  limit: number;
}

export function matchesLog(l: LogEntry, f: Omit<LogQuery, "before" | "limit">): boolean {
  if (f.level && LEVELS.indexOf(l.level) < LEVELS.indexOf(f.level)) return false;
  if (f.source && l.source !== f.source) return false;
  if (f.tunnelId && l.tunnelId !== f.tunnelId) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = `${l.message} ${l.data ? JSON.stringify(l.data) : ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** Newest-first page of logs. Scans at most `MAX_SCAN` entries per call. */
export async function queryLogs(f: LogQuery) {
  const MAX_SCAN = 20_000;
  const prefix: Deno.KvKey = ["logs"];
  const selector: Deno.KvListSelector = f.before
    ? { prefix, end: [...prefix, f.before] }
    : { prefix };
  const out: LogEntry[] = [];
  let scanned = 0;
  let hasMore = false;
  for await (const e of kv.list<LogEntry>(selector, { reverse: true })) {
    if (++scanned > MAX_SCAN) {
      hasMore = true;
      break;
    }
    if (!matchesLog(e.value, f)) continue;
    if (out.length === f.limit) {
      hasMore = true;
      break;
    }
    out.push(e.value);
  }
  return { logs: out, hasMore };
}
