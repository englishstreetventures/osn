import { cleanup, fireEvent, render as _baseRender, waitFor } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import type { JSX } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { wrapRouter } from "../helpers/router";

vi.mock("solid-toast", async () => {
  const { solidToastMock } = await import("../helpers/toast");
  return solidToastMock();
});
import { mockToastError, mockToastSuccess } from "../helpers/toast";

// Mock the auth context — settingsPage reads `session()` for the access token.
let mockSession: () => { accessToken: string } | null = () => ({ accessToken: "tok" });
vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ session: () => mockSession() }),
}));

// Mock the rsvps lib so we can assert updateMySettings is called and stub
// success / failure paths without touching the network.
const mockUpdate = vi.fn();
vi.mock("../../src/lib/rsvps", () => ({
  updateMySettings: (...args: unknown[]) => mockUpdate(...args),
}));

import { SettingsPage } from "../../src/pages/SettingsPage";

// SettingsPage uses `<A>` from @solidjs/router so it needs a Router context.
const render: typeof _baseRender = ((factory: () => JSX.Element) =>
  _baseRender(wrapRouter(factory))) as unknown as typeof _baseRender;

describe("SettingsPage", () => {
  beforeEach(() => {
    mockSession = () => ({ accessToken: "tok" });
    mockUpdate.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
    mockUpdate.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
  });

  it("renders both attendance visibility options", () => {
    const { getByText } = render(() => <SettingsPage />);
    expect(getByText("My connections")).toBeTruthy();
    expect(getByText("No one")).toBeTruthy();
  });

  it("does NOT include the 'everyone' option (per the spec)", () => {
    const { queryByText } = render(() => <SettingsPage />);
    expect(queryByText("Everyone")).toBeNull();
  });

  it("connections is selected by default", () => {
    const { container } = render(() => <SettingsPage />);
    const connections = container.querySelector(
      'input[name="attendanceVisibility"][value="connections"]',
    ) as HTMLInputElement;
    expect(connections.checked).toBe(true);
  });

  it("clicking Save calls updateMySettings with the selected visibility", async () => {
    const { container, getByText } = render(() => <SettingsPage />);
    const noOne = container.querySelector(
      'input[name="attendanceVisibility"][value="no_one"]',
    ) as HTMLInputElement;
    fireEvent.click(noOne);
    fireEvent.click(getByText("Save"));
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith({ attendanceVisibility: "no_one" }, "tok");
      expect(mockToastSuccess).toHaveBeenCalledWith("Settings saved");
    });
  });

  it("toasts an error when updateMySettings returns ok=false", async () => {
    mockUpdate.mockResolvedValueOnce({ ok: false, error: "boom" });
    const { getByText } = render(() => <SettingsPage />);
    fireEvent.click(getByText("Save"));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("boom");
    });
  });

  it("renders a sign-in prompt instead of the form when there is no session", () => {
    mockSession = () => null;
    const { getByText, queryByText } = render(() => <SettingsPage />);
    expect(getByText("Sign in to change your settings.")).toBeTruthy();
    expect(queryByText("Save")).toBeNull();
  });

  it("renders the warning copy about public guest lists overriding the setting", () => {
    const { getByText } = render(() => <SettingsPage />);
    expect(getByText((content) => content.includes("public guest list"))).toBeTruthy();
  });
});
