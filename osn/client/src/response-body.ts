/**
 * The two response-body readers every client needs, in a module of their own
 * so that `./service.ts`, which every app loads at start, can use them without
 * pulling the rest of `./auth-fetch.ts` into the first chunk.
 */

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

/** A server error code: lower-case letters, digits and `_`, starting with a letter. */
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The `error` field of a parsed response body, as a code. A value that is not
 * a string matching {@link ERROR_CODE} is not a code, so this returns
 * `undefined` for it.
 */
export function errorCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as { error?: unknown }).error;
  return typeof value === "string" && ERROR_CODE.test(value) ? value : undefined;
}
