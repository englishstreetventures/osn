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

  it("creates a new organisation and picks it", async () => {
    vi.spyOn(store, "listMyOrgs").mockResolvedValue([]);
    const created = org("o9", "NewCo");
    vi.spyOn(store, "createOrg").mockResolvedValue(created);
    const onPick = vi.fn();
    renderPicker(onPick);
    await waitFor(() => expect(screen.getByLabelText(/handle/i)).toBeInTheDocument());
    fireEvent.input(screen.getByLabelText(/handle/i), { target: { value: "newco" } });
    fireEvent.input(screen.getByLabelText(/name/i), { target: { value: "NewCo" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(created));
  });
});
