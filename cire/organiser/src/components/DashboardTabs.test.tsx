// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DashboardTab } from "../lib/dashboard-route";

/**
 * DashboardTabs is the per-wedding tab bar, now a CONTROLLED component: the
 * active tab comes in as a prop (the parent, OrganiserApp, owns the URL hash)
 * and a click reports up via `onTab`. The leaf panels are stubbed to
 * data-testids so this asserts only the tab glue: workflow-ordered tabs, the
 * owner-vs-co-host tab set, the controlled active panel + change callback, and
 * that a deep-linked owner-only `codes` tab can't expose the owner panel to a
 * co-host (it falls back to a visible tab).
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

/** Render with a controllable `tab` signal so a test can drive the parent's
 *  "active tab" the way OrganiserApp would on a hash change. */
function renderTabs(canManage: boolean, initial: DashboardTab = "events") {
  const [tab, setTab] = createSignal<DashboardTab>(initial);
  const onTab = vi.fn((t: DashboardTab) => setTab(t));
  const utils = render(() => (
    <DashboardTabs
      weddingId="wed_1"
      weddingName="V & R"
      weddingSlug="v-and-r"
      canManage={canManage}
      tab={tab()}
      onTab={onTab}
    />
  ));
  return { ...utils, onTab, setTab };
}

describe("DashboardTabs", () => {
  afterEach(() => cleanup());

  it("renders the controlled tab's panel (events by default)", () => {
    renderTabs(true, "events");
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

  it("reports a tab switch up via onTab when a tab is clicked", () => {
    const { onTab } = renderTabs(true);
    fireEvent.click(screen.getByRole("tab", { name: /Invite/ }));
    expect(onTab).toHaveBeenCalledWith("invite");
    // The controlled signal followed the click, so the panel switched.
    expect(screen.getByTestId("invite")).toBeTruthy();
  });

  it("follows the controlled tab prop (the parent's hash-driven change)", () => {
    const { setTab } = renderTabs(true, "events");
    setTab("guests");
    expect(screen.getByTestId("guests")).toBeTruthy();
    expect(screen.queryByTestId("events")).toBeNull();
  });

  it("falls a co-host's deep-linked #codes tab back to a visible panel", () => {
    // A co-host opening `#/weddings/<id>/codes` must not see the owner-only
    // Codes panel — it resolves to the default Events tab instead.
    renderTabs(false, "codes");
    expect(screen.getByTestId("events")).toBeTruthy();
    expect(screen.queryByTestId("codes")).toBeNull();
  });
});
