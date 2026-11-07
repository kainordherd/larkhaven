import { createRemoteJWKSet, jwtVerify } from "jose";
import { deleteCookie, getCookies, setCookie } from "@std/http/cookie";
import { encodeBase64Url } from "@std/encoding/base64url";
import { config } from "./config.ts";
import { createSession, deleteSession, kv, randomToken, upsertUser, userExists } from "./store.ts";
import { SESSION_COOKIE } from "./http.ts";
import { log } from "./logs.ts";

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

let cached: { disc: Discovery; jwks: ReturnType<typeof createRemoteJWKSet>; at: number } | null =
  null;

const trimSlash = (s: string) => s.replace(/\/+$/, "");
const STATE_COOKIE = "lh_oidc";
const REDIRECT_URI = `${config.baseUrl}/auth/callback`;

async function discover() {
  if (cached && Date.now() - cached.at < 3_600_000) return cached;
  const res = await fetch(`${trimSlash(config.oidc.issuer)}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
  const disc = await res.json() as Discovery;
  if (trimSlash(disc.issuer) !== trimSlash(config.oidc.issuer)) {
    throw new Error("OIDC discovery issuer mismatch");
  }
  cached = { disc, jwks: createRemoteJWKSet(new URL(disc.jwks_uri)), at: Date.now() };
  return cached;
}

const cookieOpts = (maxAge: number) => ({
  path: "/",
  httpOnly: true,
  sameSite: "Lax" as const,
  secure: config.secureCookies,
  maxAge,
});

export async function beginLogin(): Promise<Response> {
  const { disc } = await discover();
  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(48);
  const challenge = encodeBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  await kv.set(["oidc_state", state], { nonce, verifier }, { expireIn: 600_000 });

  const u = new URL(disc.authorization_endpoint);
  u.search = new URLSearchParams({
    ...Object.fromEntries(u.searchParams),
    response_type: "code",
    client_id: config.oidc.clientId,
    redirect_uri: REDIRECT_URI,
    scope: config.oidc.scopes,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const headers = new Headers({ location: u.toString() });
  setCookie(headers, { name: STATE_COOKIE, value: state, ...cookieOpts(600) });
  return new Response(null, { status: 302, headers });
}

/** Completes the code flow. Returns a redirect response that sets the session cookie. */
export async function finishLogin(req: Request, ip: string): Promise<Response> {
  const url = new URL(req.url);
  const fail = (msg: string) => {
    log("warn", "auth", `login failed: ${msg}`, { data: { ip } });
    const h = new Headers({ location: `/?auth_error=${encodeURIComponent(msg)}` });
    deleteCookie(h, STATE_COOKIE, { path: "/" });
    return new Response(null, { status: 302, headers: h });
  };

  const idpError = url.searchParams.get("error");
  if (idpError) return fail(url.searchParams.get("error_description") ?? idpError);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || getCookies(req.headers)[STATE_COOKIE] !== state) {
    return fail("invalid login state, please try again");
  }
  const saved = (await kv.get<{ nonce: string; verifier: string }>(["oidc_state", state])).value;
  if (!saved) return fail("login expired, please try again");
  await kv.delete(["oidc_state", state]);

  try {
    const { disc, jwks } = await discover();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: config.oidc.clientId,
      code_verifier: saved.verifier,
    });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    if (config.oidc.clientSecret) {
      headers.authorization = "Basic " + btoa(
        `${encodeURIComponent(config.oidc.clientId)}:${
          encodeURIComponent(config.oidc.clientSecret)
        }`,
      );
    }
    const tokenRes = await fetch(disc.token_endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.id_token) {
      return fail(tokens.error_description ?? tokens.error ?? "token exchange failed");
    }

    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: disc.issuer,
      audience: config.oidc.clientId,
    });
    if (payload.nonce !== saved.nonce) return fail("nonce mismatch");

    let email = payload.email as string | undefined;
    let verified = payload.email_verified as boolean | undefined;
    let name = (payload.name ?? payload.preferred_username) as string | undefined;
    if (!email && disc.userinfo_endpoint && tokens.access_token) {
      const ui = await fetch(disc.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (ui.ok) {
        const info = await ui.json();
        if (info.sub === payload.sub) {
          email = info.email;
          verified = info.email_verified;
          name ??= info.name ?? info.preferred_username;
        }
      }
    }

    const sub = String(payload.sub);
    const known = await userExists(disc.issuer, sub);
    const allowlisted = !!email && verified !== false &&
      config.allowedEmails.includes(email.toLowerCase());
    if (!known && !config.allowSelfRegister && !allowlisted) {
      return fail("self-registration is disabled; ask an administrator for access");
    }

    const user = await upsertUser({ sub, issuer: disc.issuer, email, name }, true);
    const sid = await createSession(user!.id);
    log("info", "auth", `${known ? "login" : "registered"}: ${email ?? sub}`, {
      userId: user!.id,
      data: { ip },
    });

    const h = new Headers({ location: "/" });
    setCookie(h, {
      name: SESSION_COOKIE,
      value: sid,
      ...cookieOpts(Math.floor(config.sessionTtlMs / 1000)),
    });
    deleteCookie(h, STATE_COOKIE, { path: "/" });
    return new Response(null, { status: 302, headers: h });
  } catch (e) {
    console.error(e);
    return fail("sign-in failed");
  }
}

export async function logout(req: Request, userId?: string): Promise<Response> {
  const sid = getCookies(req.headers)[SESSION_COOKIE];
  if (sid) await deleteSession(sid);
  if (userId) log("info", "auth", "logout", { userId });
  const h = new Headers();
  deleteCookie(h, SESSION_COOKIE, { path: "/" });
  return new Response(null, { status: 204, headers: h });
}
