import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";

import { checkProbeBoundary, PROBE, readWorkerConfigs } from "./boundary.ts";
import { probeToken, teardownRequested } from "./config.ts";
import { runMode } from "./run-mode.ts";
import {
  checkAdoptedStorage,
  DEV_BUCKET_SETTINGS,
  DEV_DATABASE_SETTINGS,
  type DeclaredStorage,
} from "./storage-preflight.ts";

// This stack is an isolated probe. The routed Cire and OSN Workers keep their
// existing Wrangler deployments and secrets; nothing here names them.

const stackDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// The settings Alchemy's post-adoption update converges each resource to;
// `checkAdoptedStorage` refuses the run unless the live resources already
// match, so adopting writes nothing.
const declaredStorage: DeclaredStorage = {
  buckets: Object.fromEntries(
    PROBE.cire.buckets.map((bucket) => [bucket.name, DEV_BUCKET_SETTINGS]),
  ),
  databases: Object.fromEntries(
    [PROBE.cire.database, PROBE.osn.database].map((database) => [
      database.name,
      { id: database.id, ...DEV_DATABASE_SETTINGS },
    ]),
  ),
};

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

    const { cire: cireProbe, osn: osnProbe } = PROBE;
    const [sheets, assets] = cireProbe.buckets;

    const cireDb = Cloudflare.D1.Database("CireDevDb", {
      name: cireProbe.database.name,
      ...DEV_DATABASE_SETTINGS,
    }).pipe(RemovalPolicy.retain());
    const cireSheets = Cloudflare.R2.Bucket("CireDevSheets", {
      name: sheets.name,
      ...DEV_BUCKET_SETTINGS,
    }).pipe(RemovalPolicy.retain());
    const cireAssets = Cloudflare.R2.Bucket("CireDevAssets", {
      name: assets.name,
      ...DEV_BUCKET_SETTINGS,
    }).pipe(RemovalPolicy.retain());
    const osnDb = Cloudflare.D1.Database("OsnDevDb", {
      name: osnProbe.database.name,
      ...DEV_DATABASE_SETTINGS,
    }).pipe(RemovalPolicy.retain());

    const cire = yield* Cloudflare.Worker("CireProbe", {
      name: cireProbe.worker,
      main: "./probe.ts",
      workersDev,
      compatibility,
      observability,
      env: {
        PROBE_PRODUCT: "cire",
        PROBE_TOKEN: probeToken,
        DB: cireDb,
        [sheets.binding]: cireSheets,
        [assets.binding]: cireAssets,
        IMAGES: Cloudflare.Images.Images("IMAGES"),
        [cireProbe.rateLimit.binding]: Cloudflare.RateLimit(cireProbe.rateLimit.binding, {
          namespaceId: cireProbe.rateLimit.namespaceId,
          simple: cireProbe.rateLimit.simple,
        }),
      },
    });

    const osn = yield* Cloudflare.Worker("OsnProbe", {
      name: osnProbe.worker,
      main: "./probe.ts",
      workersDev,
      compatibility,
      observability,
      env: {
        PROBE_PRODUCT: "osn",
        PROBE_TOKEN: probeToken,
        DB: osnDb,
        [osnProbe.rateLimit.binding]: Cloudflare.RateLimit(osnProbe.rateLimit.binding, {
          namespaceId: osnProbe.rateLimit.namespaceId,
          simple: osnProbe.rateLimit.simple,
        }),
      },
    });

    return { cireUrl: cire.url, osnUrl: osn.url };
  }),
);
