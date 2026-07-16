// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * SettingsPanel loads the wedding profile and PUTs the whole form back. The
 * OSN auth + api helpers + toasts are stubbed; this asserts the load/seed, the
 * PUT body (incl. cents conversion and the slug never being sent — read-only,
 * S-M1), and the co-host read-only gate. Location is deliberately NOT here —
 * an event's place is its free-text `address` (the sole location source).
 */

const authFetchMock = vi.fn();
const redirectSpy = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ authFetch: authFetchMock }),
}));

vi.mock("solid-toast", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: (err: unknown) => String(err).includes("AuthExpiredError"),
  redirectToLogin: () => redirectSpy(),
}));

import SettingsPanel from "./SettingsPanel";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PROFILE = {
  id: "wed_1",
  slug: "aisha-and-ben",
  displayName: "Aisha & Ben",
  weddingDate: "2027-03-20",
  guestCountEstimate: 120,
  currency: "AUD",
  budgetTotalMinor: 4_500_000,
};

const EMPTY_PROFILE = {
  ...PROFILE,
  weddingDate: null,
  guestCountEstimate: null,
  budgetTotalMinor: null,
};

describe("SettingsPanel", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it("loads and seeds the form from the profile", async () => {
    authFetchMock.mockResolvedValueOnce(json({ wedding: PROFILE }));
    render(() => <SettingsPanel weddingId="wed_1" canManage />);

    await waitFor(() => {
      expect(screen.getByDisplayValue("Aisha & Ben")).toBeTruthy();
    });
    // Slug renders read-only text (renames are deliberately unsupported — S-M1).
    expect(screen.getByText("aisha-and-ben")).toBeTruthy();
    expect(screen.queryByDisplayValue("aisha-and-ben")).toBeNull();
    expect(screen.getByText(/can.t be changed/)).toBeTruthy();
    // The date is edited through the custom DatePicker (a Popover trigger showing
    // the formatted date), not a native <input type="date">.
    expect(screen.getByText(/20 March 2027/)).toBeTruthy();
    expect(screen.getByDisplayValue("120")).toBeTruthy();
    // Budget renders in whole-currency units (minor / 100).
    expect(screen.getByDisplayValue("45000")).toBeTruthy();
  });

  it("PUTs the parsed form and reports the rename up", async () => {
    authFetchMock.mockResolvedValueOnce(json({ wedding: PROFILE }));
    const onWeddingUpdated = vi.fn();
    render(() => <SettingsPanel weddingId="wed_1" canManage onWeddingUpdated={onWeddingUpdated} />);
    await waitFor(() => expect(screen.getByDisplayValue("Aisha & Ben")).toBeTruthy());

    fireEvent.input(screen.getByDisplayValue("Aisha & Ben"), {
      target: { value: "Aisha & Benjamin" },
    });
    authFetchMock.mockResolvedValueOnce(
      json({ wedding: { ...PROFILE, displayName: "Aisha & Benjamin" } }),
    );
    fireEvent.click(screen.getByText("Save settings"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Settings saved"));
    const [url, init] = authFetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.test/api/organiser/weddings/wed_1/settings");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.displayName).toBe("Aisha & Benjamin");
    expect(body.budgetTotalMinor).toBe(4_500_000);
    expect(body.currency).toBe("AUD");
    // The slug is never sent — read-only in Settings (S-M1).
    expect("slug" in body).toBe(false);
    expect(onWeddingUpdated).toHaveBeenCalledWith({
      displayName: "Aisha & Benjamin",
      slug: "aisha-and-ben",
    });
  });

  it("saves a date picked through the DatePicker", async () => {
    authFetchMock.mockResolvedValueOnce(json({ wedding: PROFILE }));
    render(() => <SettingsPanel weddingId="wed_1" canManage />);
    await waitFor(() => expect(screen.getByDisplayValue("Aisha & Ben")).toBeTruthy());

    // Open the DatePicker (its trigger shows the current formatted date) and pick
    // a new day in the shown month (March 2027, seeded from the loaded profile).
    fireEvent.click(screen.getByText(/20 March 2027/));
    await waitFor(() => expect(screen.getByRole("grid")).toBeTruthy());
    fireEvent.click(screen.getByRole("gridcell", { name: /28 March 2027/ }));

    authFetchMock.mockResolvedValueOnce(
      json({ wedding: { ...PROFILE, weddingDate: "2027-03-28" } }),
    );
    fireEvent.click(screen.getByText("Save settings"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Settings saved"));
    const [, init] = authFetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.weddingDate).toBe("2027-03-28");
  });

  it("sends nulls for cleared optional fields", async () => {
    authFetchMock.mockResolvedValueOnce(json({ wedding: EMPTY_PROFILE }));
    render(() => <SettingsPanel weddingId="wed_1" canManage />);
    await waitFor(() => expect(screen.getByDisplayValue("Aisha & Ben")).toBeTruthy());

    authFetchMock.mockResolvedValueOnce(json({ wedding: EMPTY_PROFILE }));
    fireEvent.click(screen.getByText("Save settings"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const [, init] = authFetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.weddingDate).toBeNull();
    expect(body.guestCountEstimate).toBeNull();
    expect(body.budgetTotalMinor).toBeNull();
  });

  it("rejects a bad currency client-side without a request", async () => {
    authFetchMock.mockResolvedValueOnce(json({ wedding: EMPTY_PROFILE }));
    render(() => <SettingsPanel weddingId="wed_1" canManage />);
    await waitFor(() => expect(screen.getByDisplayValue("Aisha & Ben")).toBeTruthy());

    fireEvent.input(screen.getByDisplayValue("AUD"), { target: { value: "$$" } });
    fireEvent.click(screen.getByText("Save settings"));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0]?.[0])).toContain("3-letter code");
    // Only the initial GET happened — the invalid form never left the page.
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders read-only for a co-host", async () => {
    authFetchMock.mockResolvedValueOnce(json({ wedding: PROFILE }));
    render(() => <SettingsPanel weddingId="wed_1" canManage={false} />);
    await waitFor(() => expect(screen.getByDisplayValue("Aisha & Ben")).toBeTruthy());

    expect(screen.queryByText("Save settings")).toBeNull();
    expect(screen.getByText(/Only the wedding.s owner can change these settings/)).toBeTruthy();
    expect((screen.getByDisplayValue("Aisha & Ben") as HTMLInputElement).disabled).toBe(true);
  });
});
