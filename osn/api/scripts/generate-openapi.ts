import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DbLive } from "@osn/db/service";
import { makeLogEmailLive } from "@shared/email";
import { generateOpenApiDocument } from "@shared/openapi-tools";
import { createMemoryClient } from "@shared/redis";
import { Layer } from "effect";

import { createApp } from "../src/app";
import { buildAppDeps } from "../src/build-deps";
import { osnLoggerLayer } from "../src/observability";

/**
 * Regenerates `shared/openapi/osn.json` from the live route definitions.
 * Boots the real app and fetches its own `/openapi/json` rather than
 * re-deriving the document by hand, so the committed spec can never drift from
 * what the app serves.
 *
 * The deps below are the cheapest ones that compose: the document is built from
 * static route schemas, so no request ever runs and nothing here is read for
 * its value. An empty env record takes `buildAppDeps`'s local-default path
 * (ephemeral JWT pair, memory limiters) — the non-local branches demand real
 * secrets this script has no business holding.
 *
 * Every fix applied to the plugin's raw output lives in `@shared/openapi-tools`,
 * shared with `pulse/api`.
 */

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const OUTPUT_PATH = resolve(join(SCRIPT_DIR, "../../../shared/openapi/osn.json"));

const built = await buildAppDeps(
  {},
  {
    redisClient: createMemoryClient(),
    dbAndEmailLayer: Layer.merge(DbLive, makeLogEmailLive().layer),
    observabilityLayer: osnLoggerLayer,
    includeObservabilityPlugin: false,
  },
);

const app = createApp(built.deps);
await generateOpenApiDocument({
  handle: (request) => app.handle(request),
  outputPath: OUTPUT_PATH,
  // ARC-gated service-to-service surface. Only other OSN services call these,
  // and they authenticate with signed ES256 tokens rather than a user session,
  // so a generated client has no use for them. Excluded here rather than in the
  // plugin's `exclude.paths` because that option ignores RegExp entries.
  excludePaths: [/^\/graph\/internal\//, /^\/organisations\/internal\//, /^\/internal\//],
});

// eslint-disable-next-line no-console -- CLI script output
console.log(`Wrote ${OUTPUT_PATH}`);
