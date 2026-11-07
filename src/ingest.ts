import { config } from "./config.ts";
import { getTunnel, saveEvent, toView } from "./store.ts";
import { publishEvent } from "./hub.ts";
import { log } from "./logs.ts";
import { json } from "./http.ts";

const MAX_HEADERS = 100;
const MAX_HEADER_VALUE = 4096;

/** Reads the request body, aborting once it exceeds `limit`. Returns null if too large. */
async function readLimited(req: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Public webhook entrypoint: ANY method on /hook/:tunnelId[/rest]. The tunnel id is the secret. */
export async function ingest(req: Request, tunnelId: string, rest: string, ip: string) {
  const url = new URL(req.url);
  const tunnel = await getTunnel(tunnelId);
  if (!tunnel) {
    log("warn", "ingest", `unknown tunnel ${tunnelId.slice(0, 6)}…`, {
      data: { ip, method: req.method },
    });
    return json({ error: "Not found" }, 404);
  }
  if (!tunnel.enabled) {
    log("warn", "ingest", `rejected: tunnel "${tunnel.name}" is disabled`, {
      tunnelId,
      data: { ip },
    });
    return json({ error: "Tunnel disabled" }, 410);
  }

  const body = await readLimited(req, config.maxBodyBytes);
  if (!body) {
    log("warn", "ingest", `rejected: body exceeds ${config.maxBodyBytes} bytes`, {
      tunnelId,
      data: { ip, method: req.method },
    });
    return json({ error: "Payload too large", limit: config.maxBodyBytes }, 413);
  }

  const headers: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of req.headers) {
    if (++n > MAX_HEADERS) break;
    headers[k] = v.slice(0, MAX_HEADER_VALUE);
  }

  try {
    const meta = await saveEvent({
      tunnelId,
      method: req.method,
      path: ("/" + rest).slice(0, 2048),
      query: url.search.slice(0, MAX_HEADER_VALUE),
      headers,
      contentType: (headers["content-type"] ?? "").slice(0, 200),
      ip,
    }, body);
    log("info", "ingest", `${req.method} /${rest} → ${tunnel.responseStatus} (${meta.size} B)`, {
      tunnelId,
      data: { eventId: meta.id, ip, contentType: meta.contentType },
    });
    publishEvent(await toView(meta, true));
    const noBody = tunnel.responseStatus === 204;
    return noBody
      ? new Response(null, { status: 204 })
      : json({ ok: true, id: meta.id }, tunnel.responseStatus);
  } catch (e) {
    log("error", "ingest", `failed to store event: ${(e as Error).message}`, { tunnelId });
    return json({ error: "Failed to store event" }, 500);
  }
}
