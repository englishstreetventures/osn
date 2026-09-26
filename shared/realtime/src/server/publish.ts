import { Cause, Data, Effect } from "effect";

import { parseTopic, type Signal, type SignalKind } from "../protocol";
import type { HubNamespace } from "./hub-namespace";
import { metricSignalPublished } from "./metrics";

class HubPublishError extends Data.TaggedError("HubPublishError")<{ readonly reason: string }> {}

export interface PublishOptions {
  /**
   * Subjects whose sockets the hub closes after sending the signal, so each
   * reconnects and has its membership checked again.
   */
  readonly evictSubjects?: readonly string[];
  /** Overrides {@link PUBLISH_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** Longest a write waits on the hub before it gives up on the signal. */
export const PUBLISH_TIMEOUT_MS = 2_000;

/**
 * Tell every open tab on `topic` that `kind` changed. Run it after the write
 * has committed. It never fails: with no hub bound it does nothing, and a hub
 * that errors or is slow is logged and counted while the caller carries on —
 * a lost signal is recovered by the client's next refetch.
 */
export const publish = (
  hub: HubNamespace | undefined,
  topic: string,
  kind: SignalKind,
  options: PublishOptions = {},
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const parsed = parseTopic(topic);
    if (!parsed) return Effect.logError("realtime publish refused a malformed topic", { kind });
    if (!hub) return Effect.sync(() => metricSignalPublished(parsed.product, kind, "disabled"));
    const signal: Signal = { topic, kind, at: Date.now() };
    return Effect.tryPromise({
      try: () => hub.getByName(topic).publish(signal, options.evictSubjects ?? []),
      catch: (cause) => new HubPublishError({ reason: String(cause) }),
    }).pipe(
      Effect.timeout(options.timeoutMs ?? PUBLISH_TIMEOUT_MS),
      Effect.andThen(Effect.sync(() => metricSignalPublished(parsed.product, kind, "ok"))),
      Effect.catchCause((cause) =>
        Effect.logError("realtime publish failed", {
          topic,
          kind,
          reason: Cause.pretty(cause),
        }).pipe(
          Effect.andThen(Effect.sync(() => metricSignalPublished(parsed.product, kind, "error"))),
        ),
      ),
      Effect.withSpan("realtime.publish", {
        attributes: { "realtime.product": parsed.product, "realtime.kind": kind },
      }),
    );
  });
