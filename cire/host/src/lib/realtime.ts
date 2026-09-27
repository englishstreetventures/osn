// Where the organiser portal listens for changes to a wedding it shows.
// Frontend code: no Effect.
import { type FallbackOutcome, formatTopic } from "@shared/realtime";
import { sendFallbackBeacon } from "@shared/realtime/client";

import { apiUrl } from "./api";
import { CIRE_API_URL } from "./osn";

/**
 * The socket URL for one wedding's topic: cire-api's origin with `http`
 * swapped for `ws` (`https` → `wss`), then `/realtime/<topic>`. Null for an id
 * that cannot form a topic — the dashboard then does not listen.
 */
export function weddingTopicUrl(
  weddingId: string,
  apiOrigin: string = CIRE_API_URL,
): string | null {
  const topic = formatTopic("cire", "wedding", weddingId);
  if (!topic) return null;
  const base = apiOrigin.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/realtime/${encodeURIComponent(topic)}`;
}

/** Tell cire-api that this tab's push subscription gave up, and why. Never throws. */
export function reportRealtimeFallback(outcome: FallbackOutcome): void {
  sendFallbackBeacon(apiUrl("/api/realtime/fallback"), outcome);
}
