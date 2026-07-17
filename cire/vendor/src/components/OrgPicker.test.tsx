import { AuthProvider } from "@osn/client/solid";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import { type JSX } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as store from "../lib/vendor-store";
import OrgPicker from "./OrgPicker";

const authFetch = vi.fn();

vi.mock("@osn/client/solid", () => ({
  AuthProvider: (props: { children: JSX.Element }) => props.children,
  useAuth: () => ({ authFetch }),
}));

const org = (id: string, name: string) => ({
  id,
  handle: name.toLowerCase(),
  name,
  description: null,
  avatarUrl: null,
  ownerId: "p",
  createdAt: "",
  updatedAt: "",
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderPicker = (onPick = vi.fn()) =>
  render(() => (
    <AuthProvider config={{ issuerUrl: "http://localhost:4000" }}>
      <OrgPicker onPick={onPick} />
    </AuthProvider>
  ));

describe("OrgPicker", () => {
  it("lists the caller's organisations and picks one on click", async () => {
    vi.spyOn(store, "listMyOrgs").mockResolvedValue([org("o1", "Acme"), org("o2", "Bloom")]);
    const onPick = vi.fn();
    renderPicker(onPick);
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Bloom"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "o2" }));
  });

  it("shows a friendly error message when listMyOrgs rejects", async () => {
    vi.spyOn(store, "listMyOrgs").mockRejectedValue(new Error("Network error"));
    renderPicker();
    // Raw server/network errors are mapped to a generic friendly message.
    await waitFor(() =>
      expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument(),
    );
  });

  it("shows a specific friendly message for known error codes", async () => {
    vi.spyOn(store, "listMyOrgs").mockRejectedValue(new Error("not_org_member"));
    renderPicker();
    await waitFor(() =>
      expect(screen.getByText("You don't have access to that organisation.")).toBeInTheDocument(),
    );
  });

  it("shows the OSN empty-state (no create form) when the caller has no organisations", async () => {
    vi.spyOn(store, "listMyOrgs").mockResolvedValue([]);
    renderPicker();
    await waitFor(() =>
      expect(
        screen.getByText(/no organisations are associated with your account/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/create one in your OSN account/i)).toBeInTheDocument();
    // The portal must NOT offer org creation itself — that lives in OSN.
    expect(screen.queryByLabelText(/handle/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create organisation/i })).not.toBeInTheDocument();
  });
});
