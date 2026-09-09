import { Effect } from "effect";

import {
  CurrentBackgroundSink,
  currentBackgroundSink,
  forkBackground,
  withBackgroundSink,
} from "../../../src/lib/background";

/**
 * A Worker that starts slow outbound-shaped work from inside a handler and
 * then returns, so a test can ask the only question that matters on workerd:
 * did the work still run after the response went out?
 *
 * `?mode=bypass` swaps `forkBackground` for the bare `Effect.forkDetach` this
 * branch replaced, so the red-proof is encoded here permanently rather than
 * performed once by hand.
 */

const WORK_MS = 250;

// The two lines `runThroughExit` performs per request. Importing the real
// runner here is not possible: it pulls in `@osn/db` and `@shared/email`,
// whose bundles carry a dynamic `import()` that Miniflare refuses
// (ERR_MODULE_DYNAMIC_SPEC). That the real runner performs these two lines is
// asserted instead at the vitest tier, in `tests/lib/background.test.ts`,
// where the runner does load. This fixture owns the half only workerd can
// answer: does work handed to `waitUntil` still run after the response?
const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> => {
  const sink = currentBackgroundSink();
  return Effect.runPromise(sink ? Effect.provideService(eff, CurrentBackgroundSink, sink) : eff);
};

let sendCompleted = false;
let handedToWaitUntil = 0;

export default {
  async fetch(request: Request, _env: unknown, ctx: { waitUntil: (p: Promise<unknown>) => void }) {
    const url = new URL(request.url);

    if (url.pathname === "/state") {
      return Response.json({ sendCompleted, handedToWaitUntil });
    }

    sendCompleted = false;
    handedToWaitUntil = 0;

    const bypass = url.searchParams.get("mode") === "bypass";

    // Counted before delegating, so the assertion "how many promises reached
    // waitUntil" is exact and needs no timing.
    const counting = {
      waitUntil: (p: Promise<unknown>) => {
        handedToWaitUntil += 1;
        ctx.waitUntil(p);
      },
    };

    const work = Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            sendCompleted = true;
            resolve();
          }, WORK_MS);
        }),
    );

    const body = await withBackgroundSink(counting, async () => {
      await run(bypass ? Effect.asVoid(Effect.forkDetach(work)) : forkBackground(work));
      return { completedAtResponse: sendCompleted };
    });

    return Response.json({ ...body, handedToWaitUntil });
  },
};
