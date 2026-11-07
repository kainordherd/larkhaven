import { HttpError, json, readJson, requireTunnelAccess, requireUser } from "./http.ts";
import type { Principal } from "./http.ts";
import {
  ackEvent,
  createTunnel,
  deleteEvent,
  deleteEvents,
  deleteTunnel,
  getEvent,
  listEvents,
  listTunnels,
  randomToken,
  saveTunnel,
  toView,
  tunnelStats,
} from "./store.ts";
import { log, matchesLog, queryLogs } from "./logs.ts";
import { connectionCount, subscribeLogs, subscribeTunnel } from "./hub.ts";
import { config } from "./config.ts";
import { type EventMeta, type EventView, LEVELS, type LogLevel, type Tunnel } from "./types.ts";

export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  ip: string;
}

type Handler = (c: Ctx) => Promise<Response> | Response;
interface Route {
  method: string;
  pattern: URLPattern;
  handler: Handler;
}

const routes: Route[] = [];
const route = (method: string, path: string, handler: Handler) =>
  routes.push({ method, pattern: new URLPattern({ pathname: path }), handler });

export async function handleApi(req: Request, ip: string): Promise<Response> {
  const url = new URL(req.url);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec({ pathname: url.pathname });
    if (m) {
      return await r.handler({ req, url, params: m.pathname.groups as Record<string, string>, ip });
    }
  }
  throw new HttpError(404, "Not found");
}

// ---------- helpers ----------

const who = (p: Principal) => p.user?.email ?? p.user?.name ?? "token";

async function tunnelView(t: Tunnel) {
  return { ...t, ...(await tunnelStats(t.id)), connections: connectionCount(t.id) };
}

function intParam(url: URL, name: string, def: number, min: number, max: number): number {
  const v = parseInt(url.searchParams.get(name) ?? "", 10);
  return Number.isFinite(v) ? Math.min(Math.max(v, min), max) : def;
}

function validateTunnelFields(b: Record<string, unknown>, partial: boolean) {
  const out: { name?: string; description?: string; responseStatus?: number; enabled?: boolean } =
    {};
  if (!partial || "name" in b) {
    const name = String(b.name ?? "").trim();
    if (!name || name.length > 80) throw new HttpError(400, "name is required (max 80 chars)");
    out.name = name;
  }
  if ("description" in b) {
    const d = String(b.description ?? "").trim();
    if (d.length > 300) throw new HttpError(400, "description too long (max 300 chars)");
    out.description = d;
  }
  if ("responseStatus" in b) {
    const s = Number(b.responseStatus);
    if (!Number.isInteger(s) || s < 200 || s > 299) {
      throw new HttpError(400, "responseStatus must be a 2xx status code");
    }
    out.responseStatus = s;
  }
  if ("enabled" in b) out.enabled = !!b.enabled;
  return out;
}

// ---------- identity ----------

route("GET", "/api/me", async ({ req }) => {
  const { user } = await requireUser(req);
  return json({
    user: { id: user!.id, email: user!.email, name: user!.name },
    baseUrl: config.baseUrl,
    limits: { maxBodyBytes: config.maxBodyBytes },
  });
});

// ---------- tunnel management ----------

route("GET", "/api/tunnels", async ({ req }) => {
  await requireUser(req);
  return json({ tunnels: await Promise.all((await listTunnels()).map(tunnelView)) });
});

route("POST", "/api/tunnels", async ({ req }) => {
  const p = await requireUser(req);
  const f = validateTunnelFields(await readJson(req), false);
  const t = await createTunnel({
    name: f.name!,
    description: f.description ?? "",
    responseStatus: f.responseStatus ?? 200,
  }, p.user!.id);
  log("info", "api", `${who(p)} created tunnel "${t.name}"`, {
    tunnelId: t.id,
    userId: p.user!.id,
  });
  return json({ tunnel: await tunnelView(t) }, 201);
});

route("GET", "/api/tunnels/:id", async ({ req, url, params }) => {
  const { tunnel, principal } = await requireTunnelAccess(req, url, params.id);
  if (principal.via !== "session") throw new HttpError(403, "Session required");
  return json({ tunnel: await tunnelView(tunnel) });
});

