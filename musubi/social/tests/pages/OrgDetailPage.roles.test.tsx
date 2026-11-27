// @vitest-environment happy-dom
import { AuthContext } from "@osn/client/solid";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An organisation's actions follow the reader's own standing, as the routes
 * do: Edit for an admin, Delete for the owner, Remove on a member's row for an
 * admin and on an admin's row for the owner, never on the reader's own row,
 * and nothing while the standing is unknown. The server refuses the rest; this
 * holds the page to offering nothing it would refuse.
 */

const mocks = vi.hoisted(() => ({
  getOrg: vi.fn(),
  listMembers: vi.fn(),
  removeMember: vi.fn(),
}));

vi.mock("../../src/lib/api", () => ({
  graphClient: {},
  recommendationClient: {},
  orgClient: {
    getOrg: mocks.getOrg,
    listMembers: mocks.listMembers,
    removeMember: mocks.removeMember,
    declineOwnershipStatus: () => Promise.reject(new Error("unused")),
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

const ROSTER = {
  members: [
    { handle: "alice", displayName: "Alice", role: "admin", joinedAt: "2026-01-01T00:00:00Z" },
    { handle: "bob", displayName: "Bob", role: "admin", joinedAt: "2026-01-02T00:00:00Z" },
    { handle: "carol", displayName: "Carol", role: "member", joinedAt: "2026-01-03T00:00:00Z" },
  ],
};

/** An access token carrying `claims`, signed by nobody: the page only reads it. */
function tokenWith(claims: object): string {
  const part = (value: object) => btoa(JSON.stringify(value));
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

/** An access token whose claims name `handle`, as the issuer's do. */
function tokenFor(handle: string): string {
  return tokenWith({ sub: `usr_${handle}`, handle });
}

function renderAs(handle: string, accessToken = tokenFor(handle)) {
  const resource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: value,
      refetch: () => {},
      mutate: () => {},
    });
  // A fresh session object per render: the page cache clears on a new one.
  const auth = {
    session: resource({
      accessToken,
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: [],
    }),
    profiles: resource([]),
    activeProfileId: () => `usr_${handle}`,
  };
  const history = createMemoryHistory();
  history.set({ value: "/organisations/acme" });
  render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
    <AuthContext.Provider value={auth as any}>
      <MemoryRouter history={history}>
        <Route path="/organisations/:handle" component={OrgDetailPage} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
}

/** The roster has landed: every member's handle is on screen. */
async function rosterShown() {
  await screen.findByRole("heading", { level: 1, name: "Acme" });
  await screen.findByText("@carol");
}

const removable = () =>
  screen
    .queryAllByRole("button", { name: /^Remov(e|ing) @/ })
    .map((button) => button.getAttribute("aria-label"));

beforeEach(() => {
  mocks.listMembers.mockReset().mockResolvedValue(ROSTER);
  mocks.removeMember.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<OrgDetailPage /> actions by standing", () => {
  it("offers nothing to a reader who is not in it", async () => {
    mocks.getOrg.mockResolvedValue({ organisation: ORG, caller: null });
    renderAs("mallory");
    await rosterShown();
    expect(removable()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("offers nothing to a plain member", async () => {
    mocks.getOrg.mockResolvedValue({ organisation: ORG, caller: { role: "member", owner: false } });
    renderAs("carol");
    await rosterShown();
    expect(removable()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("lets an admin edit and remove members, but not admins or delete", async () => {
    mocks.getOrg.mockResolvedValue({ organisation: ORG, caller: { role: "admin", owner: false } });
    renderAs("bob");
    await rosterShown();
    expect(removable()).toEqual(["Remove @carol"]);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("lets the owner remove an admin too, never their own row, and delete", async () => {
    mocks.getOrg.mockResolvedValue({ organisation: ORG, caller: { role: "admin", owner: true } });
    renderAs("alice");
    await rosterShown();
    expect(removable()).toEqual(["Remove @bob", "Remove @carol"]);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  // The owner's token names no handle, so the page cannot tell which row is
  // the reader's own: it offers no Remove at all rather than one on that row.
  it("offers the owner no Remove when the token names no handle, and still Edit and Delete", async () => {
    mocks.getOrg.mockResolvedValue({ organisation: ORG, caller: { role: "admin", owner: true } });
    renderAs("alice", tokenWith({ sub: "usr_alice" }));
    await rosterShown();
    expect(removable()).toEqual([]);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  // The held row itself is the musubi-org-detail flow's "remove busy" checks;
  // a flow never has two Remove buttons at once.
  it("keeps every other row's Remove available while one request runs", async () => {
    mocks.getOrg.mockResolvedValue({ organisation: ORG, caller: { role: "admin", owner: true } });
    mocks.removeMember.mockReturnValue(new Promise(() => {}));
    renderAs("alice");
    await rosterShown();
    fireEvent.click(screen.getByRole("button", { name: "Remove @bob" }));
    await screen.findByRole("button", { name: "Removing @bob" });
    await waitFor(() => expect(mocks.removeMember).toHaveBeenCalledWith("acme", "bob"));
    const other = screen.getByRole("button", { name: "Remove @carol" });
    expect(other.getAttribute("aria-disabled")).toBeNull();
  });
});
