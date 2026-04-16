/**
 * Plain-fetch client for the recommendations API. Mirrors the pattern in
 * `./graph.ts` and `./organisations.ts`.
 */

export interface RecommendationClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

export interface Suggestion {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  mutualCount: number;
}

export class RecommendationClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecommendationClientError";
  }
}

async function safeJson<T>(res: Response): Promise<(T & { error?: string }) | null> {
  try {
    return (await res.json()) as T & { error?: string };
  } catch {
    return null;
  }
}

function safeErrorMessage(value: unknown, status: number): string {
  if (typeof value !== "string" || value.length === 0) return `Request failed: ${status}`;
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

export interface RecommendationClient {
  suggestConnections(
    token: string,
    options?: { limit?: number },
  ): Promise<{ suggestions: Suggestion[] }>;
}

export function createRecommendationClient(
  config: RecommendationClientConfig,
): RecommendationClient {
  const base = `${config.issuerUrl.replace(/\/$/, "")}/recommendations`;

  return {
    suggestConnections: async (token, options) => {
      const limit = options?.limit;
      const qs = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : "";
      const res = await fetch(`${base}/connections${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await safeJson<{ suggestions: Suggestion[] }>(res);
      if (!res.ok) {
        throw new RecommendationClientError(safeErrorMessage(json?.error, res.status));
      }
      if (json === null) {
        throw new RecommendationClientError(`Invalid response: ${res.status}`);
      }
      return json;
    },
  };
}
