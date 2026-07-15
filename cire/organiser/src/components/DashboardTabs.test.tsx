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
vi.mock("./RsvpView", () => ({
  default: (p: { weddingId: string }) => <div data-testid="rsvps">{p.weddingId}</div>,
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
vi.mock("./EventLocationsPanel", () => ({
  default: (p: { weddingId: string }) => <div data-testid="event-locations">{p.weddingId}</div>,
}));
vi.mock("./SettingsPanel", () => ({
  default: (p: { weddingId: string }) => <div data-testid="settings">{p.weddingId}</div>,
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
      canEdit
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

  it("shows the Settings tab to a co-host and renders its panel (read-only inside)", () => {
    // Settings stays VISIBLE to co-hosts — the panel gates editing on
    // canManage, and the API's save is owner-only. A deep link must not fall
    // back to the default tab the way owner-only Codes does.
    renderTabs(false, "settings");
    expect(screen.getByRole("tab", { name: /Settings/ })).toBeTruthy();
    expect(screen.getByTestId("settings")).toBeTruthy();
    expect(screen.queryByTestId("events")).toBeNull();
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

  it("renders the read-only RSVPs panel (available to owner + co-host)", () => {
    const { setTab } = renderTabs(false, "events");
    expect(screen.getByRole("tab", { name: /RSVPs/ })).toBeTruthy();
    setTab("rsvps");
    expect(screen.getByTestId("rsvps")).toBeTruthy();
  });

  it("falls a co-host's deep-linked #codes tab back to a visible panel", () => {
    // A co-host opening `#/weddings/<id>/codes` must not see the owner-only
    // Codes panel — it resolves to the default Events tab instead.
    renderTabs(false, "codes");
    expect(screen.getByTestId("events")).toBeTruthy();
    expect(screen.queryByTestId("codes")).toBeNull();
  });
});
