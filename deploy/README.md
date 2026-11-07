# Host deployment

The application lives at `/home/debian/larkhaven` on the Debian host.
It uses the existing `/home/debian/.deno/bin/deno` runtime and systemd;
no container or separate database is required. KV and the Deno cache live
under `data/`. Keep that directory and `.env` across code deployments.

Create `.env` from `.env.example`, mode 0600, with these public settings:

```dotenv
BASE_URL=https://larkhaven.flowecho.org
HOST=127.0.0.1
PORT=5843
TRUST_PROXY=true
KV_PATH=./data/meowhook.db
```

Configure the local Authentik provider manually. Set `OIDC_ISSUER` to the
provider's issuer URL from its discovery document, `OIDC_CLIENT_ID` to its
client ID, and `OIDC_CLIENT_SECRET` if it is a confidential client. Store
the secret only in the host's `.env`. Register this exact redirect URI:
`https://larkhaven.flowecho.org/auth/callback`. The application checks that
issuer and client ID are present at startup, but does not verify the
provider until login. A running service does not establish working SSO.
The initial host `.env` uses explicit `configure-authentik` placeholders;
replace them before attempting sign-in.
Every authenticated user can manage every tunnel; configure Authentik
application access and `ALLOW_SELF_REGISTER` accordingly.

Install the unit and start the application after preparing configuration:

```sh
mkdir -p data
sudo install -m 0644 deploy/larkhaven.service /etc/systemd/system/larkhaven.service
sudo systemctl daemon-reload
sudo systemctl enable --now larkhaven
curl --fail http://127.0.0.1:5843/healthz
```

Append the site in `deploy/Caddyfile` to `/home/debian/Caddyfile`, preserving
existing routes and taking a backup first. The host's Caddy process is
started manually, and `/etc/caddy/Caddyfile` imports the home Caddyfile.
Use the active binary to validate and reload, rather than starting a
second Caddy process through systemd:

```sh
sudo /usr/bin/caddy.custom validate --config /home/debian/Caddyfile --adapter caddyfile
sudo /usr/bin/caddy.custom reload --config /home/debian/Caddyfile --adapter caddyfile
curl --fail https://larkhaven.flowecho.org/healthz
curl --fail https://larkhaven.flowecho.org/llms.txt
```

The origin uses internal TLS to match existing sites behind the public
proxy. Public clients should use the normal publicly trusted HTTPS URL.
Caddy handles WebSocket upgrades without a separate route.

After editing OIDC settings, restart with `sudo systemctl restart larkhaven`
and verify an actual sign-in. Inspect service failures with
`sudo journalctl -u larkhaven -n 50 --no-pager`; avoid publishing logs
containing incoming webhook data. For code updates, run the repository's
`deno task check` and `deno task test`, deploy tracked files, and restart.
Back up KV consistently before any future data migration.
