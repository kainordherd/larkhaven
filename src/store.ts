import { monotonicUlid } from "@std/ulid";
import { encodeBase64Url } from "@std/encoding/base64url";
import { encodeBase64 } from "@std/encoding/base64";
import { config } from "./config.ts";
import type { EventMeta, EventView, Tunnel, User } from "./types.ts";

if (config.kvPath !== ":memory:") {
  const i = config.kvPath.lastIndexOf("/");
  if (i > 0) Deno.mkdirSync(config.kvPath.slice(0, i), { recursive: true });
}
export const kv = await Deno.openKv(config.kvPath === ":memory:" ? ":memory:" : config.kvPath);

export const newId = (): string => monotonicUlid();
export const randomToken = (bytes = 32): string =>
  encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

// ---------- users & sessions ----------

export async function getUser(id: string): Promise<User | null> {
  return (await kv.get<User>(["users", id])).value;
}

export async function upsertUser(
  u: { sub: string; issuer: string; email?: string; name?: string },
  create: boolean,
): Promise<User | null> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${u.issuer}|${u.sub}`),
  );
  const id = encodeBase64Url(new Uint8Array(digest)).slice(0, 24);
  const existing = await getUser(id);
  if (!existing && !create) return null;
  const now = Date.now();
  const user: User = {
    id,
    sub: u.sub,
    issuer: u.issuer,
    email: u.email ?? existing?.email,
    name: u.name ?? existing?.name,
    createdAt: existing?.createdAt ?? now,
    lastLoginAt: now,
  };
  await kv.set(["users", id], user);
  return user;
}

export async function userExists(issuer: string, sub: string): Promise<boolean> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${issuer}|${sub}`),
  );
  return !!(await getUser(encodeBase64Url(new Uint8Array(digest)).slice(0, 24)));
}

export async function createSession(userId: string): Promise<string> {
  const sid = randomToken(32);
  await kv.set(["sessions", sid], { userId, createdAt: Date.now() }, {
    expireIn: config.sessionTtlMs,
  });
  return sid;
}

export async function getSessionUser(sid: string): Promise<User | null> {
  const s = (await kv.get<{ userId: string }>(["sessions", sid])).value;
  return s ? await getUser(s.userId) : null;
}

export const deleteSession = (sid: string) => kv.delete(["sessions", sid]);

// ---------- tunnels ----------

export async function getTunnel(id: string): Promise<Tunnel | null> {
  return (await kv.get<Tunnel>(["tunnels", id])).value;
}

