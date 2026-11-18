import { describeAuthError, isAuthExpiredError } from "@osn/client";

/**
 * The words for a toast about an action that failed. A session that has ended
 * gets the copy map's sentence; any other error shows its own message when it
 * has one (the server's reason), else `fallback`.
 */
export function describeActionError(err: unknown, fallback: string): string {
  if (isAuthExpiredError(err)) return describeAuthError(err);
  if (err instanceof Error && err.message.length > 0) return err.message;
  return fallback;
}
