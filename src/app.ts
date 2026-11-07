import { serveDir } from "@std/http/file-server";
import { assertSameOrigin, clientIp, HttpError, json, sessionUser } from "./http.ts";
import { handleApi } from "./api.ts";
import { ingest } from "./ingest.ts";
import { beginLogin, finishLogin, logout } from "./oidc.ts";
import { log } from "./logs.ts";

const UI_ROOT = new URL("../ui", import.meta.url).pathname;
const HOOK = new URLPattern({ pathname: "/hook/:id/*?" });

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};

export function createHandler() {
  return async (req: Request, info: Deno.ServeHandlerInfo): Promise<Response> => {
    const res = await route(req, info);
    // Upgrade and redirect responses have immutable/unusual headers; only decorate normal ones.
    if (res.status !== 101) {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    }
    return res;
  };
}

async function route(req: Request, info: Deno.ServeHandlerInfo): Promise<Response> {
  const url = new URL(req.url);
  const ip = clientIp(req, info);
  try {
    if (url.pathname === "/healthz") return json({ ok: true });
    if (url.pathname === "/llms.txt" && (req.method === "GET" || req.method === "HEAD")) {
      const text = await Deno.readTextFile(new URL("../llms.txt", import.meta.url));
      return new Response(req.method === "HEAD" ? null : text, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const hook = HOOK.exec({ pathname: url.pathname });
    if (hook) {
      const g = hook.pathname.groups;
      return await ingest(req, g.id!, g[0] ?? "", ip);
    }

    if (url.pathname === "/auth/login" && req.method === "GET") {
      try {
        return await beginLogin();
      } catch (e) {
        log("error", "auth", `cannot start login: ${(e as Error).message}`);
        return new Response(null, {
          status: 302,
          headers: {
            location: `/?auth_error=${encodeURIComponent("identity provider unavailable")}`,
          },
        });
      }
    }
    if (url.pathname === "/auth/callback" && req.method === "GET") {
      return await finishLogin(req, ip);
    }
    if (url.pathname === "/auth/logout" && req.method === "POST") {
      assertSameOrigin(req);
      return await logout(req, (await sessionUser(req))?.id);
    }

    if (url.pathname.startsWith("/api/")) return await handleApi(req, ip);

    if (req.method !== "GET" && req.method !== "HEAD") {
      throw new HttpError(405, "Method not allowed");
    }
    return await serveDir(req, { fsRoot: UI_ROOT, quiet: true });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    log("error", "system", `unhandled error: ${(e as Error).message}`, {
      data: { path: url.pathname, stack: (e as Error).stack },
    });
    return json({ error: "Internal server error" }, 500);
  }
}