route("PATCH", "/api/tunnels/:id", async ({ req, url, params }) => {
  const { tunnel, principal } = await requireTunnelAccess(req, url, params.id);
  if (principal.via !== "session") throw new HttpError(403, "Session required");
  Object.assign(tunnel, validateTunnelFields(await readJson(req), true));
  await saveTunnel(tunnel);
  log("info", "api", `${who(principal)} updated tunnel "${tunnel.name}"`, {
    tunnelId: tunnel.id,
    userId: principal.user!.id,
    data: { enabled: tunnel.enabled, responseStatus: tunnel.responseStatus },
  });
  return json({ tunnel: await tunnelView(tunnel) });
});

route("POST", "/api/tunnels/:id/rotate-token", async ({ req, url, params }) => {
  const { tunnel, principal } = await requireTunnelAccess(req, url, params.id);
  if (principal.via !== "session") throw new HttpError(403, "Session required");
  tunnel.token = `lh_${randomToken(32)}`;
  await saveTunnel(tunnel);
  log("warn", "api", `${who(principal)} rotated consumer token for "${tunnel.name}"`, {
    tunnelId: tunnel.id,
    userId: principal.user!.id,
  });
  return json({ tunnel: await tunnelView(tunnel) });
});

route("DELETE", "/api/tunnels/:id", async ({ req, url, params }) => {
  const { tunnel, principal } = await requireTunnelAccess(req, url, params.id);
  if (principal.via !== "session") throw new HttpError(403, "Session required");
  await deleteTunnel(tunnel.id);
  log("warn", "api", `${who(principal)} deleted tunnel "${tunnel.name}"`, {
    tunnelId: tunnel.id,
    userId: principal.user!.id,
  });
  return new Response(null, { status: 204 });
});

// ---------- events (session or tunnel token) ----------

route("GET", "/api/tunnels/:id/events", async ({ req, url, params, ip }) => {
  const { tunnel, principal } = await requireTunnelAccess(req, url, params.id);
  const q = url.searchParams;
  const order = q.get("order") === "desc" ? "desc" : "asc";
  const withBody = q.get("include") === "body";
  const page = await listEvents(tunnel.id, {
    order,
    after: q.get("after") ?? undefined,
    before: q.get("before") ?? undefined,
    limit: intParam(url, "limit", 50, 1, 200),
    unacked: q.get("unacked") === "1" || q.get("unacked") === "true",
  });
  const events = await Promise.all(page.events.map((e) => toView(e, withBody)));
  if (principal.via === "token") {
    log("debug", "api", `REST poll: ${events.length} event(s)`, {
      tunnelId: tunnel.id,
      data: { ip },
    });
  }
  return json({
    events,
    hasMore: page.hasMore,
    cursor: events.length ? events[events.length - 1].id : null,
  });
});

async function loadEvent(tunnelId: string, id: string): Promise<EventMeta> {
  const e = await getEvent(tunnelId, id);
  if (!e) throw new HttpError(404, "Event not found");
  return e;
}

route("GET", "/api/tunnels/:id/events/:eid", async ({ req, url, params }) => {
  const { tunnel } = await requireTunnelAccess(req, url, params.id);
  return json({ event: await toView(await loadEvent(tunnel.id, params.eid), true) });
});

route("POST", "/api/tunnels/:id/events/:eid/ack", async ({ req, url, params, ip }) => {
  const { tunnel, principal } = await requireTunnelAccess(req, url, params.id);
  const e = await ackEvent(await loadEvent(tunnel.id, params.eid));
  log("debug", "api", `event ${e.id} acked by ${who(principal)}`, {
    tunnelId: tunnel.id,
    data: { ip, via: principal.via },
  });
  return json({ event: await toView(e, false) });
});

route("DELETE", "/api/tunnels/:id/events/:eid", async ({ req, url, params }) => {
  const { tunnel, principal } = await requireTunnelAccess(req, url, params.id);
  await loadEvent(tunnel.id, params.eid);
  await deleteEvent(tunnel.id, params.eid);
  log("info", "api", `event ${params.eid} deleted by ${who(principal)}`, { tunnelId: tunnel.id });
  return new Response(null, { status: 204 });
});

route("DELETE", "/api/tunnels/:id/events", async ({ req, url, params }) => {
  const { tunnel, principal } = await requireTunnelAccess(req, url, params.id);
  if (principal.via !== "session") throw new HttpError(403, "Session required");
  await deleteEvents(tunnel.id);
  log("warn", "api", `${who(principal)} cleared all events of "${tunnel.name}"`, {
    tunnelId: tunnel.id,
    userId: principal.user!.id,
  });
  return new Response(null, { status: 204 });
});

