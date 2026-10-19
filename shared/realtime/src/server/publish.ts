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
}

/** Longest a publish waits on the hub before it gives up on the signal. */
export const PUBLISH_TIMEOUT_MS = 2_000;

/**
 * Tell every open tab on `topic` that `kind` changed. Run it after the write
 * has committed, in the background — hand `runtime.runPromise(publish(...))`
 * to the request's `ctx.waitUntil` — so the write's response never waits on
 * the hub. It never fails: with no hub bound it does nothing but count, and a
 * hub that errors or is slow is logged and counted while the caller carries
 * on. A lost signal is recovered by the client's next refetch.
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
    return Effect.tryPromise({
      try: () => hub.getByName(topic).publish(signal, targets),
      catch: (cause) => new HubPublishError({ reason: String(cause) }),
    }).pipe(
      Effect.timeout(options.timeoutMs ?? PUBLISH_TIMEOUT_MS),
      Effect.withSpan("realtime.publish", {
        attributes: { "realtime.product": parsed.product, "realtime.kind": kind },
      }),
      Effect.andThen(Effect.sync(() => metricSignalPublished(parsed.product, kind, "ok"))),
      Effect.catchCause((cause) =>
        Effect.logError("realtime publish failed").pipe(
          Effect.annotateLogs({
            topic,
            kind,
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
