import { getCookies } from "@std/http/cookie";
import { config } from "./config.ts";
import { getSessionUser, getTunnel } from "./store.ts";
import type { Tunnel, User } from "./types.ts";

export const SESSION_COOKIE = "lh_session";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const v = await req.json();
    if (v && typeof v === "object" && !Array.isArray(v)) return v as T;
  } catch { /* fallthrough */ }
  throw new HttpError(400, "Expected a JSON object body");
}

export function clientIp(req: Request, info: Deno.ServeHandlerInfo): string {
  if (config.trustProxy) {
    const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (xff) return xff;
  }
  return (info.remoteAddr as Deno.NetAddr).hostname ?? "unknown";
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Constant-time string comparison (compares fixed-length digests). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function sessionUser(req: Request): Promise<User | null> {
  const sid = getCookies(req.headers)[SESSION_COOKIE];
  return sid ? await getSessionUser(sid) : null;
}

/** Cookie-authenticated browsers must come from our own origin (blocks CSRF / cross-site WS). */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (origin && origin !== config.origin) throw new HttpError(403, "Cross-origin request blocked");
}

function bearer(req: Request, url: URL): string | null {
  const h = req.headers.get("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return url.searchParams.get("token");
}

export interface Principal {
  user: User | null;
  via: "session" | "token";
}

export async function requireUser(req: Request): Promise<Principal> {
  const user = await sessionUser(req);
  if (!user) throw new HttpError(401, "Not authenticated");
  if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
  return { user, via: "session" };
}

/** Session user (any tunnel) or a Bearer/`?token=` matching this tunnel's consumer token. */
export async function requireTunnelAccess(
  req: Request,
  url: URL,
  tunnelId: string,
): Promise<{ principal: Principal; tunnel: Tunnel }> {
  const tunnel = await getTunnel(tunnelId);
  const user = await sessionUser(req);
  if (user) {
    if (req.method !== "GET" || req.headers.get("upgrade")) assertSameOrigin(req);
    if (!tunnel) throw new HttpError(404, "Tunnel not found");
    return { principal: { user, via: "session" }, tunnel };
  }
  const token = bearer(req, url);
  if (!token) throw new HttpError(401, "Not authenticated");
  // Always compare, even when the tunnel is missing, so timing doesn't reveal existence.
  const ok = await safeEqual(token, tunnel?.token ?? "\0");
  if (!tunnel || !ok) throw new HttpError(401, "Invalid token");
  return { principal: { user: null, via: "token" }, tunnel };
}