export async function listTunnels(): Promise<Tunnel[]> {
  const out: Tunnel[] = [];
  for await (const e of kv.list<Tunnel>({ prefix: ["tunnels"] })) out.push(e.value);
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function createTunnel(
  input: { name: string; description: string; responseStatus: number },
  userId: string,
): Promise<Tunnel> {
  const now = Date.now();
  const t: Tunnel = {
    id: randomToken(16),
    token: `lh_${randomToken(32)}`,
    enabled: true,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
  await kv.set(["tunnels", t.id], t);
  return t;
}

export async function saveTunnel(t: Tunnel): Promise<Tunnel> {
  t.updatedAt = Date.now();
  await kv.set(["tunnels", t.id], t);
  return t;
}

export async function tunnelStats(id: string) {
  const [last, total] = await kv.getMany<[number, Deno.KvU64]>([
    ["tunnel_last", id],
    ["tunnel_total", id],
  ]);
  return { lastEventAt: last.value ?? null, received: Number(total.value?.value ?? 0n) };
}

async function deletePrefix(prefix: Deno.KvKey) {
  for await (const e of kv.list({ prefix })) await kv.delete(e.key);
}

export async function deleteTunnel(id: string) {
  await kv.delete(["tunnels", id]);
  await deleteEvents(id);
  await kv.delete(["tunnel_last", id]);
  await kv.delete(["tunnel_total", id]);
}

// ---------- events ----------

// Deno KV values are capped at 64 KiB, so bodies live in separate chunk entries.
const CHUNK = 60_000;
const ttl = () => ({ expireIn: config.eventTtlMs });

export async function saveEvent(
  input: Omit<EventMeta, "id" | "receivedAt" | "ackedAt" | "chunks" | "size">,
  body: Uint8Array,
): Promise<EventMeta> {
  const meta: EventMeta = {
    ...input,
    id: newId(),
    receivedAt: Date.now(),
    ackedAt: null,
    size: body.length,
    chunks: Math.ceil(body.length / CHUNK),
  };
  const op = kv.atomic().set(["events", meta.tunnelId, meta.id], meta, ttl());
  for (let i = 0; i < meta.chunks; i++) {
    op.set(
      ["event_body", meta.tunnelId, meta.id, i],
      body.slice(i * CHUNK, (i + 1) * CHUNK),
      ttl(),
    );
  }
  op.set(["tunnel_last", meta.tunnelId], meta.receivedAt)
    .sum(["tunnel_total", meta.tunnelId], 1n);
  const res = await op.commit();
  if (!res.ok) throw new Error("failed to store event");
  return meta;
}

async function readBody(meta: EventMeta): Promise<Uint8Array> {
  const keys: Deno.KvKey[] = [];
  for (let i = 0; i < meta.chunks; i++) keys.push(["event_body", meta.tunnelId, meta.id, i]);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < keys.length; i += 10) {
    for (const r of await kv.getMany<Uint8Array[]>(keys.slice(i, i + 10))) {
      parts.push(r.value ?? new Uint8Array());
    }
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export async function toView(meta: EventMeta, withBody: boolean): Promise<EventView> {
  const { chunks: _chunks, ...rest } = meta;
  if (!withBody) return rest;
  const bytes = await readBody(meta);
  try {
    return {
      ...rest,
      body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      bodyEncoding: "utf8",
    };
  } catch {
    return { ...rest, body: encodeBase64(bytes), bodyEncoding: "base64" };
  }
}

export async function getEvent(tunnelId: string, id: string): Promise<EventMeta | null> {
  return (await kv.get<EventMeta>(["events", tunnelId, id])).value;
}

export interface ListOpts {
  after?: string;
  before?: string;
  order: "asc" | "desc";
  limit: number;
  unacked: boolean;
}

export async function listEvents(tunnelId: string, o: ListOpts) {
  const prefix: Deno.KvKey = ["events", tunnelId];
  const selector: Deno.KvListSelector = o.order === "desc"
    ? (o.before ? { prefix, end: [...prefix, o.before] } : { prefix })
    // "\0" sorts immediately after the id itself, making `start` exclusive.
    : (o.after ? { prefix, start: [...prefix, o.after + "\0"] } : { prefix });
  const out: EventMeta[] = [];
  let hasMore = false;
  for await (const e of kv.list<EventMeta>(selector, { reverse: o.order === "desc" })) {
    if (o.unacked && e.value.ackedAt) continue;
    if (out.length === o.limit) {
      hasMore = true;
      break;
    }
    out.push(e.value);
  }
  return { events: out, hasMore };
}

export async function ackEvent(meta: EventMeta): Promise<EventMeta> {
  if (meta.ackedAt) return meta;
  const updated = { ...meta, ackedAt: Date.now() };
  // Re-setting a key drops its TTL, so preserve the remaining lifetime.
  const remaining = Math.max(meta.receivedAt + config.eventTtlMs - Date.now(), 1000);
  await kv.set(["events", meta.tunnelId, meta.id], updated, { expireIn: remaining });
  return updated;
}

export async function deleteEvent(tunnelId: string, id: string) {
  await kv.delete(["events", tunnelId, id]);
  await deletePrefix(["event_body", tunnelId, id]);
}

export async function deleteEvents(tunnelId: string) {
  await deletePrefix(["events", tunnelId]);
  await deletePrefix(["event_body", tunnelId]);
}
