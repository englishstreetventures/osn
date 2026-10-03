// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.fn<(url: string) => Promise<Response>>();
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("@shared/toast", () => ({ toast }));
const downloadBlob = vi.fn();
vi.mock("../../src/lib/download", () => ({
  downloadBlob: (name: string, blob: Blob) => downloadBlob(name, blob),
}));
const redirectToLogin = vi.fn();
vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return { ...actual, redirectToLogin: () => redirectToLogin() };
});

import LockedExport from "../../src/components/LockedExport";
import { LOCKED_EXPORTS } from "../../src/lib/locked-exports";
import { __resetModuleRowsStore } from "../../src/lib/module-rows-store";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const COUNTS = json({ budgetLines: 2, tasks: 0, gifts: 0 });

/** Answer `/module-rows` with `rows` and a CSV path with `file`. */
function answer(
  rows: () => Response | Promise<Response>,
  file: () => Response | Promise<Response>,
) {
  authFetch.mockImplementation(async (url: string) =>
    url.endsWith("/module-rows") ? rows() : file(),
  );
}

const show = () =>
  render(() => (
    <LockedExport weddingId="wed_1" weddingSlug="our-day" spec={LOCKED_EXPORTS.budget} />
  ));

beforeEach(() => {
  authFetch.mockReset();
  downloadBlob.mockReset();
  redirectToLogin.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  __resetModuleRowsStore();
});
afterEach(() => cleanup());

/**
 * The download a locked card offers its owner, on its own: the branches the
 * card's tests in `ModuleSidebar.test.tsx` do not reach through the hover card.
 */
describe("LockedExport", () => {
  describe("a session that has ended", () => {
    it("sends the owner to sign in when the count is refused, and offers nothing", async () => {
      answer(
        () => json({ error: "unauthorised" }, 401),
        () => new Response("x"),
      );
      show();
      await waitFor(() => expect(redirectToLogin).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("button", { name: "Download as CSV" })).toBeNull();
    });

    it("sends the owner to sign in when the file is refused, and says nothing else", async () => {
      answer(
        () => COUNTS.clone(),
        () => json({ error: "unauthorised" }, 401),
      );
      show();
      fireEvent.click(await screen.findByRole("button", { name: "Download as CSV" }));
      await waitFor(() => expect(redirectToLogin).toHaveBeenCalledTimes(1));
      expect(toast.error).not.toHaveBeenCalled();
      expect(downloadBlob).not.toHaveBeenCalled();
    });

    // `authFetch` rejects with `AuthExpiredError` rather than answering 401
    // when the cookie is gone; the same path has to catch that form.
    it("treats an expired-session rejection the same way", async () => {
      answer(
        () => COUNTS.clone(),
        () => Promise.reject({ _tag: "AuthExpiredError" }),
      );
      show();
      fireEvent.click(await screen.findByRole("button", { name: "Download as CSV" }));
      await waitFor(() => expect(redirectToLogin).toHaveBeenCalledTimes(1));
      expect(toast.error).not.toHaveBeenCalled();
      expect(downloadBlob).not.toHaveBeenCalled();
    });
  });

  // Each request spends the owner's export allowance, and a double tap would
  // save a second copy.
  it("asks for the file once however often it is tapped while it downloads", async () => {
    let settle: (res: Response) => void = () => {};
    answer(
      () => COUNTS.clone(),
      () => new Promise<Response>((resolve) => (settle = resolve)),
    );
    show();
    const button = await screen.findByRole("button", { name: "Download as CSV" });
    fireEvent.click(button);
    fireEvent.click(button);

    const busy = await screen.findByRole("button", { name: "Downloading…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    const fileRequests = () =>
      authFetch.mock.calls.filter(([url]) => String(url).endsWith("/budget.csv"));
    expect(fileRequests()).toHaveLength(1);

    settle(new Response("Kind\r\n"));
    expect(await screen.findByRole("button", { name: "Download as CSV" })).toBeTruthy();
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(fileRequests()).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledWith("Budget downloaded");
  });
});
