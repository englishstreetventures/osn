// @vitest-environment happy-dom
import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A session pending deletion sees the window screen and nothing of the shell:
 * not the rail or the top bar, not `ShellNotices` (which binds the page
 * cache), not `AccountBanners`, not the page. Each of those sends requests a
 * pending session is refused. The second case is the control: the same
 * stand-ins do mount for an ordinary session, so the first case cannot pass
 * by a stand-in failing to render.
 */

const auth = vi.hoisted(() => ({ pending: true }));

vi.mock("@osn/client/solid", async () => {
  const actual = await vi.importActual<typeof import("@osn/client/solid")>("@osn/client/solid");
  const resource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: value,
      refetch: () => {},
      mutate: () => {},
    });
  return {
    ...actual,
    AuthProvider: (props: { children?: unknown }) => (
      <actual.AuthContext.Provider
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
        value={
          {
            session: resource({ accessToken: "not-a-jwt", expiresAt: Date.now() + 60_000 }),
            profiles: resource(null),
            profilesError: () => undefined,
            activeProfileId: () => "usr_alice",
            pendingDeletion: () => auth.pending,
          } as any
        }
      >
        {props.children as never}
      </actual.AuthContext.Provider>
    ),
  };
});
vi.mock("../src/components/Sidebar", () => ({ Sidebar: () => <div data-testid="sidebar" /> }));
vi.mock("../src/components/MobileChrome", () => ({
  MobileChrome: () => <div data-testid="mobile-chrome" />,
}));
vi.mock("../src/components/ShellNotices", () => ({
  ShellNotices: () => <div data-testid="shell-notices" />,
}));
vi.mock("../src/components/AccountBanners", () => ({
  AccountBanners: () => <div data-testid="account-banners" />,
}));
vi.mock("../src/components/ShellDialogSet", () => ({ ShellDialogSet: () => null }));
vi.mock("../src/components/DeletionWindow", () => ({
  default: () => <div data-testid="deletion-window" />,
}));

import { Layout } from "../src/App";

function renderApp() {
  render(() => (
    <MemoryRouter root={Layout}>
      <Route path="/" component={() => <p data-testid="page">Connections</p>} />
    </MemoryRouter>
  ));
}

const SHELL_PARTS = ["sidebar", "mobile-chrome", "shell-notices", "account-banners", "page"];

afterEach(() => cleanup());

describe("the shell for a session pending deletion", () => {
  it("draws the window screen and mounts none of the shell", async () => {
    auth.pending = true;
    renderApp();
    expect(await screen.findByTestId("deletion-window")).toBeTruthy();
    // Every lazy chunk the shell would load has had its turn.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const mounted = SHELL_PARTS.filter((part) => screen.queryByTestId(part) !== null);
    expect(mounted).toEqual([]);
  });

  it("draws the shell for an ordinary session", async () => {
    auth.pending = false;
    renderApp();
    await waitFor(() => {
      expect(screen.getByTestId("shell-notices")).toBeTruthy();
      expect(screen.getByTestId("account-banners")).toBeTruthy();
      expect(screen.getByTestId("page")).toBeTruthy();
      expect(
        screen.queryByTestId("sidebar") ?? screen.queryByTestId("mobile-chrome"),
      ).not.toBeNull();
    });
    expect(screen.queryByTestId("deletion-window")).toBeNull();
  });
});
