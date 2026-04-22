import type { Session } from "@osn/client";
import { AuthProvider, useAuth } from "@osn/client/solid";
// @vitest-environment happy-dom
import { render, cleanup, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, it, expect, beforeEach } from "vitest";

/**
 * T-M2: assert that AuthProvider.adoptSession persists a session via the
 * underlying OsnAuth.setSession call AND triggers a refetch so consumers of
 * useAuth().session() see the new value. This is the only path the
 * registration flow uses to install a session into the auth context, so a
 * regression here (e.g. forgetting to refetch) would silently leave the user
 * "logged in" at the storage layer but invisible to the UI.
 */

function AdoptHarness(props: { session: Session }) {
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

describe("AuthProvider.adoptSession", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("persists the session and updates session() so consumers see it", async () => {
    const fixture: Session = {
      accessToken: "acc_adopt",
      refreshToken: "ref_adopt",
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: ["openid", "profile"],
    };

    render(() => (
      <AuthProvider config={{ issuerUrl: "https://osn.example.com" }}>
        <AdoptHarness session={fixture} />
      </AuthProvider>
    ));

    // Initially anonymous (no session in storage).
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("anon");
    });

    screen.getByTestId("adopt").click();

    // After adoptSession, the resource should refetch and the harness should
    // reflect the new session.
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("signed-in:acc_adopt");
    });

    // And the session must have been written through to localStorage so a
    // page reload would still see it. P4 stores under the account_session key.
    const stored = localStorage.getItem("@osn/client:account_session");
    expect(stored).not.toBeNull();
    const account = JSON.parse(stored!);
    const activeToken = account.profileTokens[account.activeProfileId];
    expect(activeToken.accessToken).toBe("acc_adopt");
  });

  it("overwrites a previously adopted session", async () => {
    const first: Session = {
      accessToken: "first",
      refreshToken: null,
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: [],
    };
    const second: Session = { ...first, accessToken: "second" };

    function Harness() {
      const { session, adoptSession } = useAuth();
      return (
        <div>
          <p data-testid="status">{session()?.accessToken ?? "anon"}</p>
          <button data-testid="first" onClick={() => void adoptSession(first)}>
            First
          </button>
          <button data-testid="second" onClick={() => void adoptSession(second)}>
            Second
          </button>
        </div>
      );
    }

    render(() => (
      <AuthProvider config={{ issuerUrl: "https://osn.example.com" }}>
        <Harness />
      </AuthProvider>
    ));

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("anon"));

    screen.getByTestId("first").click();
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("first"));

    screen.getByTestId("second").click();
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("second"));
  });
});
