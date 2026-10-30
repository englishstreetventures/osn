// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import InviteMessageLinks, {
  type InviteMessagePlace,
} from "../../src/components/InviteMessageLinks";

/**
 * The line that tells an organiser where the other two pieces of the invite
 * message live. Each place names the other two; a place the reader's role can
 * open is a link that reports it, and one it cannot is named as text with
 * the role that can.
 */

type Role = "owner" | "editor" | "viewer";

const ROLES: Record<Role, { canEdit: boolean; canManage: boolean }> = {
  owner: { canEdit: true, canManage: true },
  editor: { canEdit: true, canManage: false },
  viewer: { canEdit: false, canManage: false },
};

const HREFS = {
  message: "#/w/w1/invite",
  codes: "#/w/w1/invite/codes",
  households: "#/w/w1/guests",
} as const satisfies Record<InviteMessagePlace, string>;

function renderLinks(here: InviteMessagePlace, role: Role) {
  const onNavigate = vi.fn<(place: InviteMessagePlace) => void>();
  const { container } = render(() => (
    <InviteMessageLinks here={here} {...ROLES[role]} hrefs={HREFS} onNavigate={onNavigate} />
  ));
  return { onNavigate, text: () => visibleText(container) };
}

/** The text as drawn: `.sr-only` spans are heard, not seen. */
function visibleText(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll(".sr-only")) hidden.remove();
  return copy.textContent ?? "";
}

const MESSAGE = "Invite, Design, Message";
const CODES = "Invite, Codes";
const HOUSEHOLDS = "Guests, Households";

describe("InviteMessageLinks", () => {
  afterEach(cleanup);

  it("in the message editor, sends the owner to Households and Codes", () => {
    const { onNavigate, text } = renderLinks("message", "owner");

    // The copy action sits above this line, in the same section.
    expect(text()).toMatch(/^Save, then copy a household's message above, or from Guests/);
    fireEvent.click(screen.getByRole("link", { name: HOUSEHOLDS }));
    fireEvent.click(screen.getByRole("link", { name: CODES }));
    expect(onNavigate.mock.calls).toEqual([["households"], ["codes"]]);
    expect(screen.queryByRole("link", { name: MESSAGE })).toBeNull();
  });

  it("in the message editor, names Codes as text for an editor, who cannot open it", () => {
    const { text } = renderLinks("message", "editor");

    expect(screen.getByRole("link", { name: HOUSEHOLDS })).toBeTruthy();
    expect(screen.queryByRole("link", { name: CODES })).toBeNull();
    expect(text()).toContain("Invite → Codes (Owner only)");
  });

  it("in Codes, sends the owner to the message editor and Households", () => {
    const { onNavigate, text } = renderLinks("codes", "owner");

    expect(text()).toMatch(/^Each code is the last line of a household's invite message\./);
    // Both places that copy a message are named.
    expect(text()).toMatch(/copy each household's message from there or from Guests/);
    fireEvent.click(screen.getByRole("link", { name: MESSAGE }));
    fireEvent.click(screen.getByRole("link", { name: HOUSEHOLDS }));
    expect(onNavigate.mock.calls).toEqual([["message"], ["households"]]);
    expect(screen.queryByRole("link", { name: CODES })).toBeNull();
  });

  it("in Households, sends the owner to the message editor and Codes", () => {
    const { onNavigate } = renderLinks("households", "owner");

    fireEvent.click(screen.getByRole("link", { name: MESSAGE }));
    fireEvent.click(screen.getByRole("link", { name: CODES }));
    expect(onNavigate.mock.calls).toEqual([["message"], ["codes"]]);
    expect(screen.queryByRole("link", { name: HOUSEHOLDS })).toBeNull();
  });

  it("in Households, links an editor to the message editor only", () => {
    const { text } = renderLinks("households", "editor");

    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: MESSAGE })).toBeTruthy();
    expect(text()).toContain("Invite → Codes (Owner only)");
  });

  it("in Households, gives a viewer no links and says who can open each place", () => {
    const { text } = renderLinks("households", "viewer");

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(text()).toContain("Invite → Design → Message (Owner and Editor only)");
    expect(text()).toContain("Invite → Codes (Owner only)");
  });

  it("keeps the arrow out of the spoken name", () => {
    renderLinks("codes", "owner");

    const link = screen.getByRole("link", { name: HOUSEHOLDS });
    // Seen as a path, heard as two words.
    expect(link.textContent).toContain("→");
    expect(link.querySelector('[aria-hidden="true"]')?.textContent).toContain("→");
  });

  it("links each place to its address, so it can open in a new tab", () => {
    renderLinks("codes", "owner");

    expect(screen.getByRole("link", { name: MESSAGE }).getAttribute("href")).toBe(HREFS.message);
    expect(screen.getByRole("link", { name: HOUSEHOLDS }).getAttribute("href")).toBe(
      HREFS.households,
    );
  });

  it("navigates a plain click through the callback, never the address", () => {
    // A hash change would skip the invite builder's unsaved-changes check.
    const { onNavigate } = renderLinks("codes", "owner");
    const link = screen.getByRole("link", { name: MESSAGE });

    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(onNavigate.mock.calls).toEqual([["message"]]);
  });

  it("leaves a modifier or middle click to the browser", () => {
    const { onNavigate } = renderLinks("codes", "owner");
    const link = screen.getByRole("link", { name: MESSAGE });

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
