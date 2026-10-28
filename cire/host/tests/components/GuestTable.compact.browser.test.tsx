import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The household list's narrow layout: each household's actions in one "⋯"
 * menu, and Deactivate asking in a dialog, because a menu closes on choosing.
 *
 * In the browser tier because the menu is Kobalte's: it hides the rest of the
 * page while open, and happy-dom never finishes the close that gives it back.
 * The refusal is the point: cutting a household's code off, or restoring it, is
 * the owner's alone (the API gates both with `weddingOwner()`), so a co-host's
 * menu offers neither, for an active household or a deactivated one. The wide
 * bar's half of that refusal is in `GuestTable.test.tsx`.
 *
 * The factories are written literally: the shared-factory idiom in
 * `test-support/mocks.ts` does not resolve in the browser project.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("@shared/toast", () => ({ toast: { success: () => {}, error: () => {} } }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));
vi.mock("../../src/lib/osn", () => ({
  CIRE_API_URL: "https://api.test",
  CIRE_WEB_URL: "https://guests.test",
}));

import GuestTable from "../../src/components/GuestTable";
import { __resetEventsCache } from "../../src/lib/events-store";
import { __resetGuestsCache } from "../../src/lib/guests-store";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const ACTIVE = {
  guestId: "g_ada",
  familyId: "fam_a",
  publicId: "SHARMA-WIDGET-AB3K9",
  familyName: "Sharma",
  firstName: "Ada",
  lastName: "Sharma",
  nickname: null,
  events: [],
  plusOneAllowed: false,
  plusOneOf: null,
  codeSharedAt: null,
  firstOpenedAt: null,
  deactivatedAt: null,
};
const DEACTIVATED = {
  ...ACTIVE,
  guestId: "g_bo",
  familyId: "fam_b",
  publicId: "JONES-KITE-77Q2",
  familyName: "Jones",
  firstName: "Bo",
  lastName: "Jones",
  deactivatedAt: 1_700_000_900_000,
};

/** Answer the list's three reads, and record every write. */
const writes: string[] = [];
function serve() {
  authFetch.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      writes.push(url);
      return json({ familyId: "fam_a", deactivatedAt: 1_700_000_999_000 });
    }
    if (url.endsWith("/guests")) return json([ACTIVE, DEACTIVATED]);
    if (url.endsWith("/events")) return json([]);
    return json({ inviteMessage: null });
  });
}

afterEach(() => {
  cleanup();
  authFetch.mockReset();
  writes.length = 0;
  __resetGuestsCache();
  __resetEventsCache();
});

async function mount(canManage: boolean) {
  serve();
  render(() => (
    <GuestTable
      weddingId="wed_a"
      canManage={canManage}
      canEdit
      compact
      weddingName="Nadia & Sam"
      weddingSlug="nadia-sam"
    />
  ));
  await vi.waitFor(() => expect(screen.getByText("Sharma")).toBeTruthy());
}

/** Open a household's menu and read its items. */
async function menuOf(household: string): Promise<string[]> {
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${household}` }));
  const menu = await screen.findByRole("menu");
  return within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent?.trim() ?? "");
}

async function closeMenu() {
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

/** What an editor may do to any household: its plus-ones, and the message. */
const EDITOR_ITEMS = ["Everyone may bring a +1", "No one may bring a +1", "Copy message"];

describe("a household's narrow menu", () => {
  it("offers a co-host no Deactivate and no Reactivate", async () => {
    await mount(false);
    expect(await menuOf("Sharma")).toEqual(EDITOR_ITEMS);
    await closeMenu();
    expect(await menuOf("Jones")).toEqual(EDITOR_ITEMS);
    await closeMenu();
  });

  it("offers an owner Deactivate, which asks in a dialog before it writes", async () => {
    await mount(true);
    expect(await menuOf("Sharma")).toEqual([...EDITOR_ITEMS, "Deactivate"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Deactivate" }));
    const dialog = await screen.findByRole("dialog", { name: "Disable Sharma’s code?" });
    // Nothing is written until the owner confirms; the safe answer has focus.
    expect(writes).toEqual([]);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Deactivate" }));
    await vi.waitFor(() =>
      expect(writes).toEqual([
        "https://api.test/api/organiser/weddings/wed_a/families/fam_a/deactivate",
      ]),
    );
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The narrow bar says it in a word; the rest is there for a screen reader.
    expect(screen.getAllByText(/^Deactivated$/)).toHaveLength(2);
    expect(screen.getAllByText(/— code disabled/)).toHaveLength(2);
  });

  it("offers an owner Reactivate on a deactivated household", async () => {
    await mount(true);
    expect(await menuOf("Jones")).toEqual([...EDITOR_ITEMS, "Reactivate"]);
    await closeMenu();
  });
});
