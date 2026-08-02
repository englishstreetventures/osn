/**
 * Plain-fetch client for the recommendations API. Mirrors the pattern in
 * `./graph.ts` and `./organisations.ts`.
 */

export interface RecommendationClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

/** Why a profile was suggested. Mirrors `SuggestionReason` in `@osn/api`. */
export type SuggestionReason = "mutual_connections" | "shared_organisation";

export interface Suggestion {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  mutualCount: number;
  reason: SuggestionReason;
  /** An organisation the caller and this profile both belong to, if any. */
  sharedOrganisation: { handle: string; name: string } | null;
}

/** The caller's connection state with a search result. */
export type SearchConnectionState = "none" | "pending_sent" | "pending_received" | "connected";

export interface ProfileSearchResult {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  connectionStatus: SearchConnectionState;
}

export interface OrganisationSearchResult {
  /** The public address: `GET /organisations/:handle` resolves by handle. */
  handle: string;
  name: string;
  avatarUrl: string | null;
  /** Whether the caller already belongs to this organisation. */
  isMember: boolean;
}

export interface SearchResults {
  people: ProfileSearchResult[];
  organisations: OrganisationSearchResult[];
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
  /**
   * Search people and organisations for autocomplete. A query with no word
   * characters left after trimming and stripping a leading `@` comes back as
   * empty lists rather than an error.
   *
   * Result scope widens with query length: one character searches only the
   * caller's own connections and organisations, two reaches the global handle
   * index, three unlocks matching inside names.
   *
   * `signal` exists because this is typeahead: callers should abort the
   * in-flight request when the query changes, so a slow early keystroke can't
   * land after — and overwrite — a fast later one.
   */
  search(
    token: string,
    query: string,
    options?: { limit?: number; orgLimit?: number; signal?: AbortSignal },
  ): Promise<SearchResults>;
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

    search: async (token, query, options) => {
      const params = new URLSearchParams({ q: query });
      if (options?.limit !== undefined) params.set("limit", String(options.limit));
      if (options?.orgLimit !== undefined) params.set("orgLimit", String(options.orgLimit));
      const res = await fetch(`${base}/search?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: options?.signal,
      });
      const json = await safeJson<SearchResults>(res);
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
