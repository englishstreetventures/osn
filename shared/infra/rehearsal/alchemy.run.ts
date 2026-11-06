import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

import { siteWorker } from "../src/declare";
import { parseDevDomain, readDevDomain } from "../src/hosts";
import { assertStackRetained } from "../src/removal";
import { stackOptions } from "../src/stack";
import { assertDeployTarget, refuseDotEnvFiles, refuseProductionTier } from "../src/target";
import {
  REHEARSAL_MODES,
  REHEARSAL_STACK,
  REHEARSAL_STAGE,
  RehearsalNameError,
  type RehearsalMode,
  rehearsalDomain,
  rehearsalHosts,
} from "./names";
import { rehearsalWorkerInput } from "./worker-input";

const isMode = (value: string): value is RehearsalMode =>
  REHEARSAL_MODES.some((mode) => mode === value);

/**
 * The domain move rehearsal's stack: one assets-only Worker serving the
 * marker page, on the spare host or the moved host as `REHEARSAL_MODE`
 * says, at the `domain-move` stage of the dev account alone. It declares no
 * secret and no storage, and its Worker is destroyed with the stage.
 * scripts/domain-move-rehearsal.ts runs it from `shared/infra` with
 * `rehearsal:deploy` and `rehearsal:destroy`.
 */
export const rehearsalStack = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly workingDir: string;
}) =>
  Effect.gen(function* () {
    const { env } = input;
    refuseDotEnvFiles(input.workingDir);
    const stage = assertDeployTarget(yield* Alchemy.Stage, env);
    refuseProductionTier(stage);
    if (stage !== REHEARSAL_STAGE) {
      throw new RehearsalNameError(
        `The rehearsal stack runs at stage '${REHEARSAL_STAGE}' alone, not '${stage}'.`,
      );
    }
    const mode = env.REHEARSAL_MODE ?? "";
    if (!isMode(mode)) {
      throw new RehearsalNameError(
        `REHEARSAL_MODE is '${mode}'; set it to ${REHEARSAL_MODES.join(" or ")}.`,
      );
    }
    const hosts = rehearsalHosts(parseDevDomain(readDevDomain(env)));
    // The logical id keys the state row, so it never changes.
    const worker = yield* siteWorker("RehearsalSite", rehearsalWorkerInput({ stage, hosts, mode }));
    assertStackRetained({ stage, storage: [], workers: [worker] });
    return { domain: rehearsalDomain(hosts, mode) };
  });

export default Alchemy.Stack(
  REHEARSAL_STACK,
  stackOptions(),
  rehearsalStack({ env: process.env, workingDir: process.cwd() }),
);
