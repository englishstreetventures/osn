// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GuestDataBound } from "../../src/components/CreateWeddingForm";
import GuestDataBoundNotice, {
  GuestDataBoundBanner,
} from "../../src/components/GuestDataBoundNotice";
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
  render(() => <GuestDataBoundNotice bound={BOUND} callerRole={role} onFix={onFix} />);

describe("GuestDataBoundNotice", () => {
  it.each(["viewer", "helper"] as const)("shows a %s nothing", (role) => {
    const { container } = show(role);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(["owner", "editor"] as const)(
    "shows an %s the warning, by default not as an alert, and its button opens the events",
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

  // One that appears in answer to a save is said aloud.
  it("is an alert when asked to announce itself", () => {
    render(() => (
      <GuestDataBoundNotice bound={BOUND} callerRole="owner" announce onFix={() => {}} />
    ));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "From 30 November 2026, Cire will delete this wedding's guest list.",
    );
  });
});

/**
 * The dashboard's banner: when a save clears the bound, the last one stays
 * mounted while it leaves, and nothing in it can be pressed or focused from
 * the first frame (the owner's choice, `cire/host/DESIGN.md`). A bound that
 * comes back is a new arrival, mounted afresh and announced.
 */
describe("GuestDataBoundBanner", () => {
  const showBanner = () => {
    const [bound, setBound] = createSignal<GuestDataBound | undefined>(BOUND);
    render(() => <GuestDataBoundBanner bound={bound()} callerRole="owner" onFix={() => {}} />);
    return setBound;
  };
  const wrapper = () => screen.getByTestId("guest-data-bound").closest(".bound-leave")!;

  it("keeps a cleared warning mounted, hidden and inert, while it leaves", () => {
    const setBound = showBanner();
    expect(wrapper().hasAttribute("hidden")).toBe(false);
    expect(wrapper().hasAttribute("inert")).toBe(false);

    setBound(undefined);

    expect(screen.getByTestId("guest-data-bound")).toBeInTheDocument();
    expect(wrapper().hasAttribute("hidden")).toBe(true);
    expect(wrapper().hasAttribute("inert")).toBe(true);
  });

  it("mounts a bound that comes back afresh, shown and announced", () => {
    const setBound = showBanner();
    expect(screen.queryByRole("alert")).toBeNull();
    setBound(undefined);

    setBound({ ...BOUND, state: "passed" });

    expect(screen.getAllByTestId("guest-data-bound")).toHaveLength(1);
    expect(wrapper().hasAttribute("hidden")).toBe(false);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Cire is deleting this wedding's guest list.",
    );
  });
});
