// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DashboardTabs is the per-wedding tab bar. The leaf panels are stubbed to
 * data-testids so this asserts only the tab glue: workflow-ordered tabs, the
 * owner-vs-co-host tab set, hash-routing both ways (a click writes the hash; an
 * external hashchange — e.g. the Getting-started jump — switches the panel), and
 * that a stale `#codes` hash can't expose the owner-only panel to a co-host.
 */

vi.mock("./EventTable", () => ({
  default: (p: { weddingId: string }) => <div data-testid="events">{p.weddingId}</div>,
}));
vi.mock("./GuestTable", () => ({
  default: (p: { weddingId: string }) => <div data-testid="guests">{p.weddingId}</div>,
}));
vi.mock("./InviteBuilder", () => ({
  default: (p: { weddingId: string }) => <div data-testid="invite">{p.weddingId}</div>,
}));
vi.mock("./RemintPanel", () => ({
  default: (p: { weddingId: string }) => <div data-testid="codes">{p.weddingId}</div>,
}));
vi.mock("./HostsPanel", () => ({
  default: (p: { weddingId: string }) => <div data-testid="hosts">{p.weddingId}</div>,
}));

import DashboardTabs from "./DashboardTabs";

function renderTabs(canManage: boolean) {
  return render(() => (
    <DashboardTabs
      weddingId="wed_1"
      weddingName="V & R"
      weddingSlug="v-and-r"
      canManage={canManage}
    />
  ));
}

describe("DashboardTabs", () => {
  beforeEach(() => {
    window.location.hash = "";
  });
  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it("defaults to the Events tab (workflow order leads with the day)", () => {
    renderTabs(true);
    expect(screen.getByTestId("events")).toBeTruthy();
    expect(screen.queryByTestId("guests")).toBeNull();
  });

  it("shows owner tabs (Codes) for an owner", () => {
    renderTabs(true);
    expect(screen.getByRole("tab", { name: /Codes/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Hosts/ })).toBeTruthy();
  });

  it("hides the Codes tab for a co-host", () => {
    renderTabs(false);
    expect(screen.queryByRole("tab", { name: /Codes/ })).toBeNull();
    expect(screen.getByRole("tab", { name: /Hosts/ })).toBeTruthy();
  });

  it("switches panels and writes the hash when a tab is clicked", () => {
    renderTabs(true);
    fireEvent.click(screen.getByRole("tab", { name: /Invite/ }));
    expect(screen.getByTestId("invite")).toBeTruthy();
    expect(window.location.hash).toBe("#invite");
  });

  it("responds to an external hashchange (the Getting-started jump)", () => {
    renderTabs(true);
    window.location.hash = "guests";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(screen.getByTestId("guests")).toBeTruthy();
    expect(screen.queryByTestId("events")).toBeNull();
  });

  it("falls a co-host's stale #codes hash back to Events", () => {
    window.location.hash = "codes";
    renderTabs(false);
    expect(screen.getByTestId("events")).toBeTruthy();
    expect(screen.queryByTestId("codes")).toBeNull();
  });
});
