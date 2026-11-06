import type { AuthFetch } from "./runtime";

/**
 * Shared request helpers for this package's REST clients (`graph.ts`,
 * `organisations.ts`, `recommendations.ts`). Each of those modules calls the
 * OSN core REST API through the page's `AuthFetch` — which sends the access
 * token and renews it — and throws its own error class on failure;
 * `createAuthFetchers` takes that error class as a parameter so one
 * implementation can serve all three.
 *
 * These routes need no cookie, so every request says `credentials:
 * "same-origin"`: `authFetch` defaults to `"include"`, and the session cookie
 * has no business riding on a graph or organisation call.
 *
 * Failure contract: a rejection of `authFetch` (`AuthExpiredError`, the
 * transport error `fetch` gave, `TokenRefreshError`, `ActiveProfileResetError`)
 * reaches the caller unchanged; a response that is not 2xx becomes the
 * client's own error class, with the response's status.
 */

export interface AuthFetchOptions {
  signal?: AbortSignal;
}

/**
 * Parse response body as JSON, returning null if the body isn't JSON.
 * Prevents SyntaxError from surfacing to UI toasts.
 */
export async function safeJson<T>(res: Response): Promise<(T & { error?: string }) | null> {
  try {
    return (await res.json()) as T & { error?: string };
  } catch {
    return null;
  }
}

/** Cap server-supplied error strings before surfacing to the UI. */
export function safeErrorMessage(value: unknown, status: number): string {
  if (typeof value !== "string" || value.length === 0) return `Request failed: ${status}`;
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

/** Shared `?limit=&offset=` pagination query builder for the package's list endpoints. */
export function qs(options?: { limit?: number; offset?: number }): string {
  if (!options) return "";
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  const str = params.toString();
  return str ? `?${str}` : "";
}

export interface AuthFetchers {
  authGet<T>(url: string, options?: AuthFetchOptions): Promise<T>;
  authPost<T>(url: string, body?: unknown, options?: AuthFetchOptions): Promise<T>;
  authPatch<T>(url: string, body: unknown, options?: AuthFetchOptions): Promise<T>;
  /** For endpoints that return a JSON body on success (e.g. `{ ok: true }`). */
  authDelete<T>(url: string, options?: AuthFetchOptions): Promise<T>;
  /** For callers that want no body back. Parses JSON only on the error path, so a
   * success response that is empty or unparseable still resolves. */
  authDeleteVoid(url: string, options?: AuthFetchOptions): Promise<void>;
}

/**
 * Build the five `auth*` helpers on `authFetch`, parameterised on the error
 * class each caller throws. The class is constructed with the message and the
 * response's HTTP status; a class that has no use for the status takes the
 * message alone.
 */
export function createAuthFetchers(
  ErrorCtor: new (message: string, status: number) => Error,
  authFetch: AuthFetch,
): AuthFetchers {
  async function request<T>(
    url: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    body: unknown,
    options: AuthFetchOptions | undefined,
  ): Promise<T> {
    // POST and PATCH say JSON even with no body, as they always have; GET and
    // DELETE carry no body and say nothing.
    const sendsJson = method === "POST" || method === "PATCH";
    const res = await authFetch(url, {
      method,
      credentials: "same-origin",
      headers: sendsJson ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: options?.signal,
    });
    const json = await safeJson<T>(res);
    if (!res.ok) {
      throw new ErrorCtor(safeErrorMessage(json?.error, res.status), res.status);
    }
    if (json === null) {
      throw new ErrorCtor(`Invalid response: ${res.status}`, res.status);
    }
    return json;
  }

  async function authDeleteVoid(url: string, options?: AuthFetchOptions): Promise<void> {
    const res = await authFetch(url, {
      method: "DELETE",
      credentials: "same-origin",
      signal: options?.signal,
    });
    if (!res.ok) {
      const json = await safeJson<{ error?: string }>(res);
      throw new ErrorCtor(safeErrorMessage(json?.error, res.status), res.status);
    }
  }

  return {
    authGet: (url, options) => request(url, "GET", undefined, options),
    authPost: (url, body, options) => request(url, "POST", body, options),
    authPatch: (url, body, options) => request(url, "PATCH", body, options),
    authDelete: (url, options) => request(url, "DELETE", undefined, options),
    authDeleteVoid,
  };
}
