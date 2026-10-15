/**
 * The two values `alchemy.run.ts` reads from the operator's environment.
 */
import * as Config from "effect/Config";
import * as Schema from "effect/Schema";

import { MIN_PROBE_TOKEN_LENGTH } from "./probe.ts";

/**
 * `ALCHEMY_PROBE_TOKEN`, bound to both probes as a secret. A value shorter
 * than the Worker accepts fails the run instead of deploying a probe that
 * refuses every caller.
 */
export const probeToken = Config.schema(
  Schema.Redacted(Schema.String.check(Schema.isMinLength(MIN_PROBE_TOKEN_LENGTH))),
  "ALCHEMY_PROBE_TOKEN",
);

/** `ALCHEMY_PROBE_TEARDOWN=1`, set by the package's `destroy` script; see `run-mode.ts`. */
export const teardownRequested = Config.Boolean("ALCHEMY_PROBE_TEARDOWN").pipe(
  Config.withDefault(false),
);
