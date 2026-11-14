// @vitest-environment happy-dom
import { OsnApiError } from "@osn/client";
import { AuthContext } from "@osn/client/solid";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { ErrorBoundary, type JSX } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A refused revoke reads a fixed sentence from the copy map, never the text
 * the server sent with the refusal.
 */

const PLANTED = "PLANTED server text";

const list = vi.hoisted(() => ({
  fails: false,
  revoke: vi.fn(),
  /** A held answer for the next list read, when set. */
  next: null as Promise<unknown> | null,
}));

vi.mock("../../src/lib/authClients", () => ({
  connectionsClient: {
    list: () =>
      list.next
        ? (() => {
            const next = list.next;
            list.next = null;
            return next;
          })()
        : list.fails
          ? Promise.reject(new OsnApiError(PLANTED, 500, "internal_error"))
          : Promise.resolve({
              connections: [
                {
                  clientId: "client_1",
                  clientName: "Pulse",
                  logoUrl: null,
                  scope: "openid profile",
                },
              ],
            }),
    revoke: (...args: unknown[]) => {
      list.revoke(...args);
      return Promise.reject(new OsnApiError(PLANTED, 500, "internal_error"));
    },
  },
}));

import { ConnectedAppsSection } from "../../src/components/ConnectedAppsSection";

const newSession = () => ({ accessToken: "tkn", idToken: null, expiresAt: 0, scopes: [] });

/**
 * Signed in, as far as the page cache reads it: a landed session. A new
 * object per render gives each test a fresh cache, unless one is passed.
 */
function SignedIn(props: { children: JSX.Element; session?: object }) {
  const session = props.session ?? newSession();
  const value = { session: Object.assign(() => session, { state: "ready", latest: session }) };
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the slice of AuthContext the section reads
    <AuthContext.Provider value={value as any}>{props.children}</AuthContext.Provider>
  );
}

afterEach(() => {
  cleanup();
  list.fails = false;
  list.next = null;
  list.revoke.mockClear();
});

describe("<ConnectedAppsSection /> — a refused revoke", () => {
  it("names what failed in the copy map's words, without the server's text", async () => {
    render(() => (
      <SignedIn>
        <ConnectedAppsSection />
      </SignedIn>
    ));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).toContain("Couldn't revoke this app.");
    expect(alert.textContent).toContain("Something went wrong on our side. Try again.");
    expect(alert.textContent).not.toContain(PLANTED);
  });
});

describe("<ConnectedAppsSection /> — a list that fails to load", () => {
  // A failed read throws when read; the section must say so in its own line
  // rather than throw past it to the page's error boundary.
  it("says so in its own line and draws nothing else for the list", async () => {
    list.fails = true;
    let thrown: unknown;
    render(() => (
      <ErrorBoundary
        fallback={(err) => {
          thrown = err;
          return <p>BOUNDARY</p>;
        }}
      >
        <SignedIn>
          <ConnectedAppsSection />
        </SignedIn>
      </ErrorBoundary>
    ));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load your connected apps.");
    expect(alert.textContent).not.toContain(PLANTED);
    expect(thrown).toBeUndefined();
    expect(screen.queryByText("BOUNDARY")).toBeNull();
    expect(screen.queryByText(/haven't connected any apps/)).toBeNull();
  });
});

describe("<ConnectedAppsSection /> — an app the read in flight removes", () => {
  // Shown again, the list draws at once and is read again behind it. A
  // Revoke pressed meanwhile is busy, waits for that read, and sends nothing
  // for an app it took off.
  it("Revoke waits for the read and sends nothing for an app that has gone", async () => {
    const session = newSession();
    const first = render(() => (
      <SignedIn session={session}>
        <ConnectedAppsSection />
      </SignedIn>
    ));
    await screen.findByRole("button", { name: "Revoke" });
    first.unmount();

    let answer!: (value: unknown) => void;
    list.next = new Promise((resolve) => {
      answer = resolve;
    });
    render(() => (
      <SignedIn session={session}>
        <ConnectedAppsSection />
      </SignedIn>
    ));
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByRole("button", { name: "Revoking…" })).toBeDefined();
    answer({ connections: [] });
    await screen.findByText(/haven't connected any apps/);
    expect(list.revoke).not.toHaveBeenCalled();
  });
});
