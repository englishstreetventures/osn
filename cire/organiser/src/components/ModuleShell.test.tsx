// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Module } from "../lib/dashboard-route";

/**
 * ModuleShell is the IA replacement for the flat tab bar: a left module rail
 * (Overview / Schedule / Guests / Invite / Settings) plus, inside a module that
 * has them, a row of sub-tabs. The active module + sub are controlled by the
 * parent (OrganiserApp owns the URL hash). The leaf panels are stubbed to
 * data-testids so this asserts only the shell glue: module navigation + active
 * state, sub-tab routing, role-gated sub visibility, and that a viewer / co-host
 * never reaches a write-only or owner-only sub even via a stale deep link.
 */

vi.mock("./Overview", () => ({
  default: (p: { weddingId: string }) => <div data-testid="overview">{p.weddingId}</div>,
}));
vi.mock("./EventTable", () => ({
  default: (p: { weddingId: string }) => <div data-testid="events">{p.weddingId}</div>,
}));
vi.mock("./EventsEditor", () => ({
  default: (p: { weddingId: string }) => <div data-testid="events-editor">{p.weddingId}</div>,
}));
vi.mock("./GuestsEditor", () => ({
  default: (p: { weddingId: string }) => <div data-testid="guests-editor">{p.weddingId}</div>,
}));
vi.mock("./GuestTable", () => ({
  default: (p: { weddingId: string }) => <div data-testid="guests">{p.weddingId}</div>,
}));
vi.mock("./ImportPanel", () => ({
  default: (p: { weddingId: string }) => <div data-testid="import">{p.weddingId}</div>,
}));
vi.mock("./RsvpView", () => ({
  default: (p: { weddingId: string }) => <div data-testid="rsvps">{p.weddingId}</div>,
}));
vi.mock("./InviteBuilder", () => ({
  default: (p: { weddingId: string }) => <div data-testid="invite-design">{p.weddingId}</div>,
}));
vi.mock("./RemintPanel", () => ({
  default: (p: { weddingId: string }) => <div data-testid="codes">{p.weddingId}</div>,
}));
vi.mock("./HostsPanel", () => ({
  default: (p: { weddingId: string }) => <div data-testid="hosts">{p.weddingId}</div>,
}));
vi.mock("./SettingsPanel", () => ({
  default: (p: { weddingId: string }) => <div data-testid="settings">{p.weddingId}</div>,
}));

import ModuleShell from "./ModuleShell";

/** Render with controllable module + sub signals so a test can drive the
 *  parent's "active view" the way OrganiserApp would on a hash change. */
function renderShell(opts: {
  canManage?: boolean;
  canEdit?: boolean;
  module?: Module;
  sub?: string;
}) {
  const [module, setModule] = createSignal<Module>(opts.module ?? "overview");
  const [sub, setSub] = createSignal(opts.sub ?? "index");
  const onModule = vi.fn((m: Module) => {
    setModule(m);
    // Mirror OrganiserApp: a module switch resets the sub to the module default.
    setSub(
      m === "guests" ? "list" : m === "invite" ? "design" : m === "settings" ? "wedding" : "index",
    );
  });
  const onSub = vi.fn((s: string) => setSub(s));
  const utils = render(() => (
    <ModuleShell
      weddingId="wed_1"
      weddingName="V & R"
      weddingSlug="v-and-r"
      canManage={opts.canManage ?? true}
      canEdit={opts.canEdit ?? true}
      module={module()}
      sub={sub()}
      onModule={onModule}
      onSub={onSub}
    />
  ));
  return { ...utils, onModule, onSub, setModule, setSub };
}