// ---------- websocket consumer ----------

route("GET", "/api/tunnels/:id/ws", async ({ req, url, params, ip }) => {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "WebSocket upgrade required");
  }
  const { tunnel, principal } = await requireTunnelAccess(req, url, params.id);
  const { socket, response } = Deno.upgradeWebSocket(req, { idleTimeout: 120 });
  const q = url.searchParams;
  const after = q.get("after");
  const replayUnacked = q.get("replay") === "unacked";
  const level: LogLevel = principal.via === "token" ? "info" : "debug";
  let unsubscribe: (() => void) | null = null;

  const send = (msg: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };

  socket.onopen = async () => {
    log(level, "ws", `consumer connected (${principal.via})`, {
      tunnelId: tunnel.id,
      data: { ip },
    });
    // Subscribe first and buffer, so events arriving during replay are neither lost nor duplicated.
    const buffer: EventView[] = [];
    let replaying = true;
    let lastId = "";
    unsubscribe = subscribeTunnel(tunnel.id, (e) => {
      if (replaying) buffer.push(e);
      else send({ type: "event", event: e });
    });
    send({ type: "hello", tunnelId: tunnel.id });
    try {
      if (after || replayUnacked) {
        let cursor = after ?? undefined;
        while (socket.readyState === WebSocket.OPEN) {
          const page = await listEvents(tunnel.id, {
            order: "asc",
            after: cursor,
            limit: 100,
            unacked: replayUnacked,
          });
          for (const m of page.events) {
            send({ type: "event", event: await toView(m, true) });
            lastId = cursor = m.id;
          }
          if (!page.hasMore) break;
        }
      }
    } catch (e) {
      log("error", "ws", `replay failed: ${(e as Error).message}`, { tunnelId: tunnel.id });
    }
    replaying = false;
    for (const e of buffer) if (e.id > lastId) send({ type: "event", event: e });
    send({ type: "ready" });
  };

  socket.onmessage = async (m) => {
    try {
      const msg = JSON.parse(String(m.data));
      if (msg.type === "ping") return send({ type: "pong" });
      if (msg.type === "ack" && typeof msg.id === "string") {
        const meta = await getEvent(tunnel.id, msg.id);
        if (!meta) return send({ type: "error", error: "event not found", id: msg.id });
        await ackEvent(meta);
        send({ type: "acked", id: msg.id });
      }
    } catch {
      send({ type: "error", error: "invalid message" });
    }
  };

  socket.onclose = () => {
    unsubscribe?.();
    log(level, "ws", "consumer disconnected", { tunnelId: tunnel.id, data: { ip } });
  };
  socket.onerror = () => unsubscribe?.();
  return response;
});

// ---------- logs ----------

function logFilters(url: URL) {
  const level = url.searchParams.get("level");
  return {
    level: LEVELS.includes(level as LogLevel) ? (level as LogLevel) : undefined,
    source: url.searchParams.get("source") || undefined,
    tunnelId: url.searchParams.get("tunnel") || undefined,
    q: url.searchParams.get("q")?.slice(0, 200) || undefined,
  };
}

route("GET", "/api/logs", async ({ req, url }) => {
  await requireUser(req);
  const result = await queryLogs({
    ...logFilters(url),
    before: url.searchParams.get("before") ?? undefined,
    limit: intParam(url, "limit", 100, 1, 500),
  });
  return json(result);
});

route("GET", "/api/logs/stream", async ({ req, url }) => {
  await requireUser(req);
  const filters = logFilters(url);
  const enc = new TextEncoder();
  let unsub: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode("retry: 3000\n\n"));
      unsub = subscribeLogs((l) => {
        if (matchesLog(l, filters)) ctrl.enqueue(enc.encode(`data: ${JSON.stringify(l)}\n\n`));
      });
      timer = setInterval(() => ctrl.enqueue(enc.encode(": keepalive\n\n")), 15_000);
      req.signal.addEventListener("abort", () => {
        unsub?.();
        clearInterval(timer);
        try {
          ctrl.close();
        } catch { /* already closed */ }
      });
    },
    cancel() {
      unsub?.();
      clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
});
