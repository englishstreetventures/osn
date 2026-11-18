// @vitest-environment happy-dom
/**
 * `/confirm/:requestId` when the request has ended, through the real
 * `createAppStepUpClient` and a stubbed transport: osn-api answers 404 for a
 * request that is used, run out or another account's, at the read and at the
 * confirm alike, and the page must say "This request has ended" rather than
 * offer a retry that can never work. Read by whoever changes the client's 404
 * mapping (`osn/client/src/app-step-up.ts`) or the page's gone state.
 */
import { AuthContext } from "@osn/client/solid";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transport: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
  returnTo: vi.fn(),
}));

vi.mock("../../src/lib/app-step-up-client", async () => {
  const { createAppStepUpClient } = await import("@osn/client");
  return {
    appStepUpClient: createAppStepUpClient({
      issuerUrl: "https://id.test",
      authFetch: (url: string, init?: RequestInit) => mocks.transport(url, init),
    }),
  };
});
vi.mock("../../src/components/StepUpSheet", () => ({
  default: (props: { onToken: (token: { token: string }) => void }) => {
    queueMicrotask(() => props.onToken({ token: "tok" }));
    return null;
  },
}));
vi.mock("../../src/lib/return-to", () => ({ returnTo: mocks.returnTo }));

import { ConfirmRequestPage } from "../../src/pages/ConfirmRequestPage";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const gone = () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 });

function authValue() {
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
    session: resource({ accessToken: "h.e30.s", idToken: null, expiresAt: 0, scopes: [] }),
    profiles: resource([]),
    activeProfileId: () => "usr_alice",
    pendingDeletion: () => false,
  };
}

function renderPage() {
  const history = createMemoryHistory();
  history.set({ value: "/confirm/req_1" });
  render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
    <AuthContext.Provider value={authValue() as any}>
      <MemoryRouter history={history}>
        <Route path="/confirm/:requestId" component={ConfirmRequestPage} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
}

beforeEach(() => {
  mocks.transport.mockReset();
  mocks.returnTo.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ConfirmRequestPage, a request that has ended", () => {
  it("says so when the read answers 404", async () => {
    mocks.transport.mockResolvedValue(gone());
    renderPage();
    expect(await screen.findByRole("heading", { name: "This request has ended" })).toBeTruthy();
    expect(screen.queryByText(/didn't load/)).toBeNull();
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(mocks.transport.mock.calls[0]![0]).toBe("https://id.test/step-up/requests/req_1");
  });

  it("says so when the confirm answers 404, and goes nowhere", async () => {
    mocks.transport.mockImplementation(async (url) =>
      url.endsWith("/confirm")
        ? gone()
        : json({ purpose: "cire_app_delete", return_host: "host.cireweddings.com" }),
    );
    renderPage();
    expect(await screen.findByText("host.cireweddings.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm it's you" }));

    expect(await screen.findByRole("heading", { name: "This request has ended" })).toBeTruthy();
    expect(mocks.transport.mock.calls.map(([url]) => url)).toEqual([
      "https://id.test/step-up/requests/req_1",
      "https://id.test/step-up/requests/req_1/confirm",
    ]);
    expect(mocks.returnTo).not.toHaveBeenCalled();
  });
});