describe("ModuleShell", () => {
  afterEach(() => cleanup());

  it("renders the module rail with every module and lands on Overview", () => {
    renderShell({});
    for (const label of ["Overview", "Schedule", "Guests", "Invite", "Settings"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeTruthy();
    }
    expect(screen.getByTestId("overview")).toBeTruthy();
  });

  it("marks the active module with aria-current", () => {
    renderShell({ module: "guests", sub: "list" });
    const guests = screen.getByRole("button", { name: /Guests/ });
    expect(guests.getAttribute("aria-current")).toBe("page");
    const overview = screen.getByRole("button", { name: /Overview/ });
    expect(overview.getAttribute("aria-current")).toBeNull();
  });

  it("reports a module switch up via onModule and follows the controlled prop", () => {
    const { onModule } = renderShell({});
    fireEvent.click(screen.getByRole("button", { name: /Schedule/ }));
    expect(onModule).toHaveBeenCalledWith("schedule");
    expect(screen.getByTestId("events")).toBeTruthy();
  });

  it("shows the Schedule sub-tabs (Events + Edit) and switches to the events editor", () => {
    const { onSub } = renderShell({ module: "schedule", sub: "list" });
    expect(screen.getByRole("tab", { name: /Events/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Edit/ })).toBeTruthy();
    // The read view shows the events table.
    expect(screen.getByTestId("events")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Edit/ }));
    expect(onSub).toHaveBeenCalledWith("edit");
    expect(screen.getByTestId("events-editor")).toBeTruthy();
    expect(screen.queryByTestId("events")).toBeNull();
  });

  it("hides the Schedule Edit sub from a read-only viewer", () => {
    // A viewer can't edit — the editor-only Edit sub is filtered out, so the
    // sub-tab bar collapses to a single view and the editor is never reachable.
    renderShell({ canManage: false, canEdit: false, module: "schedule", sub: "edit" });
    expect(screen.queryByRole("tab", { name: /Edit/ })).toBeNull();
    expect(screen.queryByTestId("events-editor")).toBeNull();
    // Falls back to the read events table.
    expect(screen.getByTestId("events")).toBeTruthy();
  });

  it("shows the Guests sub-tabs (Households + RSVPs) and switches between them", () => {
    const { onSub } = renderShell({ module: "guests", sub: "list" });
    expect(screen.getByRole("tab", { name: /Households/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /RSVPs/ })).toBeTruthy();
    // Households sub shows the import (write surface) + the guest table.
    expect(screen.getByTestId("guests")).toBeTruthy();
    expect(screen.getByTestId("import")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /RSVPs/ }));
    expect(onSub).toHaveBeenCalledWith("rsvps");
    expect(screen.getByTestId("rsvps")).toBeTruthy();
    expect(screen.queryByTestId("guests")).toBeNull();
  });

  it("gives an owner the Invite Codes sub", () => {
    renderShell({ canManage: true, module: "invite", sub: "codes" });
    expect(screen.getByRole("tab", { name: /Codes/ })).toBeTruthy();
    expect(screen.getByTestId("codes")).toBeTruthy();
  });

  it("hides the owner-only Codes sub from a co-host and falls a deep link back", () => {
    // A co-host (editor) deep-linking invite/codes must not see the owner-only
    // Codes panel — it resolves to the invite module's default (Design) sub.
    renderShell({ canManage: false, canEdit: true, module: "invite", sub: "codes" });
    expect(screen.queryByRole("tab", { name: /Codes/ })).toBeNull();
    expect(screen.queryByTestId("codes")).toBeNull();
    expect(screen.getByTestId("invite-design")).toBeTruthy();
  });

  describe("viewer read-only", () => {
    it("hides the import write surface on the guest list", () => {
      renderShell({ canManage: false, canEdit: false, module: "guests", sub: "list" });
      expect(screen.getByTestId("guests")).toBeTruthy();
      // Import is a pure write surface — a viewer doesn't see it.
      expect(screen.queryByTestId("import")).toBeNull();
    });

    it("shows a read-only fallback instead of the invite builder", () => {
      renderShell({ canManage: false, canEdit: false, module: "invite", sub: "design" });
      expect(screen.queryByTestId("invite-design")).toBeNull();
      expect(screen.getByText(/view-only access/i)).toBeTruthy();
    });

    it("still gives a viewer the read RSVPs view", () => {
      renderShell({ canManage: false, canEdit: false, module: "guests", sub: "rsvps" });
      expect(screen.getByTestId("rsvps")).toBeTruthy();
    });
  });
});
