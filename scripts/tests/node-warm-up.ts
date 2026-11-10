// Node's first start on a fresh GitHub runner is slow, and the first test to
// start Node pays for it inside its own time limit. A file whose tests start
// Node awaits warmUpNode() in a `beforeAll` with NODE_WARM_UP_LIMIT_MS, so
// each test then times a warm start. `bun test ./scripts/` runs its files one
// after another in one process, in an order that changes as files are added,
// so every such file warms up, not only the one that runs first today.

import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = join(import.meta.dir, "..", "guest-route-parity-reference.js");

/**
 * How long a hook may wait for warmUpNode(). In 84 runs of the Scripts job the
 * first Node start took 193 ms at the median, 1.66 s at p90 and 2.87 s at
 * most, and once more than 5 s: in job 128039607055 bun's 5 s test limit cut
 * it, and the next start still took 1.9 s. Later starts took 23–41 ms.
 */
export const NODE_WARM_UP_LIMIT_MS = 30_000;

let warming: Promise<number> | undefined;

/**
 * Starts Node on scripts/guest-route-parity-reference.js with no arguments,
 * once per process, and resolves with how long that start took, in ms. With
 * no arguments the child exits 2 at its usage check, before it loads
 * wrangler, so exit 2 and its usage line show Node ran it. Rejects otherwise.
 */
export function warmUpNode(): Promise<number> {
  warming ??= (async () => {
    const from = performance.now();
    const proc = Bun.spawn(["node", CHILD], {
      cwd: tmpdir(),
      env: { PATH: Bun.env.PATH ?? "" },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    const ms = Math.round(performance.now() - from);
    if (exitCode !== 2 || !stderr.includes("usage: guest-route-parity-reference.js")) {
      throw new Error(`Node's warm-up start exited ${exitCode} after ${ms} ms: ${stderr}`);
    }
    return ms;
  })();
  return warming;
}
