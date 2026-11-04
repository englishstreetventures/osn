// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import InviteMessageLinks, {
  type InviteMessagePlace,
} from "../../src/components/InviteMessageLinks";

/**
 * The line that tells an organiser where the other piece of the invite
 * message lives: Codes, where its first line is written beside the codes that
 * end it, and Households, where every household's message is copied. Each
 * place names the other; a place the reader's role can open is a link that
 * reports it, and one it cannot is named as text with the role that can.
 */

type Role = "owner" | "editor" | "viewer";

const ROLES: Record<Role, { canEdit: boolean; canManage: boolean }> = {
  owner: { canEdit: true, canManage: true },
  editor: { canEdit: true, canManage: false },
  viewer: { canEdit: false, canManage: false },
};

const HREFS = {
  codes: "#/w/w1/invite/codes",
  households: "#/w/w1/guests",
} as const satisfies Record<InviteMessagePlace, string>;

function renderLinks(here: InviteMessagePlace, role: Role) {
  const onNavigate = vi.fn<(place: InviteMessagePlace) => void>();
  const { container } = render(() => (
    <InviteMessageLinks
      here={here}
      {...ROLES[role]}
      href={(place) => HREFS[place]}
      onNavigate={onNavigate}
    />
  ));
  return { onNavigate, text: () => visibleText(container) };
}

/** The text as drawn: `.sr-only` spans are heard, not seen. */
function visibleText(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll(".sr-only")) hidden.remove();
  return copy.textContent ?? "";
}

const CODES = "Invite, Codes";
const HOUSEHOLDS = "Guests, Households";

describe("InviteMessageLinks", () => {
  afterEach(cleanup);

  it("in Codes, sends the owner to Households, and to the code style at the top", () => {
    const { onNavigate, text } = renderLinks("codes", "owner");

    // The copy action sits above this line, in the same card.
    expect(text()).toMatch(/^Save, then copy a household's message above, or from Guests/);
    expect(text()).toMatch(
      /chosen when the wedding was created; change it at the top of this page\.$/,
    );
    fireEvent.click(screen.getByRole("link", { name: HOUSEHOLDS }));
    expect(onNavigate.mock.calls).toEqual([["households"]]);
    expect(screen.queryByRole("link", { name: CODES })).toBeNull();
  });

  it("in Codes, tells an editor that an owner changes the code style", () => {
    const { text } = renderLinks("codes", "editor");

    expect(screen.getByRole("link", { name: HOUSEHOLDS })).toBeTruthy();
    expect(text()).toMatch(/chosen when the wedding was created, which an owner can change\.$/);
  });

  it("in Households, sends the owner to Codes, where the style changes too", () => {
    const { onNavigate, text } = renderLinks("households", "owner");

    fireEvent.click(screen.getByRole("link", { name: CODES }));
    expect(onNavigate.mock.calls).toEqual([["codes"]]);
    expect(screen.queryByRole("link", { name: HOUSEHOLDS })).toBeNull();
    expect(text()).toMatch(/; change it there\.$/);
  });

  it("in Households, links an editor to Codes without promising the style", () => {
    const { text } = renderLinks("households", "editor");

    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: CODES })).toBeTruthy();
    expect(text()).not.toContain("change it");
  });

  it("in Households, gives a viewer no links and says who can open Codes", () => {
    const { text } = renderLinks("households", "viewer");

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(text()).toContain("Invite → Codes (Owner and Editor only)");
  });

  it("keeps the arrow out of the spoken name", () => {
    renderLinks("codes", "owner");

    const link = screen.getByRole("link", { name: HOUSEHOLDS });
    // Seen as a path, heard as two words.
    expect(link.textContent).toContain("→");
    expect(link.querySelector('[aria-hidden="true"]')?.textContent).toContain("→");
  });

  it("links each place to its address, so it can open in a new tab", () => {
    renderLinks("households", "owner");
    expect(screen.getByRole("link", { name: CODES }).getAttribute("href")).toBe(HREFS.codes);
    cleanup();
    renderLinks("codes", "owner");
    expect(screen.getByRole("link", { name: HOUSEHOLDS }).getAttribute("href")).toBe(
      HREFS.households,
    );
  });

  it("navigates a plain click through the callback, never the address", () => {
    // A hash change would skip the invite builder's unsaved-changes check.
    const { onNavigate } = renderLinks("households", "owner");
    const link = screen.getByRole("link", { name: CODES });

    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(onNavigate.mock.calls).toEqual([["codes"]]);
  });

  it("leaves a modifier or middle click to the browser", () => {
    const { onNavigate } = renderLinks("households", "owner");
    const link = screen.getByRole("link", { name: CODES });

    for (const init of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      const click = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
      link.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(false);
    }
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
