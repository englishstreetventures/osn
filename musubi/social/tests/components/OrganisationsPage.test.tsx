// @vitest-environment happy-dom
import { AuthExpiredError } from "@osn/client";
import { AuthContext } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listMyOrgs: vi.fn(),
  createOrg: vi.fn(),
}));

vi.mock("../../src/lib/api", () => ({
  graphClient: {},
  recommendationClient: {},
  orgClient: { listMyOrgs: mocks.listMyOrgs, createOrg: mocks.createOrg },
}));

import { OrganisationsPage } from "../../src/pages/OrganisationsPage";

function authedProvider() {
  const asResource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: null,
      refetch: () => {},
      mutate: () => {},
    });
  return {
    session: asResource({
      accessToken: "tkn",
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: [],
    }),
    profiles: asResource([]),
    activeProfileId: () => "usr_1",
    logout: () => Promise.resolve(),
    adoptSession: () => Promise.resolve(),
    switchProfile: () => Promise.reject(new Error("unused")),
    createProfile: () => Promise.reject(new Error("unused")),
    deleteProfile: () => Promise.resolve(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext; full interface fidelity not required for this test
  } as any;
}

async function submitCreate() {
  render(() => (
    <AuthContext.Provider value={authedProvider()}>
      <MemoryRouter>
        <Route path="/" component={OrganisationsPage} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
  fireEvent.click(await screen.findByRole("button", { name: "Create" }));
  fireEvent.input(await screen.findByLabelText("Handle"), { target: { value: "acme" } });
  fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Acme" } });
  const submit = screen
    .getAllByRole("button", { name: "Create" })
    .find((b) => b.getAttribute("type") === "submit");
  fireEvent.click(submit!);
}

beforeEach(() => {
  mocks.listMyOrgs.mockResolvedValue({ organisations: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  vi.clearAllMocks();
});

describe("<OrganisationsPage /> create failure", () => {
  it("words an ended session as a sentence in the toast", async () => {
    mocks.createOrg.mockRejectedValue(new AuthExpiredError({}));
    const spy = vi.spyOn(toast, "error");
    await submitCreate();
    await waitFor(() => expect(spy).toHaveBeenCalledWith("Your session has ended. Sign in again."));
  });

  it("words an ordinary failure as a non-empty sentence in the toast", async () => {
    mocks.createOrg.mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(toast, "error");
    await submitCreate();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const shown = spy.mock.calls[0]![0];
    expect(typeof shown === "string" && shown.length > 0 && shown !== "boom").toBe(true);
  });
});
