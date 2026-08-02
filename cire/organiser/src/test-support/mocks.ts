import { vi } from "vitest";

/**
 * Shared module mocks for the organiser component suites.
 *
 * Nearly every organiser component sits behind the same three collaborators —
 * the OSN auth context, the api-url/auth-expiry helpers, and solid-toast — so
 * each suite was re-declaring an identical set of spies and `vi.mock` factory
 * bodies. Registration still has to live in the test file (`vi.mock` is hoisted
 * per module), but the factory bodies and the spies belong here.
 *
 * Use the dynamic-import idiom so the factory never touches a binding the
 * hoisted `vi.mock` call hasn't initialised yet:
 *
 *   vi.mock("../lib/api", async () => {
 *     const { organiserApiMock } = await import("../test-support/mocks");
 *     return organiserApiMock();
 *   });
 *
 * Suites needing a different shape (an extra `useAuth` field, a partial
 * `importOriginal` spread, per-test toast assertions) keep their own local
 * mock — this covers the common case, it isn't a mandate.
 */

/** `authFetch` from the mocked `useAuth()`. Set per test with `mockResolvedValue`. */
export const authFetchMock = vi.fn();
/** Called when the mocked `redirectToLogin()` fires. */
export const redirectSpy = vi.fn();
/** Receives the message passed to `toast.success(...)`. */
export const toastSuccess = vi.fn();
/** Receives the message passed to `toast.error(...)`. */
export const toastError = vi.fn();

/** Factory for `vi.mock("@shared/rp-auth/solid", ...)`. */
export function rpAuthSolidMock() {
  return { useAuth: () => ({ authFetch: authFetchMock }) };
}

/** Factory for `vi.mock("solid-toast", ...)`. */
export function solidToastMock() {
  return {
    toast: {
      success: (m: string) => toastSuccess(m),
      error: (m: string) => toastError(m),
    },
  };
}

/** Factory for `vi.mock("../lib/api", ...)`. */
export function organiserApiMock() {
  return {
    apiUrl: (path: string) => `https://api.test${path}`,
    isAuthExpired: (err: unknown) => String(err).includes("AuthExpiredError"),
    redirectToLogin: () => redirectSpy(),
  };
}

/** Clears every shared spy — call from `afterEach` alongside `cleanup()`. */
export function resetOrganiserMocks(): void {
  authFetchMock.mockReset();
  redirectSpy.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
}
