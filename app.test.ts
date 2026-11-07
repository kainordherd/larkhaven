import { assert, assertEquals } from "@std/assert";

Deno.env.set("KV_PATH", ":memory:");
Deno.env.set("BASE_URL", "http://localhost:8123");
Deno.env.set("OIDC_ISSUER", "http://idp.invalid");
Deno.env.set("OIDC_CLIENT_ID", "test");

const store = await import("./src/store.ts");
const { createHandler } = await import("./src/app.ts");
const handler = createHandler();

const info = {
  remoteAddr: { transport: "tcp", hostname: "203.0.113.9", port: 1 },
  completed: Promise.resolve(),
} as unknown as Deno.ServeHandlerInfo;
const call = (path: string, init: RequestInit = {}) =>
  handler(new Request("http://localhost:8123" + path, init), info);

const user =
  (await store.upsertUser({ sub: "u1", issuer: "http://idp.invalid", email: "a@b.c" }, true))!;
const sid = await store.createSession(user.id);
const cookie = { cookie: `lh_session=${sid}` };
const jsonHeaders = {
  ...cookie,
  "content-type": "application/json",
  origin: "http://localhost:8123",
};

async function mkTunnel(extra: Record<string, unknown> = {}) {
  const r = await call("/api/tunnels", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ name: "t1", ...extra }),
  });
  assertEquals(r.status, 201);
  return (await r.json()).tunnel;
}

const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test("consumer guide is public and supports HEAD", async () => {
  const response = await call("/llms.txt");
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assertEquals(await response.text(), await Deno.readTextFile("./llms.txt"));
  const head = await call("/llms.txt", { method: "HEAD" });
  assertEquals(head.status, 200);
  assertEquals(await head.text(), "");
});

Deno.test({ name: "api requires auth", ...opts }, async () => {
  assertEquals((await call("/api/tunnels")).status, 401);
  assertEquals((await call("/api/logs")).status, 401);
});

Deno.test({ name: "ingest → REST consume → ack → logs", ...opts }, async () => {
  const t = await mkTunnel();
  const res = await call(`/hook/${t.id}/github/push?x=1`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sig": "abc" },
    body: JSON.stringify({ hello: "world" }),
  });
  assertEquals(res.status, 200);

  // consumer token auth, no cookie
  const auth = { authorization: `Bearer ${t.token}` };
  const list =
    await (await call(`/api/tunnels/${t.id}/events?include=body&unacked=1`, { headers: auth }))
      .json();
  assertEquals(list.events.length, 1);
  const ev = list.events[0];
  assertEquals(ev.path, "/github/push");
  assertEquals(ev.query, "?x=1");
  assertEquals(ev.headers["x-sig"], "abc");
  assertEquals(JSON.parse(ev.body), { hello: "world" });
  assertEquals(ev.ip, "203.0.113.9");

  assertEquals(
    (await call(`/api/tunnels/${t.id}/events/${ev.id}/ack`, { method: "POST", headers: auth }))
      .status,
    200,
  );
  const after = await (await call(`/api/tunnels/${t.id}/events?unacked=1`, { headers: auth }))
    .json();
  assertEquals(after.events.length, 0);

  // token for another tunnel / bad token rejected
  const other = await mkTunnel({ name: "t2" });
  assertEquals(
    (await call(`/api/tunnels/${t.id}/events`, {
      headers: { authorization: `Bearer ${other.token}` },
    })).status,
    401,
  );
  // token can't manage the tunnel
  assertEquals((await call(`/api/tunnels/${t.id}`, { headers: auth })).status, 403);

  await new Promise((r) => setTimeout(r, 50));
  const logs = await (await call(`/api/logs?source=ingest&tunnel=${t.id}`, { headers: cookie }))
    .json();
  assert(logs.logs.some((l: { message: string }) => l.message.includes("POST /github/push")));
});

Deno.test({ name: "large + binary bodies roundtrip; oversize rejected", ...opts }, async () => {
  const t = await mkTunnel();
  const big = new Uint8Array(150_000).map((_, i) => i % 251);
  assertEquals((await call(`/hook/${t.id}`, { method: "PUT", body: big })).status, 200);
  const r = await (await call(`/api/tunnels/${t.id}/events?include=body`, { headers: cookie }))
    .json();
  const ev = r.events[0];
  assertEquals(ev.size, 150_000);
  assertEquals(ev.bodyEncoding, "base64");
  const { decodeBase64 } = await import("@std/encoding/base64");
  assertEquals(decodeBase64(ev.body), big);

  const tooBig = new Uint8Array(800_000);
  assertEquals((await call(`/hook/${t.id}`, { method: "POST", body: tooBig })).status, 413);
});

Deno.test({ name: "unknown / disabled tunnels, bad origin", ...opts }, async () => {
  assertEquals((await call("/hook/nope", { method: "POST", body: "x" })).status, 404);
  const t = await mkTunnel();
  const p = await call(`/api/tunnels/${t.id}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ enabled: false, responseStatus: 202 }),
  });
  assertEquals(p.status, 200);
  assertEquals((await call(`/hook/${t.id}`, { method: "POST", body: "x" })).status, 410);

  const csrf = await call("/api/tunnels", {
    method: "POST",
    headers: { ...jsonHeaders, origin: "https://evil.example" },
    body: JSON.stringify({ name: "x" }),
  });
  assertEquals(csrf.status, 403);
});

Deno.test({ name: "websocket: replay unacked + live + ack", ...opts }, async () => {
  const t = await mkTunnel();
  await call(`/hook/${t.id}`, { method: "POST", body: "one" });
  const server = Deno.serve({ port: 0, onListen() {} }, handler);
  const port = server.addr.port;
  try {
    const ws = new WebSocket(
      `ws://localhost:${port}/api/tunnels/${t.id}/ws?token=${t.token}&replay=unacked`,
    );
    const msgs: Record<string, unknown>[] = [];
    let ready!: () => void;
    const readyP = new Promise<void>((r) => (ready = r));
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      msgs.push(d);
      if (d.type === "ready") ready();
    };
    await readyP;
    await call(`/hook/${t.id}`, { method: "POST", body: "two" });
    await new Promise((r) => setTimeout(r, 100));
    const events = msgs.filter((m) => m.type === "event").map((m) =>
      (m.event as { body: string }).body
    );
    assertEquals(events, ["one", "two"]);
    ws.send(
      JSON.stringify({
        type: "ack",
        id: (msgs.find((m) => m.type === "event")!.event as { id: string }).id,
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    assert(msgs.some((m) => m.type === "acked"));
    ws.close();

    const bad = new WebSocket(`ws://localhost:${port}/api/tunnels/${t.id}/ws?token=wrong`);
    const closed = await new Promise<boolean>((r) => {
      bad.onerror = () => r(true);
      bad.onopen = () => r(false);
    });
    assert(closed);
  } finally {
    await server.shutdown();
  }
});
