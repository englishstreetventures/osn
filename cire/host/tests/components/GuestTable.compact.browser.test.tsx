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
 * bar's half of that refusal is in `GuestTable.test.tsx`. A viewer's menu
 * offers no plus-one choice either, and writes nothing.
 *
 * One menu serves every household: each "⋯" is a plain button that opens it
 * for its own household, so the list mounts one menu however long it is. The
 * keyboard opens it as Kobalte's own trigger would, on its first item, and
 * closing gives focus back to the "⋯" that opened it.
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
const puts: { url: string; body: unknown }[] = [];
function serve(guests: readonly object[]) {
  authFetch.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      writes.push(url);
      return json({ familyId: "fam_a", deactivatedAt: 1_700_000_999_000 });
    }
    if (init?.method === "PUT") {
      writes.push(url);
      puts.push({ url, body: JSON.parse(String(init.body)) as unknown });
      return json({ plusOnesRemoved: 0 });
    }
    if (url.endsWith("/guests")) return json(guests);
    if (url.endsWith("/events")) return json([]);
    return json({ inviteMessage: null });
  });
}

afterEach(() => {
  cleanup();
  authFetch.mockReset();
  writes.length = 0;
  puts.length = 0;
  __resetGuestsCache();
  __resetEventsCache();
});

async function mount(
  canManage: boolean,
  opts: { canEdit?: boolean; guests?: readonly object[] } = {},
) {
  serve(opts.guests ?? [ACTIVE, DEACTIVATED]);
  render(() => (
    <GuestTable
      weddingId="wed_a"
      canManage={canManage}
      canEdit={opts.canEdit ?? true}
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

  it("offers an owner Reactivate on a deactivated household, which restores its code", async () => {
    await mount(true);
    expect(await menuOf("Jones")).toEqual([...EDITOR_ITEMS, "Reactivate"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Reactivate" }));
    await vi.waitFor(() =>
      expect(writes).toEqual([
        "https://api.test/api/organiser/weddings/wed_a/families/fam_b/reactivate",
      ]),
    );
  });

  it("lets everyone in a household bring a +1, in one write", async () => {
    await mount(false);
    await menuOf("Sharma");
    await userEvent.click(screen.getByRole("menuitem", { name: "Everyone may bring a +1" }));
    await vi.waitFor(() =>
      expect(puts).toEqual([
        {
          url: "https://api.test/api/organiser/weddings/wed_a/families/fam_a/plus-one",
          body: { allowed: true },
        },
      ]),
    );
  });

  it("marks a +1 choice that would change nothing, and writes nothing for it", async () => {
    // Ada may already bring one: everyone in Sharma is allowed, and no one in
    // Jones is.
    await mount(false, {
      guests: [{ ...ACTIVE, plusOneAllowed: true }, DEACTIVATED],
    });
    await menuOf("Sharma");
    const everyone = screen.getByRole("menuitem", { name: "Everyone may bring a +1" });
    expect(everyone.hasAttribute("data-disabled")).toBe(true);
    expect(
      screen.getByRole("menuitem", { name: "No one may bring a +1" }).hasAttribute("data-disabled"),
    ).toBe(false);
    everyone.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(writes).toEqual([]);
    await closeMenu();
    await menuOf("Jones");
    expect(
      screen.getByRole("menuitem", { name: "No one may bring a +1" }).hasAttribute("data-disabled"),
    ).toBe(true);
  });

  it("offers a viewer no +1 choice and writes nothing", async () => {
    await mount(false, { canEdit: false });
    expect(await menuOf("Sharma")).toEqual(["Copy message"]);
    await closeMenu();
    expect(writes).toEqual([]);
  });
});

describe("the one household menu", () => {
  const actions = (household: string) =>
    screen.getByRole("button", { name: `Actions for ${household}` });

  it("opens from the keyboard on its first item, and gives focus back on Escape", async () => {
    await mount(true);
    actions("Sharma").focus();
    await userEvent.keyboard("{Enter}");
    const menu = await screen.findByRole("menu", { name: "Actions for Sharma" });
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        within(menu).getByRole("menuitem", { name: "Everyone may bring a +1" }),
      ),
    );
    expect(actions("Sharma").getAttribute("aria-expanded")).toBe("true");
    expect(actions("Jones").getAttribute("aria-expanded")).toBe("false");
    await closeMenu();
    expect(document.activeElement).toBe(actions("Sharma"));
    expect(actions("Sharma").getAttribute("aria-expanded")).toBe("false");
    // Space opens it on its first item too; ArrowUp on its last.
    await userEvent.keyboard(" ");
    const spaced = await screen.findByRole("menu");
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        within(spaced).getByRole("menuitem", { name: "Everyone may bring a +1" }),
      ),
    );
    await closeMenu();
    await userEvent.keyboard("{ArrowUp}");
    const again = await screen.findByRole("menu");
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        within(again).getByRole("menuitem", { name: "Deactivate" }),
      ),
    );
    await closeMenu();
  });

  it("closes when its household is no longer drawn", async () => {
    await mount(true);
    await menuOf("Jones");
    // A search lands while the menu is open (the list's own data can change
    // under it the same way): Jones leaves the list, and its menu with it.
    const search = screen.getByRole("searchbox", { name: "Search guests" }) as HTMLInputElement;
    search.value = "Sharma";
    search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await vi.waitFor(() => expect(screen.queryByText("Jones")).toBeNull());
    await vi.waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("opens beside the household pressed, for that household", async () => {
    await mount(true);
    await menuOf("Jones");
    const menu = screen.getByRole("menu", { name: "Actions for Jones" });
    const button = actions("Jones").getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    // Just below Jones's "⋯", not Sharma's above it, and across it (Kobalte
    // keeps it a few pixels in from the window's edge).
    expect(box.top).toBeGreaterThanOrEqual(button.bottom);
    expect(box.top - button.bottom).toBeLessThanOrEqual(12);
    expect(box.left < button.right && box.right > button.left).toBe(true);
    await closeMenu();
    expect(document.activeElement).toBe(actions("Jones"));
  });

  it("mounts no menu or tooltip of Kobalte's per household", async () => {
    await mount(true);
    // Kobalte's own triggers carry these whatever their state; the shared
    // menu's plain buttons carry neither.
    const bars = [...document.querySelectorAll("[data-household-bar]")];
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(
        bar.querySelector("[data-closed], [data-expanded], [aria-haspopup='true']"),
      ).toBeNull();
    }
  });
});
