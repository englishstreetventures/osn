/**
 * Shared bearer-token fetch helpers for this package's REST clients
 * (`graph.ts`, `organisations.ts`, `recommendations.ts`). Each of those
 * modules calls the OSN core REST API with `Authorization: Bearer <token>`
 * and throws its own error class on failure — `createAuthFetchers` takes
 * that error class as a parameter so one implementation can serve all
 * three.
 *
 * This is deliberately plain `fetch`, not `sessionFetch` from
 * `./session-fetch.ts`. `sessionFetch` is the seam for requests that carry
 * the HttpOnly session cookie — the seam iOS replaces with a Keychain-backed
 * transport, because a native app has no cookie jar. These three modules
 * send an access token in the `Authorization` header instead of relying on
 * a cookie, so there is no cookie for a native transport to supply, and
 * routing them through `sessionFetch` would be routing them through a seam
 * that has nothing to do with. Keep using plain `fetch` here.
 */

export interface AuthFetchOptions {
  signal?: AbortSignal;
}

/**
 * Parse response body as JSON, returning null if the body isn't JSON.
 * Prevents SyntaxError from surfacing to UI toasts (S-L2).
 */
export async function safeJson<T>(res: Response): Promise<(T & { error?: string }) | null> {
  try {
    return (await res.json()) as T & { error?: string };
  } catch {
    return null;
  }
}

/** Cap server-supplied error strings before surfacing to the UI (S-L2). */
export function safeErrorMessage(value: unknown, status: number): string {
  if (typeof value !== "string" || value.length === 0) return `Request failed: ${status}`;
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

export interface AuthFetchers {
  authGet<T>(url: string, token: string, options?: AuthFetchOptions): Promise<T>;
  authPost<T>(url: string, token: string, body?: unknown): Promise<T>;
  authPatch<T>(url: string, token: string, body: unknown): Promise<T>;
  /** For endpoints that return a JSON body on success (e.g. `{ ok: true }`). */
  authDelete<T>(url: string, token: string): Promise<T>;
  /** For callers that want no body back. Parses JSON only on the error path, so a
   * success response that is empty or unparseable still resolves. */
  authDeleteVoid(url: string, token: string): Promise<void>;
}

/** Build the four `auth*` helpers, parameterised on the error class each caller throws. */
export function createAuthFetchers(ErrorCtor: new (message: string) => Error): AuthFetchers {
  async function authGet<T>(url: string, token: string, options?: AuthFetchOptions): Promise<T> {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: options?.signal,
    });
    const json = await safeJson<T>(res);
    if (!res.ok) {
      throw new ErrorCtor(safeErrorMessage(json?.error, res.status));
    }
    if (json === null) {
      throw new ErrorCtor(`Invalid response: ${res.status}`);
    }
    return json;
  }

  async function authPost<T>(url: string, token: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await safeJson<T>(res);
    if (!res.ok) {
      throw new ErrorCtor(safeErrorMessage(json?.error, res.status));
    }
    if (json === null) {
      throw new ErrorCtor(`Invalid response: ${res.status}`);
    }
    return json;
  }

  async function authPatch<T>(url: string, token: string, body: unknown): Promise<T> {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = await safeJson<T>(res);
    if (!res.ok) {
      throw new ErrorCtor(safeErrorMessage(json?.error, res.status));
    }
    if (json === null) {
      throw new ErrorCtor(`Invalid response: ${res.status}`);
    }
    return json;
  }

  async function authDelete<T>(url: string, token: string): Promise<T> {
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await safeJson<T>(res);
    if (!res.ok) {
      throw new ErrorCtor(safeErrorMessage(json?.error, res.status));
    }
    if (json === null) {
      throw new ErrorCtor(`Invalid response: ${res.status}`);
    }
    return json;
  }

  async function authDeleteVoid(url: string, token: string): Promise<void> {
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const json = await safeJson<{ error?: string }>(res);
      throw new ErrorCtor(safeErrorMessage(json?.error, res.status));
    }
  }

  return { authGet, authPost, authPatch, authDelete, authDeleteVoid };
}
