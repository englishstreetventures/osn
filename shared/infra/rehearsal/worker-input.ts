import type { SiteWorkerInput } from "../src/worker";
import {
  REHEARSAL_WORKER,
  rehearsalDomain,
  type RehearsalHosts,
  type RehearsalMode,
} from "./names";

/**
 * The rehearsal Worker: the marker page in `rehearsal/worker` (relative to
 * `shared/infra`, the stack's working directory), served from its custom
 * domain alone, on the spare host while `staged` and the moved host as
 * `worker`. Kept apart from names.ts so that the scripts, which load
 * names.ts with nothing installed, never reach the Worker types' imports.
 */
export function rehearsalWorkerInput(input: {
  readonly stage: string;
  readonly hosts: RehearsalHosts;
  readonly mode: RehearsalMode;
}): SiteWorkerInput {
  return {
    name: REHEARSAL_WORKER,
    stage: input.stage,
    directory: "rehearsal/worker",
    redirectsFile: true,
    entry: null,
    domain: rehearsalDomain(input.hosts, input.mode),
    workersDev: false,
    previewUrls: false,
    htmlHandling: "auto-trailing-slash",
    notFoundHandling: "none",
    issues: false,
  };
}
