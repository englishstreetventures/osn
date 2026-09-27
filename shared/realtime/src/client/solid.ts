import { type Accessor, createEffect, createMemo, on, onCleanup } from "solid-js";

import {
  createTopicSubscription,
  type SignalEvent,
  type SubscriptionOptions,
} from "./subscription";

/**
 * Keep one socket open to `url()` while it names one. The socket closes when
 * the URL changes, becomes null, or the owner is disposed. An accessor that
 * re-runs to the same string keeps the socket it has — the memo compares the
 * string, not whatever the accessor read to build it.
 */
export function useTopic(
  url: Accessor<string | null | undefined>,
  onSignal: (event: SignalEvent) => void,
  options?: SubscriptionOptions,
): void {
  const target = createMemo(() => url() ?? null);
  createEffect(
    on(target, (current) => {
      if (current === null) return;
      const subscription = createTopicSubscription(current, onSignal, options);
      onCleanup(() => subscription.close());
    }),
  );
}
