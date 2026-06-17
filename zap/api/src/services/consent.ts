import { Data, Effect } from "effect";

import { metricAccessDenied } from "../metrics";
import { areConnected } from "./zapGraphBridge";

/**
 * Z3/Z4 — social-graph consent gate.
 *
 * A user may only pull another profile into a chat (create-with-members, or
 * add-member) when the two share a permitted social-graph relationship. The
 * decision is graph-gated *now* (connected ⇒ allowed) and the seam is kept
 * narrow so a future hybrid model (e.g. "connected OR opted-in to receive
 * messages") slots in behind this one boolean without touching the services.
 *
 * Fail-closed: if the OSN graph is unreachable the actor is NOT given the
 * benefit of the doubt — the add is rejected and a `blocked` denial metric is
 * emitted so a graph outage shows up as a spike rather than silently letting
 * arbitrary members through.
 */

export class ConsentDenied extends Data.TaggedError("ConsentDenied")<{
  /** The profile the actor was not permitted to add. */
  readonly targetProfileId: string;
  /** `not_connected` (definitive no) vs `graph_unreachable` (fail-closed). */
  readonly reason: "not_connected" | "graph_unreachable";
}> {}

/**
 * Resolves whether `viewerProfileId` is permitted to add `targetProfileId`.
 * Rejects (never resolves false) — the caller short-circuits on the first
 * tagged failure. Returns a Promise so it can be unit-overridden in tests
 * without an Effect runtime; the default implementation wraps the ARC bridge.
 */
export type ConsentGate = (viewerProfileId: string, targetProfileId: string) => Promise<boolean>;

/** Default gate — the real ARC-authenticated OSN graph lookup. */
const defaultGate: ConsentGate = (viewerProfileId, targetProfileId) =>
  Effect.runPromise(areConnected(viewerProfileId, targetProfileId));

let _gate: ConsentGate = defaultGate;

/**
 * Test seam. Replace the consent gate (e.g. always-true, always-false, or a
 * throwing gate to simulate a graph outage). Production code never calls this.
 */
export function setConsentGate(gate: ConsentGate): void {
  _gate = gate;
}

/** Restore the real ARC-backed gate. */
export function resetConsentGate(): void {
  _gate = defaultGate;
}

/**
 * Fail-closed consent check for a single (actor, target) pair. Surfaces:
 *   - success           → actor may add target
 *   - `not_connected`   → graph answered "no" (definitive)
 *   - `graph_unreachable` → the gate threw (network / HTTP); reject + metric
 *
 * The `blocked` denial metric (previously unwired) fires on both denial
 * reasons so probing and outages are both observable.
 */
export const checkConsent = (
  viewerProfileId: string,
  targetProfileId: string,
): Effect.Effect<void, ConsentDenied> =>
  Effect.gen(function* () {
    const allowed = yield* Effect.tryPromise({
      try: () => _gate(viewerProfileId, targetProfileId),
      catch: (cause) => cause,
    }).pipe(
      Effect.catchAll(() =>
        // Gate threw → graph unreachable → fail closed.
        Effect.gen(function* () {
          metricAccessDenied("members", "blocked");
          return yield* Effect.fail(
            new ConsentDenied({ targetProfileId, reason: "graph_unreachable" }),
          );
        }),
      ),
    );
    if (!allowed) {
      metricAccessDenied("members", "blocked");
      return yield* Effect.fail(new ConsentDenied({ targetProfileId, reason: "not_connected" }));
    }
  }).pipe(Effect.withSpan("zap.consent.check"));
