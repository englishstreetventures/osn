import { errorCode, safeJson } from "./response-body";
/**
 * Shared fetch and error helpers for every REST client in this package. Each
 * client throws its own error class, a subclass of `OsnApiError`; these
 * helpers take that class as a parameter so one implementation builds every
 * client's errors the same way:
 *
 *  - `reach` turns a transport failure into the client's error at status `0`,
 *    and lets a rejection that is about the session pass through as it is;
 *  - `readJson` turns a refusal, or a success whose body is not JSON, into the
 *    client's error with the response's status;
 *  - `responseError` builds that error, with the server's `error` code when it
 *    has the form `errorCode` (`./response-body.ts`) accepts.
 *
 * `createAuthFetchers` builds the helpers that `graph.ts`, `organisations.ts`
 * and `recommendations.ts` share on top of them. Each of those modules calls
 * the OSN core REST API through the page's `AuthFetch`, which sends the
 * access token and renews it. These routes need no cookie, so every request
 * says `credentials: "same-origin"`: `authFetch` defaults to `"include"`, and
 * the session cookie has no business riding on a graph or organisation call.
 *
 * Failure contract, for every client that sends through `authFetch`: a
 * rejection that is about the session (`AuthExpiredError`,
 * `TokenRefreshError`, `ActiveProfileResetError`, `StorageError`) and the
 * caller's own abort reach the caller unchanged; any other rejection is the
 * client's error at status `0`; a response that is not 2xx is the client's
 * error with the response's status and the server's code.
 */
import type { AuthFetch } from "./runtime";

export interface AuthFetchOptions {
  signal?: AbortSignal;
}

/** How every client error is built: the message, the HTTP status (0: no response), the server's code. */
export type ClientErrorCtor<E extends Error = Error> = new (
  message: string,
  status: number,
  code?: string,
) => E;

/**
 * `fetch`, `sessionFetch` for the routes that set the session cookie, or the
 * page's `authFetch` for the routes that need the access token.
 */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The `_tag`s of the `authFetch` rejections that say what happened to the
 * session rather than to the request (`./errors.ts`). Matched by tag so this
 * module, which every client imports, imports no Effect.
 */
const SESSION_REJECTIONS: ReadonlySet<unknown> = new Set([
  "AuthExpiredError",
  "TokenRefreshError",
  "ActiveProfileResetError",
  "StorageError",
]);

function isSessionRejection(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    SESSION_REJECTIONS.has((cause as { _tag?: unknown })._tag)
  );
}

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
 * status `0`, with two exceptions that pass through as they are: the caller
 * stopped the request itself (`init.signal` is aborted), or `authFetch` says
 * the session ended, could not be renewed, or moved to the default profile —
 * the provider and `isAuthExpiredError` read those, and none of them means
 * the server could not be reached.
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
    if (init?.signal?.aborted || isSessionRejection(cause)) throw cause;
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
 * class each caller throws, which is built with the message, the response's
 * HTTP status and the server's code.
 */
export function createAuthFetchers(ErrorCtor: ClientErrorCtor, authFetch: AuthFetch): AuthFetchers {
  const send = (url: string, init: RequestInit) => reach(ErrorCtor, url, init, authFetch);

  async function request<T>(
    url: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    body: unknown,
    options: AuthFetchOptions | undefined,
  ): Promise<T> {
    // POST and PATCH say JSON even with no body, as they always have; GET and
    // DELETE carry no body and say nothing.
    const sendsJson = method === "POST" || method === "PATCH";
    const res = await send(url, {
      method,
      credentials: "same-origin",
      headers: sendsJson ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: options?.signal,
    });
    return readJson<T>(ErrorCtor, res);
  }

  async function authDeleteVoid(url: string, options?: AuthFetchOptions): Promise<void> {
    const res = await send(url, {
      method: "DELETE",
      credentials: "same-origin",
      signal: options?.signal,
    });
    if (!res.ok) throw responseError(ErrorCtor, res, await safeJson(res));
  }

  return {
    authGet: (url, options) => request(url, "GET", undefined, options),
    authPost: (url, body, options) => request(url, "POST", body, options),
    authPatch: (url, body, options) => request(url, "PATCH", body, options),
    authDelete: (url, options) => request(url, "DELETE", undefined, options),
    authDeleteVoid,
  };
}
