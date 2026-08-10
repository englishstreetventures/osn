import type { RpSession } from "@shared/rp-auth";
import { vi } from "vitest";

/**
 * Test double for `@shared/rp-auth/solid`.
 *
 * The browser holds no token under the BFF model, so a test says who is signed
 * in by setting `authState.session` — there is nothing else to stub.
 */

/** A signed-in viewer. Override any field per test. */
export function fakeSession(overrides: Partial<RpSession> = {}): RpSession {
  return {
    osnProfileId: "usr_test",
    email: "maya@example.com",
    handle: "maya",
    displayName: "Maya Chen",
    avatarUrl: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Mutable: set in `beforeEach` to choose the viewer. `null` is signed out. */
export const authState: { session: RpSession | null } = { session: null };

export const mockSignIn = vi.fn();
export const mockLogout = vi.fn(() => Promise.resolve());
export const mockRefresh = vi.fn(() => Promise.resolve(authState.session));

/** Factory for `vi.mock("@shared/rp-auth/solid", async () => rpAuthSolidMock())` */
export function rpAuthSolidMock() {
  return {
    useAuth: () => ({
      session: () => authState.session,
      activeProfileId: () => authState.session?.osnProfileId ?? null,
      authFetch: fetch,
      signIn: mockSignIn,
      logout: mockLogout,
      refresh: mockRefresh,
    }),
    AuthProvider: (props: { children?: unknown }) => props.children,
  };
}
