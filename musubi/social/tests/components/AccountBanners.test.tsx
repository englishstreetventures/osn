// @vitest-environment happy-dom
import { AuthContext } from "@osn/client/solid";
import { cleanup, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The gate decides whether the banners exist at all, and it is the reason a
 * signed-out visitor pays nothing for them.
 *
 * The stack it mounts reaches `@simplewebauthn/browser` through the step-up
 * ceremony. This module is in the entry chunk — the one every anonymous
 * visitor downloads, `/authorize` included — so the stack must stay behind
 * both a dynamic import and a session check. The import is asserted in
 * `tests/webauthn-chunks.test.ts`; the session check is asserted here, by
 * counting how many times the lazily-imported module is loaded.
 */

const loads = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../src/components/AccountBannerStack", () => {
  loads.count += 1;
  return { default: () => <div data-testid="stack" /> };
});

import { AccountBanners } from "../../src/components/AccountBanners";

/** A `Resource`-shaped session accessor; only `session` is read here. */
function authValue(session: { accessToken: string } | null) {
  return {
    session: Object.assign(() => session, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: session,
      refetch: () => {},
      mutate: () => {},
    }),
  };
}

function renderGate(session: { accessToken: string } | null): () => JSX.Element {
  return () => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- only `session` is read
    <AuthContext.Provider value={authValue(session) as any}>
      <AccountBanners />
    </AuthContext.Provider>
  );
}

afterEach(() => {
  cleanup();
  loads.count = 0;
});

describe("<AccountBanners />", () => {
  it("renders nothing, and loads nothing, for a signed-out visitor", async () => {
    render(renderGate(null));

    await Promise.resolve();
    expect(screen.queryByTestId("stack")).toBeNull();
    // The assertion that matters: not merely that nothing painted, but that
    // the chunk was never fetched.
    expect(loads.count).toBe(0);
  });

  it("mounts the stack once a session exists", async () => {
    render(renderGate({ accessToken: "tkn" }));

    expect(await screen.findByTestId("stack")).toBeTruthy();
  });
});
