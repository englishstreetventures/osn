import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";

import { checkProbeBoundary, PROBE, readWorkerConfigs } from "./boundary.ts";
import { probeToken, teardownRequested } from "./config.ts";
import {
  CIRE_BUCKETS,
  CIRE_DATABASE,
  declaredStorage,
  OSN_DATABASE,
  unretainedStorage,
} from "./declarations.ts";
import { runMode } from "./run-mode.ts";
import { checkAdoptedStorage } from "./storage-preflight.ts";

// This stack is an isolated probe. The routed Cire and OSN Workers keep their
// existing Wrangler deployments and secrets; nothing here names them.

const stackDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const compatibility = {
  date: "2025-03-01",
  flags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
};

// One public URL per probe, and no per-request records: the probe logs
// nothing itself and its callers' requests are not kept.
const workersDev = { enabled: true, previewsEnabled: false };
const observability = {
  enabled: true,
  headSamplingRate: 1,
  logs: { enabled: true, invocationLogs: false },
};

export default Alchemy.Stack(
  "osn-alchemy-dev-probe",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const mode = runMode({
      stage: yield* Stage,
      cwd: realpathSync(process.cwd()),
      stackDir: realpathSync(stackDir),
      teardown: yield* teardownRequested,
    });
    if (mode.kind === "refuse") return yield* Effect.die(new Error(mode.reason));
    if (mode.kind === "teardown") return {};

    const boundary = checkProbeBoundary(readWorkerConfigs(repoRoot));
    if (boundary.length > 0) {
      return yield* Effect.die(
        new Error(
          `Refusing a probe that could reach beyond the dev tier:\n- ${boundary.join("\n- ")}`,
        ),
      );
    }

    yield* checkAdoptedStorage(declaredStorage);

    // Everything declared in this block is retained by default, so a
    // resource that loses its own `retain()` still survives destroy; the
    // check below refuses the run if any of them would not.
    const storage = yield* Effect.gen(function* () {
      const database = (declaration: typeof CIRE_DATABASE) =>
        Cloudflare.D1.Database(declaration.logicalId, {
          name: declaration.name,
          ...declaration.settings,
        }).pipe(RemovalPolicy.retain());
      const buckets = yield* Effect.forEach(CIRE_BUCKETS, (declaration) =>
        Cloudflare.R2.Bucket(declaration.logicalId, {
          name: declaration.name,
          ...declaration.settings,
        }).pipe(
          RemovalPolicy.retain(),
          Effect.map((bucket) => [declaration.binding, bucket] as const),
        ),
      );
      return {
        cireDb: yield* database(CIRE_DATABASE),
        osnDb: yield* database(OSN_DATABASE),
        buckets,
      };
    }).pipe(RemovalPolicy.retain());

    const unretained = unretainedStorage([
      storage.cireDb,
      storage.osnDb,
      ...storage.buckets.map(([, bucket]) => bucket),
    ]);
    if (unretained.length > 0) {
      return yield* Effect.die(new Error(`Refusing to adopt:\n- ${unretained.join("\n- ")}`));
    }

    const { cire: cireProbe, osn: osnProbe } = PROBE;

    const cire = yield* Cloudflare.Worker("CireProbe", {
      name: cireProbe.worker,
      main: "./probe.ts",
      workersDev,
      compatibility,
      observability,
      env: {
        PROBE_PRODUCT: "cire",
        PROBE_TOKEN: probeToken,
        DB: storage.cireDb,
        ...Object.fromEntries(storage.buckets),
        IMAGES: Cloudflare.Images.Images("IMAGES"),
        [cireProbe.rateLimit.binding]: Cloudflare.RateLimit(cireProbe.rateLimit.binding, {
          namespaceId: cireProbe.rateLimit.namespaceId,
          simple: cireProbe.rateLimit.simple,
        }),
      },
    }).pipe(RemovalPolicy.destroy());

    const osn = yield* Cloudflare.Worker("OsnProbe", {
      name: osnProbe.worker,
      main: "./probe.ts",
      workersDev,
      compatibility,
      observability,
      env: {
        PROBE_PRODUCT: "osn",
        PROBE_TOKEN: probeToken,
        DB: storage.osnDb,
        [osnProbe.rateLimit.binding]: Cloudflare.RateLimit(osnProbe.rateLimit.binding, {
          namespaceId: osnProbe.rateLimit.namespaceId,
          simple: osnProbe.rateLimit.simple,
        }),
      },
    }).pipe(RemovalPolicy.destroy());

    return { cireUrl: cire.url, osnUrl: osn.url };
  }),
);
