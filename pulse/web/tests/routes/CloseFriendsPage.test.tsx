// @vitest-environment happy-dom
import { cleanup, fireEvent, render as _baseRender, waitFor } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { wrapRouter } from "../helpers/router";

vi.mock("@shared/toast", async () => {
  const { toastMock } = await import("../helpers/toast");
  return toastMock();
});
import { authState, fakeSession } from "../helpers/auth";
import { mockToastError, mockToastSuccess } from "../helpers/toast";

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../helpers/auth");
  return rpAuthSolidMock();
});

const mockList = vi.fn();
const mockCandidates = vi.fn();
const mockAdd = vi.fn();
const mockRemove = vi.fn();
vi.mock("../../src/lib/closeFriends", () => ({
  listCloseFriends: (...args: unknown[]) => mockList(...args),
  listCloseFriendCandidates: (...args: unknown[]) => mockCandidates(...args),
  addCloseFriend: (...args: unknown[]) => mockAdd(...args),
  removeCloseFriend: (...args: unknown[]) => mockRemove(...args),
}));

import { CloseFriendsPage } from "../../src/routes/close-friends";

const render: typeof _baseRender = ((factory: () => JSX.Element) =>
  _baseRender(wrapRouter(factory))) as unknown as typeof _baseRender;

describe("CloseFriendsPage", () => {
  beforeEach(() => {
    authState.session = fakeSession();
    mockList.mockResolvedValue([]);
    mockCandidates.mockResolvedValue([]);
    mockAdd.mockResolvedValue({ ok: true });
    mockRemove.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
    mockList.mockReset();
    mockCandidates.mockReset();
    mockAdd.mockReset();
    mockRemove.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
  });

  it("renders sign-in prompt when not authenticated", () => {
    authState.session = null;
    const { getByText } = render(() => <CloseFriendsPage />);
    expect(getByText(/Sign in to manage close friends/)).toBeTruthy();
  });

  it("renders empty state when no close friends and no connections", async () => {
    const { getByText } = render(() => <CloseFriendsPage />);
    await waitFor(() => {
      expect(getByText(/No close friends yet/)).toBeTruthy();
    });
  });

  it("renders close-friend rows from the API", async () => {
    mockList.mockResolvedValueOnce([
      { profileId: "usr_bob", handle: "bob", displayName: "Bob", avatarUrl: null },
    ]);
    const { findByText } = render(() => <CloseFriendsPage />);
    expect(await findByText("Bob")).toBeTruthy();
    expect(await findByText("@bob")).toBeTruthy();
  });

  it("tells the viewer the graph was unreachable when candidates come back null", async () => {
    // `null` is not an empty list — the copy has to say so.
    mockCandidates.mockResolvedValueOnce(null);
    const { findByText } = render(() => <CloseFriendsPage />);
    expect(await findByText(/Couldn't load your connections/)).toBeTruthy();
  });

  it("clicking Add on a connection calls addCloseFriend with the profile ID", async () => {
    mockCandidates.mockResolvedValueOnce([
      { profileId: "usr_carol", handle: "carol", displayName: "Carol", avatarUrl: null },
    ]);
    const { findByText, getByText } = render(() => <CloseFriendsPage />);
    await findByText("Carol");
    fireEvent.click(getByText("Add"));
    await waitFor(() => {
      // Profile id only — the session cookie authorises the write.
      expect(mockAdd).toHaveBeenCalledWith("usr_carol");
      expect(mockToastSuccess).toHaveBeenCalled();
    });
  });

  it("toasts not_a_connection error when addCloseFriend rejects", async () => {
    mockAdd.mockResolvedValueOnce({ ok: false, error: "not_a_connection" });
    mockCandidates.mockResolvedValueOnce([
      { profileId: "usr_carol", handle: "carol", displayName: "Carol", avatarUrl: null },
    ]);
    const { findByText, getByText } = render(() => <CloseFriendsPage />);
    await findByText("Carol");
    fireEvent.click(getByText("Add"));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/connections/));
    });
  });

  it("clicking Remove on a close friend calls removeCloseFriend", async () => {
    mockList.mockResolvedValueOnce([
      { profileId: "usr_bob", handle: "bob", displayName: "Bob", avatarUrl: null },
    ]);
    const { findByText, getByText } = render(() => <CloseFriendsPage />);
    await findByText("Bob");
    fireEvent.click(getByText("Remove"));
    await waitFor(() => {
      expect(mockRemove).toHaveBeenCalledWith("usr_bob");
      expect(mockToastSuccess).toHaveBeenCalled();
    });
  });
});
