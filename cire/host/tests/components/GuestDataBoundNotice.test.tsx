// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GuestDataBound } from "../../src/components/CreateWeddingForm";
import GuestDataBoundNotice from "../../src/components/GuestDataBoundNotice";
import type { WeddingRole } from "../../src/lib/wedding-roles";

/**
 * The warning shows only to a seat that can set the events' dates. The API
 * sends the bound to owners and editors alone; the portal holds the same line
 * for a role that changed in this tab since the list was read.
 */

afterEach(cleanup);

const BOUND: GuestDataBound = {
  state: "near",
  reason: "unreadable-date",
  from: "2026-11-30T12:00:00.000Z",
  events: ["Ceremony"],
  eventCount: 1,
};

const show = (role: WeddingRole, onFix = vi.fn()) =>
  render(() => <GuestDataBoundNotice bound={BOUND} role={role} onFix={onFix} />);

describe("GuestDataBoundNotice", () => {
  it.each(["viewer", "helper"] as const)("shows a %s nothing", (role) => {
    const { container } = show(role);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(["owner", "editor"] as const)(
    "shows an %s the warning, not as an alert, and its button opens the events",
    (role) => {
      const onFix = vi.fn();
      show(role, onFix);
      expect(
        screen.getByText("From 30 November 2026, Cire will delete this wedding's guest list."),
      ).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Edit events" }));
      expect(onFix).toHaveBeenCalledOnce();
    },
  );
});
