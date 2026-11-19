// @vitest-environment happy-dom
import { AuthContext } from "@osn/client/solid";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The deletion screen on `/authorize` when its code fails to load (offline,
 * or a chunk a deploy renamed): the page's card says so and still offers the
 * way back to the app, so the app hears the refusal a Cancel sends rather
 * than nothing.
 */

const mocks = vi.hoisted(() => ({
  getContext: vi.fn(),
  submitDecision: vi.fn(),
  decline: vi.fn(),
}));

vi.mock("../../src/lib/authorize", () => ({ authorizeClient: mocks }));
vi.mock("../../src/components/AuthorizeDeletionWindow", () => {
  throw new Error("the screen's chunk did not load");
});

import { AuthorizePage } from "../../src/pages/AuthorizePage";

const REQUEST_ID = "oar_0123456789ab";

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  assign = vi.fn();
  vi.stubGlobal("location", { assign, href: "http://localhost/authorize" });
  mocks.getContext.mockResolvedValue({
    client: {
      clientId: "cli_abc",
      name: "Cire",
      logoUrl: null,
      firstParty: false,
      redirectDomain: "host.cire.example",
    },
    scopes: ["openid"],
    signedIn: true,
    pendingDeletion: true,
    profiles: [],
    linkedProfileId: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderPage() {
  const history = createMemoryHistory();
  history.set({ value: `/authorize?request=${REQUEST_ID}` });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the page reads no auth context
  const value = {} as any;
  return render(() => (
    <AuthContext.Provider value={value}>
      <MemoryRouter history={history}>
        <Route path="/authorize" component={AuthorizePage} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
}

describe("<AuthorizePage /> when the deletion screen's code fails to load", () => {
  it("says so and still goes back to the app", async () => {
    mocks.decline.mockResolvedValue({ redirectTo: "https://host.cire.example/back" });

    renderPage();

    const back = await screen.findByRole("button", { name: "Back to Cire" });
    expect(screen.getByText(/could not finish loading/)).toBeDefined();
    fireEvent.click(back);

    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://host.cire.example/back"));
    expect(mocks.decline).toHaveBeenCalledWith(REQUEST_ID);
  });
});
