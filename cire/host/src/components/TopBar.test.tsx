// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WeddingSummary } from "./CreateWeddingForm";

/**
 * TopBar is the portal's only chrome — one sticky row replacing the four bands
 * the old portal stacked before its first piece of content. What these tests
 * pin is the part that is easy to break silently: that the row still answers
 * whose product / which wedding / what can I do from anywhere, that every one of
 * its controls reports to the right callback, and that the no-wedding case (the
 * wedding list, the security view) degrades to a section label rather than to an
 * empty switcher.
 *
 * PreviewInviteButton is stubbed: it POSTs an owner-gated endpoint and opens a
 * tab, none of which is TopBar's contract. ProfileMenu is real — it takes its
 * session as a prop and reaches for nothing.
 */

vi.mock("./PreviewInviteButton", () => ({
  default: (p: { weddingId: string }) => <div data-testid="preview">{p.weddingId}</div>,
}));

import TopBar from "./TopBar";

const SESSION = {
  osnProfileId: "usr_1",
  email: "alex@example.com",
  handle: "alex",
  displayName: "Alex Host",
  avatarUrl: null,
  expiresAt: "2099-01-01T00:00:00Z",
};

const RUTH: WeddingSummary = {
  id: "wed_1",
  slug: "ruth-and-vik",
  displayName: "Ruth & Vik",
  role: "owner",
  entitlements: [],
  guestCap: 100,
};

const MAYA: WeddingSummary = {
  ...RUTH,
  id: "wed_2",
  slug: "maya-and-sol",
  displayName: "Maya & Sol",
};

function mount(opts: { wedding?: WeddingSummary | null; sectionLabel?: string } = {}) {
  const spies = {
    onWedding: vi.fn(),
    onAll: vi.fn(),
    onSecurity: vi.fn(),
    onSignOut: vi.fn(),
    onOpenPalette: vi.fn(),
  };
  const utils = render(() => (
    <TopBar
      session={SESSION}
      wedding={opts.wedding === undefined ? RUTH : opts.wedding}
      weddings={[RUTH, MAYA]}
      sectionLabel={opts.sectionLabel ?? "All weddings"}
      {...spies}
    />
  ));
  return { ...utils, ...spies };
}

