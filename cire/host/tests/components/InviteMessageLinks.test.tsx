// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import InviteMessageLinks, {
  type InviteMessagePlace,
} from "../../src/components/InviteMessageLinks";

/**
 * The line that tells an organiser where the other two pieces of the invite
 * message live. Each place names the other two; a place the reader's role can
 * open is a button that reports it, and one it cannot is named as text with
 * the role that can.
 */

type Role = "owner" | "editor" | "viewer";

const ROLES: Record<Role, { canEdit: boolean; canManage: boolean }> = {
  owner: { canEdit: true, canManage: true },
  editor: { canEdit: true, canManage: false },
  viewer: { canEdit: false, canManage: false },
};

function renderLinks(here: InviteMessagePlace, role: Role) {
  const onNavigate = vi.fn<(place: InviteMessagePlace) => void>();
  const { container } = render(() => (
    <InviteMessageLinks here={here} {...ROLES[role]} onNavigate={onNavigate} />
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

    expect(text()).toMatch(/^Save, then copy each household's message from/);
    fireEvent.click(screen.getByRole("button", { name: HOUSEHOLDS }));
    fireEvent.click(screen.getByRole("button", { name: CODES }));
    expect(onNavigate.mock.calls).toEqual([["households"], ["codes"]]);
    expect(screen.queryByRole("button", { name: MESSAGE })).toBeNull();
  });

  it("in the message editor, names Codes as text for an editor, who cannot open it", () => {
    const { text } = renderLinks("message", "editor");

    expect(screen.getByRole("button", { name: HOUSEHOLDS })).toBeTruthy();
    expect(screen.queryByRole("button", { name: CODES })).toBeNull();
    expect(text()).toContain("Invite → Codes (Owner only)");
  });

  it("in Codes, sends the owner to the message editor and Households", () => {
    const { onNavigate, text } = renderLinks("codes", "owner");

    expect(text()).toMatch(/^Each code is the last line of a household's invite message\./);
    fireEvent.click(screen.getByRole("button", { name: MESSAGE }));
    fireEvent.click(screen.getByRole("button", { name: HOUSEHOLDS }));
    expect(onNavigate.mock.calls).toEqual([["message"], ["households"]]);
    expect(screen.queryByRole("button", { name: CODES })).toBeNull();
  });

  it("in Households, sends the owner to the message editor and Codes", () => {
    const { onNavigate } = renderLinks("households", "owner");

    fireEvent.click(screen.getByRole("button", { name: MESSAGE }));
    fireEvent.click(screen.getByRole("button", { name: CODES }));
    expect(onNavigate.mock.calls).toEqual([["message"], ["codes"]]);
    expect(screen.queryByRole("button", { name: HOUSEHOLDS })).toBeNull();
  });

  it("in Households, links an editor to the message editor only", () => {
    const { text } = renderLinks("households", "editor");

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: MESSAGE })).toBeTruthy();
    expect(text()).toContain("Invite → Codes (Owner only)");
  });

  it("in Households, gives a viewer no links and says who can open each place", () => {
    const { text } = renderLinks("households", "viewer");

    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(text()).toContain("Invite → Design → Message (Owner and Editor only)");
    expect(text()).toContain("Invite → Codes (Owner only)");
  });

  it("says the code style is chosen at creation and only changed in Codes", () => {
    const { text } = renderLinks("households", "owner");

    expect(text()).toContain("in the style chosen when the wedding was created; change it in");
  });

  it("keeps the arrow out of the spoken name", () => {
    renderLinks("codes", "owner");

    const button = screen.getByRole("button", { name: HOUSEHOLDS });
    // Seen as a path, heard as two words.
    expect(button.textContent).toContain("→");
    expect(button.querySelector('[aria-hidden="true"]')?.textContent).toContain("→");
  });
});
