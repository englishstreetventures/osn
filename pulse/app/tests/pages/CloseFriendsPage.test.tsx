// @vitest-environment happy-dom
import { cleanup, fireEvent, render as _baseRender, waitFor } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { wrapRouter } from "../helpers/router";

vi.mock("solid-toast", async () => {
  const { solidToastMock } = await import("../helpers/toast");
  return solidToastMock();
});
import { mockToastError, mockToastSuccess } from "../helpers/toast";

// Mock the auth context.
let mockSession: () => { accessToken: string } | null = () => ({ accessToken: "tok" });
vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({
    session: () => mockSession(),
  }),
}));

const mockList = vi.fn();
const mockAdd = vi.fn();
const mockRemove = vi.fn();
vi.mock("../../src/lib/closeFriends", () => ({
  listCloseFriends: (...args: unknown[]) => mockList(...args),
  addCloseFriend: (...args: unknown[]) => mockAdd(...args),
  removeCloseFriend: (...args: unknown[]) => mockRemove(...args),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { CloseFriendsPage } from "../../src/pages/CloseFriendsPage";

const render: typeof _baseRender = ((factory: () => JSX.Element) =>
  _baseRender(wrapRouter(factory))) as unknown as typeof _baseRender;

describe("CloseFriendsPage", () => {
  beforeEach(() => {
    mockSession = () => ({ accessToken: "tok" });
    mockList.mockResolvedValue([]);
    mockAdd.mockResolvedValue({ ok: true });
    mockRemove.mockResolvedValue({ ok: true });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ connections: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    cleanup();
    mockList.mockReset();
    mockAdd.mockReset();
    mockRemove.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
    fetchMock.mockReset();
  });

  it("renders sign-in prompt when not authenticated", () => {
    mockSession = () => null;
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

  it("clicking Add on a connection calls addCloseFriend with the profile ID", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          connections: [
            {
              id: "usr_carol",
              handle: "carol",
              displayName: "Carol",
              connectedAt: "2030-01-01",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const { findByText, getByText } = render(() => <CloseFriendsPage />);
    await findByText("Carol");
    fireEvent.click(getByText("Add"));
    await waitFor(() => {
      expect(mockAdd).toHaveBeenCalledWith("usr_carol", "tok");
      expect(mockToastSuccess).toHaveBeenCalled();
    });
  });

  it("toasts not_a_connection error when addCloseFriend rejects", async () => {
    mockAdd.mockResolvedValueOnce({ ok: false, error: "not_a_connection" });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          connections: [
            {
              id: "usr_carol",
              handle: "carol",
              displayName: "Carol",
              connectedAt: "2030-01-01",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
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
      expect(mockRemove).toHaveBeenCalledWith("usr_bob", "tok");
      expect(mockToastSuccess).toHaveBeenCalled();
    });
  });
});
