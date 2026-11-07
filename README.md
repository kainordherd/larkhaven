# Larkhaven

A self-hosted webhook relay. Senders POST to a public URL; Larkhaven stores every request and
hands it to your consumers over a REST API or a WebSocket. Management is behind OIDC single
sign-on; every signed-in user can see and manage every tunnel. The UI is Alpine.js + Tailwind with
[Pines](https://devdojo.com/pines)-style components, and includes a live log viewer.

## Run

```sh
cp .env.example .env     # fill in OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET
deno task start          # or: deno task dev
deno task test
```

Load `.env` however you like (e.g. `deno run --env-file=.env ...` or your process manager).
Register `<BASE_URL>/auth/callback` as the redirect URI at your identity provider (authorization
code flow + PKCE; works with any OIDC-compliant IdP).

Permissions needed: `--allow-net --allow-env --allow-read --allow-write` (KV file under `./data`).

| Variable | Default | Notes |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:$PORT` | Public URL. Drives the redirect URI, secure cookies and the CSRF origin check. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | required | `OIDC_CLIENT_SECRET` optional (public client + PKCE). |
| `ALLOW_SELF_REGISTER` | `true` | `false`: only existing users or `ALLOWED_EMAILS` may sign in. |
| `MAX_BODY_BYTES` | 524288 | Capped at 700000 (Deno KV atomic-write limit). Larger bodies get `413`. |
| `EVENT_RETENTION_DAYS` / `LOG_RETENTION_DAYS` | 7 / 7 | Enforced via KV expiry. |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for the source IP. |

## Using a tunnel

For consumer integrations, read [llms.txt](llms.txt), also served at `/llms.txt`.

Create a tunnel in the UI. You get:

- **Webhook URL** `POST|GET|… <BASE_URL>/hook/<tunnelId>[/any/sub/path]` — the unguessable id is the
  secret. Replies with the tunnel's configured 2xx status.
- **Consumer token** `lh_…` — send as `Authorization: Bearer <token>` (or `?token=` for browser
  WebSockets). It only grants access to that tunnel's events. A signed-in session works too.

### REST

| | |
| --- | --- |
| `GET /api/tunnels/:id/events` | `after=<id>` (asc, exclusive cursor), `before=<id>&order=desc`, `limit` (≤200), `unacked=1`, `include=body`. Returns `{events, hasMore, cursor}`. |
| `GET /api/tunnels/:id/events/:eid` | One event including body. |
| `POST /api/tunnels/:id/events/:eid/ack` | Mark as processed (`unacked=1` then skips it). |
| `DELETE /api/tunnels/:id/events/:eid` | Remove an event. |

Bodies are returned as `body` + `bodyEncoding` (`utf8`, or `base64` for non-UTF-8 payloads).

### WebSocket

`GET /api/tunnels/:id/ws?token=…&replay=unacked` (or `&after=<eventId>`). Server sends
`{"type":"hello"}`, replayed events, `{"type":"ready"}`, then live `{"type":"event","event":{…}}`.
Client may send `{"type":"ack","id":"…"}` (→ `{"type":"acked"}`) or `{"type":"ping"}`.

## Logs

Ingest, WebSocket connect/disconnect, REST polling (debug), tunnel changes and sign-ins are written
to KV, stdout (JSON lines) and streamed to the **Logs** page with level / source / tunnel / text
filters and live tail (SSE).

## Notes & limits

- Storage is Deno KV. Live fan-out is in-process plus `BroadcastChannel`; for multiple separate
  hosts you'd need a shared broker.
- No sender signature verification or rate limiting is built in; put a proxy in front if you need
  either. Payloads are only ever rendered as text in the UI.
- The UI loads Tailwind and Alpine from CDNs.
