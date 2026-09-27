import { publish, type HubNamespace } from "@shared/realtime/server";
import { Effect } from "effect";

import { getWaitUntil } from "../lib/execution-ctx";
import { runCire } from "../observability";

/** The topic every open tab showing one wedding listens on. */
export const weddingTopic = (weddingId: string): string => `cire:wedding:${weddingId}`;

export interface WeddingSignals {
  /**
   * The wedding's seats changed. Call after the write has committed.
   * `revokedOsnProfileId` names a member who lost the dashboard: the hub sends
   * them the signal, then closes their sockets with 1008, so their tab re-reads
   * once and stops listening instead of reconnecting to be refused. `request`
   * is the write's own request: when the Worker registered an execution context
   * for it, the publish runs after the response in `waitUntil`, so the write
   * never waits on the hub. Never fails.
   */
  membersChanged(
    weddingId: string,
    request: Request,
    revokedOsnProfileId?: string,
  ): Effect.Effect<void>;
}

export const createWeddingSignals = (hub: HubNamespace | undefined): WeddingSignals => ({
  membersChanged: (weddingId, request, revokedOsnProfileId) => {
    const work = publish(
      hub,
      weddingTopic(weddingId),
      "members-changed",
      revokedOsnProfileId === undefined ? {} : { revokeSubjects: [revokedOsnProfileId] },
    );
    const waitUntil = getWaitUntil(request);
    // No execution context (unit tests, the local Bun server): run inline.
    return waitUntil ? Effect.sync(() => waitUntil(runCire(work))) : work;
  },
});
