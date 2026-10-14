import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";

// This stack is an isolated probe. The routed Cire and OSN Workers keep their
// existing Wrangler deployments and secrets.
export default Alchemy.Stack(
  "osn-alchemy-dev-probe",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const stage = yield* Stage;
    if (stage !== "dev") {
      return yield* Effect.die("The Alchemy probe only runs at stage dev");
    }

    const cireDb = Cloudflare.D1.Database("CireDevDb", {
      name: "cire-db-dev",
    }).pipe(RemovalPolicy.retain());
    const cireSheets = Cloudflare.R2.Bucket("CireDevSheets", {
      name: "cire-sheets-dev",
    }).pipe(RemovalPolicy.retain());
    const cireAssets = Cloudflare.R2.Bucket("CireDevAssets", {
      name: "cire-assets-dev",
    }).pipe(RemovalPolicy.retain());
    const osnDb = Cloudflare.D1.Database("OsnDevDb", {
      name: "osn-db-dev",
    }).pipe(RemovalPolicy.retain());

    const cire = yield* Cloudflare.Worker("CireProbe", {
      name: "cire-api-alchemy-probe-dev",
      main: "./probe.ts",
      workersDev: true,
      compatibility: {
        date: "2025-03-01",
        flags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
      },
      observability: {
        enabled: true,
        headSamplingRate: 1,
        logs: { enabled: true, invocationLogs: false },
      },
      env: {
        PROBE_PRODUCT: "cire",
        DB: cireDb,
        SHEETS: cireSheets,
        ASSETS: cireAssets,
        IMAGES: Cloudflare.Images.Images("IMAGES"),
        CLAIM_RATE_LIMITER: Cloudflare.RateLimit("CLAIM_RATE_LIMITER", {
          namespaceId: "1101",
          simple: { limit: 5, period: 60 },
        }),
      },
    });

    const osn = yield* Cloudflare.Worker("OsnProbe", {
      name: "osn-api-alchemy-probe-dev",
      main: "./probe.ts",
      workersDev: true,
      compatibility: {
        date: "2025-03-01",
        flags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
      },
      observability: {
        enabled: true,
        headSamplingRate: 1,
      },
      env: {
        PROBE_PRODUCT: "osn",
        DB: osnDb,
        RL_AUTH_IP_5_60: Cloudflare.RateLimit("RL_AUTH_IP_5_60", {
          namespaceId: "2101",
          simple: { limit: 5, period: 60 },
        }),
      },
    });

    return { cireUrl: cire.url, osnUrl: osn.url };
  }),
);
