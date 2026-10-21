import { Cause, Data, Effect, Option } from "effect";

import { parseTopic, type Signal, type SignalKind } from "../protocol";
import type { HubNamespace } from "./hub-namespace";
import { metricSignalPublished } from "./metrics";

class HubPublishError extends Data.TaggedError("HubPublishError")<{ readonly reason: string }> {}

export interface PublishOptions {
  /**
   * Members whose access changed but who may still hold it: the hub closes
   * their sockets with 4001 after the signal, so each reconnects and is checked
   * again. Each entry must be exactly the subject the product's `authenticate`
   * returned for that member, or it closes nothing.
   */
  readonly evictSubjects?: readonly string[];
  /**
   * Members who lost access: the hub closes their sockets with 1008 after the
   * signal, and the client stops instead of making refused reconnects. Same
   * matching rule as `evictSubjects`.
   */
  readonly revokeSubjects?: readonly string[];
  /** Overrides {@link PUBLISH_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Overrides {@link REVOKE_RETRY_DELAYS_MS}. */
  readonly revokeRetryDelaysMs?: readonly number[];
}

/** Longest a publish waits on the hub before it gives up on the signal. */
export const PUBLISH_TIMEOUT_MS = 2_000;

/**
 * The pauses, in milliseconds, before each further try of a publish that
 * revokes, after a hub call that failed or timed out. A revoke is the only
 * thing that closes a removed member's sockets before their hour is up, so it
 * gets more than one try; a publish that revokes nobody gets one, and a lost
 * signal is recovered by the client's next refetch. Every try runs inside the
 * same effect, so inside the same `waitUntil`: three tries at the default
 * timeout and these pauses end within 7 seconds.
 */
export const REVOKE_RETRY_DELAYS_MS: readonly number[] = [250, 750];

/**
 * Tell every open tab on `topic` that `kind` changed. Run it after the write
 * has committed, in the background — hand `runtime.runPromise(publish(...))`
 * to the request's `ctx.waitUntil` — so the write's response never waits on
 * the hub. It never fails: with no hub bound it does nothing but count, and a
 * hub that errors or is slow is logged and counted while the caller carries
 * on. A lost signal is recovered by the client's next refetch. A publish that
 * names `revokeSubjects` tries the hub again after each pause in
 * {@link REVOKE_RETRY_DELAYS_MS}, and when every try fails it logs
 * `realtime revoke failed` rather than `realtime publish failed`, so an alert
 * can tell a revoke that never reached the hub from a lost signal.
 */
export const publish = (
  hub: HubNamespace | undefined,
  topic: string,
  kind: SignalKind,
  options: PublishOptions = {},
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const parsed = parseTopic(topic);
    if (!parsed) {
      return Effect.logError("realtime publish refused a malformed topic").pipe(
        Effect.annotateLogs({ kind }),
      );
    }
    if (!hub) return Effect.sync(() => metricSignalPublished(parsed.product, kind, "disabled"));
    const signal: Signal = { topic, kind, at: Date.now() };
    const targets = { evict: options.evictSubjects ?? [], revoke: options.revokeSubjects ?? [] };
    const revoking = targets.revoke.length > 0;
    const send = Effect.tryPromise({
      try: () => hub.getByName(topic).publish(signal, targets),
      catch: (cause) => new HubPublishError({ reason: String(cause) }),
    }).pipe(Effect.timeout(options.timeoutMs ?? PUBLISH_TIMEOUT_MS));
    const pauses = revoking ? (options.revokeRetryDelaysMs ?? REVOKE_RETRY_DELAYS_MS) : [];
    // Each pause runs only after the try before it failed; a defect is not retried.
    const tries = pauses.reduce<typeof send>(
      (sent, pause) =>
        sent.pipe(Effect.catch(() => Effect.sleep(pause).pipe(Effect.andThen(send)))),
      send,
    );
    return tries.pipe(
      Effect.withSpan("realtime.publish", {
        attributes: { "realtime.product": parsed.product, "realtime.kind": kind },
      }),
      Effect.andThen(Effect.sync(() => metricSignalPublished(parsed.product, kind, "ok"))),
      Effect.catchCause((cause) =>
        Effect.logError(revoking ? "realtime revoke failed" : "realtime publish failed").pipe(
          Effect.annotateLogs({
            topic,
            kind,
            // How many members were to be closed, never who: a subject is the
            // product's member id.
            revoked: targets.revoke.length,
            tag: Option.match(Cause.findErrorOption(cause), {
              onNone: () => "defect",
              onSome: (error) => error._tag,
            }),
            reason: Cause.pretty(cause),
          }),
          Effect.andThen(Effect.sync(() => metricSignalPublished(parsed.product, kind, "error"))),
        ),
      ),
    );
  });
