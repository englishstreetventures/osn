import { publish, type HubNamespace } from "@shared/realtime/server";
import { Effect } from "effect";

import { getWaitUntil } from "../lib/execution-ctx";
import { runCire } from "../observability";

/** The topic every open tab showing one wedding listens on. */
export const weddingTopic = (weddingId: string): string => `cire:wedding:${weddingId}`;

export interface WeddingSignals {
  /**
   * The wedding's hosts changed. Call after the write has committed.
   * `affectedOsnProfileId` is a co-host who may have lost the dashboard: their
   * sockets are closed after the signal, so they reconnect and have their
   * access checked again. `request` is the write's own request: when the Worker
   * registered an execution context for it, the publish runs after the
   * response in `waitUntil`, so the write never waits on the hub. Never fails.
   */
  membersChanged(
    weddingId: string,
    affectedOsnProfileId: string | undefined,
    request: Request,
  ): Effect.Effect<void>;
}

export const createWeddingSignals = (hub: HubNamespace | undefined): WeddingSignals => ({
  membersChanged: (weddingId, affectedOsnProfileId, request) => {
    const work = publish(
      hub,
      weddingTopic(weddingId),
      "members-changed",
      affectedOsnProfileId === undefined ? {} : { evictSubjects: [affectedOsnProfileId] },
    );
    const waitUntil = getWaitUntil(request);
    // No execution context (unit tests, the local Bun server): run inline.
    return waitUntil ? Effect.sync(() => waitUntil(runCire(work))) : work;
  },
});
