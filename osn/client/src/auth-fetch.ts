/**
 * Shared fetch and error helpers for every REST client in this package. Each
 * client throws its own error class, a subclass of `OsnApiError`; these
 * helpers take that class as a parameter so one implementation builds every
 * client's errors the same way:
 *
 *  - `reach` turns a transport failure into the client's error at status `0`;
 *  - `readJson` turns a refusal, or a success whose body is not JSON, into the
 *    client's error with the response's status;
 *  - `responseError` builds that error, with the server's `error` code when it
 *    has the form `errorCode` (`./response-body.ts`) accepts.
 *
 * `createAuthFetchers` builds the bearer-token helpers that `graph.ts`,
 * `organisations.ts` and `recommendations.ts` share on top of them.
 *
 * Those three use plain `fetch`, not `sessionFetch` from
 * `./session-fetch.ts`. `sessionFetch` is the seam for requests that carry
 * the HttpOnly session cookie — the seam iOS replaces with a Keychain-backed
 * transport, because a native app has no cookie jar. These three modules
 * send an access token in the `Authorization` header instead of relying on
 * a cookie, so there is no cookie for a native transport to supply, and
 * routing them through `sessionFetch` would be routing them through a seam
 * that has nothing to do with. Keep using plain `fetch` there.
 */

import { errorCode, safeJson } from "./response-body";

export interface AuthFetchOptions {
  signal?: AbortSignal;
}

/** How every client error is built: the message, the HTTP status (0: no response), the server's code. */
export type ClientErrorCtor<E extends Error = Error> = new (
  message: string,
  status: number,
  code?: string,
) => E;

/** `fetch`, or `sessionFetch` for the routes that set the session cookie. */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

/** Cap server-supplied error strings before surfacing to the UI. */
export function safeErrorMessage(value: unknown, status: number): string {
  if (typeof value !== "string" || value.length === 0) return `Request failed: ${status}`;
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

/**
 * The error for a response the caller cannot use. A refusal carries its
 * status, the server's message capped by {@link safeErrorMessage}, and the
 * server's code; a success whose body is not what the route sends carries its
 * status and no code.
 */
export function responseError<E extends Error>(
  ErrorCtor: ClientErrorCtor<E>,
  res: Response,
  body: unknown,
): E {
  if (res.ok) return new ErrorCtor(`Invalid response: ${res.status}`, res.status);
  const error =
    typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  return new ErrorCtor(safeErrorMessage(error, res.status), res.status, errorCode(body));
}

/**
 * Send a request. A rejection — offline, DNS, CORS — becomes `ErrorCtor` at
 * status `0`, except when `init.signal` is aborted: the caller stopped the
 * request itself, so its abort reason passes through as it is.
 */
export async function reach(
  ErrorCtor: ClientErrorCtor,
  url: string,
  init?: RequestInit,
  transport?: Transport,
): Promise<Response> {
  try {
    return await (transport ? transport(url, init ?? {}) : fetch(url, init));
  } catch (cause) {
    if (init?.signal?.aborted) throw cause;
    throw new ErrorCtor("Could not reach the server", 0);
  }
}

/**
 * Read a JSON body the caller needs. Throws `ErrorCtor` (see
 * {@link responseError}) when the response is a refusal or its body is not
 * JSON, so a success never resolves to `null`.
 */
export async function readJson<T>(
  ErrorCtor: ClientErrorCtor,
  res: Response,
): Promise<T & { error?: string }> {
  const body = await safeJson<T>(res);
  if (!res.ok || body === null) throw responseError(ErrorCtor, res, body);
  return body;
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
  authGet<T>(url: string, token: string, options?: AuthFetchOptions): Promise<T>;
  authPost<T>(url: string, token: string, body?: unknown, options?: AuthFetchOptions): Promise<T>;
  authPatch<T>(url: string, token: string, body: unknown, options?: AuthFetchOptions): Promise<T>;
  /** For endpoints that return a JSON body on success (e.g. `{ ok: true }`). */
  authDelete<T>(url: string, token: string, options?: AuthFetchOptions): Promise<T>;
  /** For callers that want no body back. Parses JSON only on the error path, so a
   * success response that is empty or unparseable still resolves. */
  authDeleteVoid(url: string, token: string, options?: AuthFetchOptions): Promise<void>;
}

/**
 * Build the five `auth*` helpers, parameterised on the error class each caller
 * throws, which is built with the message, the response's HTTP status and the
 * server's code.
 */
export function createAuthFetchers(ErrorCtor: ClientErrorCtor): AuthFetchers {
  const send = (url: string, init: RequestInit) => reach(ErrorCtor, url, init);

  async function authGet<T>(url: string, token: string, options?: AuthFetchOptions): Promise<T> {
    const res = await send(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: options?.signal,
    });
    return readJson<T>(ErrorCtor, res);
  }

  async function authPost<T>(
    url: string,
    token: string,
    body?: unknown,
    options?: AuthFetchOptions,
  ): Promise<T> {
    const res = await send(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: options?.signal,
    });
    return readJson<T>(ErrorCtor, res);
  }

  async function authPatch<T>(
    url: string,
    token: string,
    body: unknown,
    options?: AuthFetchOptions,
  ): Promise<T> {
    const res = await send(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    return readJson<T>(ErrorCtor, res);
  }

  async function authDelete<T>(url: string, token: string, options?: AuthFetchOptions): Promise<T> {
    const res = await send(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: options?.signal,
    });
    return readJson<T>(ErrorCtor, res);
  }

  async function authDeleteVoid(
    url: string,
    token: string,
    options?: AuthFetchOptions,
  ): Promise<void> {
    const res = await send(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: options?.signal,
    });
    if (!res.ok) throw responseError(ErrorCtor, res, await safeJson(res));
  }

  return { authGet, authPost, authPatch, authDelete, authDeleteVoid };
}
