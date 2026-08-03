import type { Session } from "@osn/client";
import { createEphemeralStorage } from "@osn/client";
import { AuthProvider, useAuth } from "@osn/client/solid";
// @vitest-environment happy-dom
import { render, cleanup, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, it, expect, beforeEach } from "vitest";

/**
 * Task 12: on iOS, `AuthProvider` is given `createEphemeralStorage()` instead
 * of the default `StorageLive` so nothing from the auth session reaches
 * `localStorage`. These tests pin the two behaviours that guard: the memory
 * layer leaks nothing, and the unmodified default (no `storage` prop) still
 * persists — so this can't silently regress into "nobody stores anything
 * anywhere".
 */

const fixture: Session = {
  accessToken: "acc_ios",
  refreshToken: "ref_ios",
  idToken: null,
  expiresAt: Date.now() + 60_000,
  scopes: ["openid", "profile"],
};

function LoginHarness(props: { session: Session }) {
  const { session, adoptSession } = useAuth();
  return (
    <div>
      <p data-testid="status">{session() ? `signed-in:${session()!.accessToken}` : "anon"}</p>
      <button data-testid="adopt" onClick={() => void adoptSession(props.session)}>
        Adopt
      </button>
    </div>
  );
}

async function login(storage?: Parameters<typeof AuthProvider>[0]["storage"]) {
  render(() => (
    <AuthProvider config={{ issuerUrl: "https://osn.example.com" }} storage={storage}>
      <LoginHarness session={fixture} />
    </AuthProvider>
  ));

  await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("anon"));
  screen.getByTestId("adopt").click();
  await waitFor(() => {
    expect(screen.getByTestId("status").textContent).toBe("signed-in:acc_ios");
  });
}

describe("AuthProvider storage layer selection", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("leaves localStorage completely empty after a full login when given the ephemeral layer", async () => {
    await login(createEphemeralStorage());

    // The whole store, not just the account-session key — the point is that
    // nothing leaks, including keys a future change might add.
    expect(localStorage.length).toBe(0);
  });

  it("still persists to localStorage after a full login when no storage prop is passed, because that defaults to StorageLive", async () => {
    await login(undefined);

    const stored = localStorage.getItem("@osn/client:account_session");
    expect(stored).not.toBeNull();
    const account = JSON.parse(stored!);
    expect(account.profileTokens[account.activeProfileId].accessToken).toBe("acc_ios");
  });
});
