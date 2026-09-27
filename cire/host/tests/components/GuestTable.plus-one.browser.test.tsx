import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * Focus through the plus-one removal, in a real `<dialog>`.
 *
 * happy-dom implements no part of `showModal`, so the unit tier cannot see
 * where focus goes when the confirmation opens or closes. Two things matter
 * here: the dialog opens on Cancel, not on the button that deletes someone;
 * and closing it hands focus back to the switch that asked — which only works
 * if that switch is still the same element once the write has updated the
 * table.
 *
 * The factories are written literally: the shared-factory idiom in
 * `test-support/mocks.ts` does not resolve in the browser project.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("@shared/toast", () => ({ toast: { success: () => {}, error: () => {} } }));
vi.mock("../../src/lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));
vi.mock("../../src/lib/osn", () => ({ CIRE_WEB_URL: "https://guests.test" }));

import GuestTable from "../../src/components/GuestTable";
import { __resetEventsCache } from "../../src/lib/events-store";
import { __resetGuestsCache } from "../../src/lib/guests-store";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const HOUSEHOLD = {
  familyId: "fam_a",
  publicId: "SHARMA-WIDGET-AB3K9",
  familyName: "Sharma",
  codeSharedAt: null,
  firstOpenedAt: null,
  deactivatedAt: null,
  nickname: null,
  events: [],
};
const ADA = { ...HOUSEHOLD, guestId: "g_ada", firstName: "Ada", lastName: "Sharma" };
const SAM = { ...HOUSEHOLD, guestId: "g_sam", firstName: "Sam", lastName: "Lee" };

let removed = false;

beforeEach(() => {
  removed = false;
  authFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      removed = true;
      return Promise.resolve(
        json({ guestId: "g_ada", plusOneAllowed: false, plusOneRemoved: true }),
      );
    }
    if (url.endsWith("/guests")) {
      const rows: object[] = [{ ...ADA, plusOneAllowed: !removed, plusOneOf: null }];
      if (!removed) rows.push({ ...SAM, plusOneAllowed: false, plusOneOf: "g_ada" });
      return Promise.resolve(json(rows));
    }
    if (url.endsWith("/events")) return Promise.resolve(json([]));
    return Promise.resolve(json({ inviteMessage: null }));
  });
});

afterEach(() => {
  cleanup();
  authFetch.mockReset();
  __resetGuestsCache();
  __resetEventsCache();
});

async function openRemoval(): Promise<HTMLInputElement> {
  render(() => (
    <GuestTable
      weddingId="wed_a"
      canManage={false}
      canEdit
      weddingName="Nadia & Sam"
      weddingSlug="nadia-sam"
    />
  ));
  const toggle = (await screen.findByRole("switch", {
    name: "Ada Sharma may bring a plus-one",
  })) as HTMLInputElement;
  // The track is what a pointer presses; it hands focus to the hidden input.
  await userEvent.click(toggle.nextElementSibling as HTMLElement);
  await screen.findByText("Remove Sam Lee?");
  return toggle;
}

describe("GuestTable — plus-one removal focus", () => {
  it("opens the confirmation on Cancel, not on the button that deletes", async () => {
    await openRemoval();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("hands focus back to the switch after Cancel", async () => {
    const toggle = await openRemoval();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("sends nothing and hands focus back when the dialog is closed with Escape", async () => {
    const toggle = await openRemoval();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    expect(document.querySelector("dialog")?.open).toBe(false);
    expect(authFetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("hands focus back to the same switch once the removal has been written", async () => {
    const toggle = await openRemoval();
    await userEvent.click(screen.getByRole("button", { name: "Remove Sam Lee" }));

    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(screen.queryByText(/Plus-one of Ada Sharma/)).toBeNull();
    expect(toggle.isConnected).toBe(true);
    // The dialog closes once its exit has played; focus comes back then.
    await waitFor(() => expect(document.activeElement).toBe(toggle));
  });
});
