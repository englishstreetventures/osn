// @vitest-environment happy-dom
import { OrgClientError } from "@osn/client";
import { AuthContext } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The decline block the "you now own" email links to (`?decline=1`): shown
 * only on that link, Decline passes the organisation on or deletes it and
 * goes back to the list, and a refusal says it can no longer be declined.
 */

const mocks = vi.hoisted(() => ({
  getOrg: vi.fn(),
  listMembers: vi.fn(),
  declineOwnership: vi.fn(),
}));

vi.mock("../../src/lib/api", () => ({
  graphClient: {},
  recommendationClient: {},
  orgClient: {
    getOrg: mocks.getOrg,
    listMembers: mocks.listMembers,
    declineOwnership: mocks.declineOwnership,
    listMyOrgs: () => Promise.resolve({ organisations: [] }),
  },
}));

import { OrgDetailPage } from "../../src/pages/OrgDetailPage";

const ORG = {
  handle: "acme",
  name: "Acme",
  description: null,
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

/** A fresh session object per render: the page cache clears on a new one. */
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
    session: resource({
      accessToken: "tkn",
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: [],
    }),
    profiles: resource([]),
    activeProfileId: () => "usr_1",
  };
}

function renderOrg(path: string) {
  const history = createMemoryHistory();
  history.set({ value: path });
  render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
    <AuthContext.Provider value={authValue() as any}>
      <MemoryRouter history={history}>
        <Route path="/organisations/:handle" component={OrgDetailPage} />
        <Route path="/organisations" component={() => <p>Organisations list</p>} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
  return history;
}

beforeEach(() => {
  mocks.getOrg.mockReset().mockResolvedValue({ organisation: ORG });
  mocks.listMembers.mockReset().mockResolvedValue({ members: [] });
  mocks.declineOwnership.mockReset();
  vi.spyOn(toast, "success");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<OrgDetailPage /> decline", () => {
  it("offers Decline only on the email's link", async () => {
    renderOrg("/organisations/acme");
    await screen.findByRole("heading", { name: "Acme" });
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  });

  it("declines, says where it went, and goes back to the list", async () => {
    mocks.declineOwnership.mockResolvedValue({ outcome: "passed" });
    const history = renderOrg("/organisations/acme?decline=1");
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));

    await waitFor(() => expect(history.get()).toBe("/organisations"));
    expect(mocks.declineOwnership).toHaveBeenCalledWith("acme");
    expect(toast.success).toHaveBeenCalledWith("Organisation passed on");
  });

  it.each([
    [403, "not_owner"],
    [409, "not_declinable"],
  ])("says it can no longer be declined when refused at %i", async (status, code) => {
    mocks.declineOwnership.mockRejectedValue(new OrgClientError("refused", status, code));
    const history = renderOrg("/organisations/acme?decline=1");
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));

    expect(
      await screen.findByText(/You can no longer decline this organisation here\./),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
    expect(history.get()).toBe("/organisations/acme?decline=1");
  });
});