describe("TopBar", () => {
  afterEach(cleanup);

  it("carries the wordmark as the way home, and says so", () => {
    // The glyph and the word are both aria-hidden, so the button would otherwise
    // announce as unlabelled — a logo that navigates and doesn't say so is a
    // trap for anyone not looking at it.
    const { onAll } = mount();
    const home = screen.getByRole("button", { name: "Cire — all weddings" });
    expect(home.textContent).toContain("Cire");
    fireEvent.click(home);
    expect(onAll).toHaveBeenCalledOnce();
  });

  it("clears the static boot bar it replaces", () => {
    // index.astro paints a matching bar so the page is not blank before the
    // island runs. Two sticky bars is the failure mode if this is ever dropped,
    // and it is invisible in a test that never renders the static one.
    const boot = document.createElement("header");
    boot.id = "boot-chrome";
    document.body.append(boot);
    mount();
    expect(document.getElementById("boot-chrome")).toBeNull();
  });

  it("names the open wedding through the switcher", () => {
    mount();
    expect(screen.getByRole("button", { name: /switch wedding/i }).textContent).toContain(
      "Ruth & Vik",
    );
  });

  it("badges the caller's role with the reason it matters", () => {
    mount();
    const badge = screen.getByTitle(/you created this wedding/i);
    expect(badge.textContent).toBe("Owner");
  });

  it("badges a viewer with what to do about it", () => {
    render(() => (
      <TopBar
        session={SESSION}
        wedding={{ ...RUTH, role: "viewer" }}
        weddings={[RUTH]}
        sectionLabel="All weddings"
        onWedding={() => {}}
        onAll={() => {}}
        onSecurity={() => {}}
        onSignOut={() => {}}
        onOpenPalette={() => {}}
      />
    ));
    expect(screen.getByTitle(/ask the owner for editor access/i).textContent).toBe("Viewer");
  });

  it("falls back to the least privileged badge for a role it does not know", () => {
    // Roles come off the API. An unknown one must still render something honest
    // rather than a blank chip or a crash — and it must understate rather than
    // overstate, so nobody is told they can edit a wedding the API will refuse.
    render(() => (
      <TopBar
        session={SESSION}
        wedding={{ ...RUTH, role: "planner" as WeddingSummary["role"] }}
        weddings={[RUTH]}
        sectionLabel="All weddings"
        onWedding={() => {}}
        onAll={() => {}}
        onSecurity={() => {}}
        onSignOut={() => {}}
        onOpenPalette={() => {}}
      />
    ));
    expect(screen.getByTitle(/ask the owner for editor access/i).textContent).toBe("Viewer");
  });

  it("opens the palette, and advertises its shortcut", () => {
    const { onOpenPalette } = mount();
    const search = screen.getByRole("button", { name: /search and jump to/i });
    // aria-keyshortcuts is the only place ⌘K is announced — the visible "⌘K"
    // is aria-hidden decoration, and it is hidden outright on a narrow frame.
    expect(search.getAttribute("aria-keyshortcuts")).toBe("Meta+K Control+K");
    fireEvent.click(search);
    expect(onOpenPalette).toHaveBeenCalledOnce();
  });

  it("offers the invite preview for the open wedding", () => {
    mount();
    expect(screen.getByTestId("preview").textContent).toBe("wed_1");
  });

  it("gates the preview on nothing but having a wedding open — no width hides it", () => {
    // The regression: the preview used to sit inside `hidden @2xl/frame:inline`,
    // so on a phone the guest preview had no entry point anywhere in the portal
    // (the palette lists modules, weddings and account — never preview).
    // Collapsing to a glyph is the button's own business; the bar must not
    // decide the control does not exist at some widths.
    mount();
    for (
      let node: HTMLElement | null = screen.getByTestId("preview");
      node && node !== document.body;
      node = node.parentElement
    ) {
      // Class TOKENS, not a substring of the class string: `overflow-hidden` on
      // the sticky blurred header is an entirely plausible future addition, and
      // matching it here would fail this test with a message about the preview
      // button. `hidden` bare or as any variant's target (`@2xl/frame:hidden`,
      // `md:hidden`) is what actually removes the control.
      const gates = [...node.classList].filter((c) => c === "hidden" || c.endsWith(":hidden"));
      expect(gates).toEqual([]);
    }
  });

  it("routes the account menu's actions", async () => {
    const { onSecurity, onSignOut } = mount();
    const account = screen.getByRole("button", { name: /account menu/i });
    fireEvent.pointerDown(account, { button: 0 });
    fireEvent.pointerUp(await screen.findByText(/security & passkeys/i), { button: 0 });
    expect(onSecurity).toHaveBeenCalledOnce();

    fireEvent.pointerDown(account, { button: 0 });
    fireEvent.pointerUp(await screen.findByText(/sign out/i), { button: 0 });
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  describe("with no wedding open", () => {
    it("names the section instead of switching weddings", () => {
      mount({ wedding: null, sectionLabel: "Security" });
      expect(screen.getByText("Security")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /switch wedding/i })).toBeNull();
    });

    it("drops the role badge and the preview, keeping the palette and account", () => {
      mount({ wedding: null });
      expect(screen.queryByTestId("preview")).toBeNull();
      expect(screen.queryByTitle(/you created this wedding/i)).toBeNull();
      expect(screen.getByRole("button", { name: /search and jump to/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /account menu/i })).toBeTruthy();
    });

    it("still goes home from the wordmark", () => {
      const { onAll } = mount({ wedding: null });
      fireEvent.click(screen.getByRole("button", { name: "Cire — all weddings" }));
      expect(onAll).toHaveBeenCalledOnce();
    });
  });
});
