// Where the organiser portal listens for changes to a wedding it shows.
// Frontend code: no Effect.
import { formatTopic } from "@shared/realtime";

import { CIRE_API_URL } from "./osn";

/**
 * The socket URL for one wedding's topic: cire-api's origin with `http`
 * swapped for `ws` (`https` → `wss`), then `/realtime/<topic>`. Null for an id
 * that cannot form a topic — the dashboard then does not listen.
 */
export function weddingTopicUrl(weddingId: string, apiUrl: string = CIRE_API_URL): string | null {
  const topic = formatTopic("cire", "wedding", weddingId);
  if (!topic) return null;
  const base = apiUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/realtime/${encodeURIComponent(topic)}`;
}
