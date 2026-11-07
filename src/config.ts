const env = (k: string, d = ""): string => Deno.env.get(k)?.trim() || d;
const num = (k: string, d: number): number => {
  const v = Number(env(k));
  return Number.isFinite(v) && v > 0 ? v : d;
};
const flag = (k: string, d: boolean): boolean => {
  const v = env(k).toLowerCase();
  return v === "" ? d : ["1", "true", "yes", "on"].includes(v);
};

const port = num("PORT", 8000);
const baseUrl = env("BASE_URL", `http://localhost:${port}`).replace(/\/+$/, "");

export const config = {
  port,
  baseUrl,
  origin: new URL(baseUrl).origin,
  secureCookies: baseUrl.startsWith("https://"),
  trustProxy: flag("TRUST_PROXY", false),
  kvPath: env("KV_PATH", "./data/meowhook.db"),
  oidc: {
    issuer: env("OIDC_ISSUER"),
    clientId: env("OIDC_CLIENT_ID"),
    clientSecret: env("OIDC_CLIENT_SECRET"),
    scopes: env("OIDC_SCOPES", "openid email profile"),
  },
  allowSelfRegister: flag("ALLOW_SELF_REGISTER", true),
  allowedEmails: env("ALLOWED_EMAILS").toLowerCase().split(",").map((s) => s.trim()).filter(
    Boolean,
  ),
  sessionTtlMs: num("SESSION_TTL_HOURS", 168) * 3_600_000,
  // Deno KV caps a single atomic commit at ~800 KiB, so bodies are capped below that.
  maxBodyBytes: Math.min(num("MAX_BODY_BYTES", 524_288), 700_000),
  eventTtlMs: num("EVENT_RETENTION_DAYS", 7) * 86_400_000,
  logTtlMs: num("LOG_RETENTION_DAYS", 7) * 86_400_000,
};

export function assertConfig(): void {
  const missing = [];
  if (!config.oidc.issuer) missing.push("OIDC_ISSUER");
  if (!config.oidc.clientId) missing.push("OIDC_CLIENT_ID");
  if (missing.length) throw new Error(`Missing required env: ${missing.join(", ")}`);
}
