import { assertConfig, config } from "./src/config.ts";
import { createHandler } from "./src/app.ts";
import { log } from "./src/logs.ts";

assertConfig();

Deno.serve({
  hostname: config.host,
  port: config.port,
  onListen: ({ hostname, port }) => {
    log("info", "system", `meowhook listening on ${hostname}:${port} (${config.baseUrl})`, {
      data: { selfRegister: config.allowSelfRegister, issuer: config.oidc.issuer },
    });
  },
}, createHandler());
