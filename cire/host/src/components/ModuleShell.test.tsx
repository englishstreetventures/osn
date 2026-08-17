// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isModule, isSubOf, type Module } from "../lib/dashboard-route";

/**
 * ModuleShell is the IA replacement for the flat tab bar: a left module rail
 * (Overview / Events / Guests / Invite / Settings) plus, inside a module that
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
  // Surfaces `kind`: the whole point of the split is that the events module gets
  // an events import and the guests module a guests one, and a mock that reads
  // only weddingId would keep passing if both panels asked for the same sheet.
  default: (p: { weddingId: string; kind: string }) => (
    <div data-testid="import" data-kind={p.kind}>
      {p.weddingId}
    </div>
  ),
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
  // Surfaces BOTH flags, for the same reason SettingsPanel surfaces
  // canEditRsvpDeadline below: `canAdd={props.canEdit}` is the one line
  // connecting the API's weddingEditor() gate on POST /hosts to the portal's
  // add form, and with the mock reading only weddingId, reverting it to
  // `props.canManage` — switching the whole capability off for editors — left
  // all 663 organiser tests green.
  default: (p: { weddingId: string; canManage: boolean; canAdd: boolean }) => (
    <div data-testid="hosts" data-can-manage={String(p.canManage)} data-can-add={String(p.canAdd)}>
      {p.weddingId}
    </div>
  ),
}));
vi.mock("./SettingsPanel", () => ({
  // Surfaces canEditRsvpDeadline: it is the one line connecting the API's
  // co-host deadline write to a real co-host, and nothing else can see it.
  default: (p: { weddingId: string; canManage: boolean; canEditRsvpDeadline?: boolean }) => (
    <div
      data-testid="settings"
      data-can-manage={String(p.canManage)}
      data-can-edit-rsvp={String(p.canEditRsvpDeadline)}
    >
      {p.weddingId}
    </div>
  ),
}));
vi.mock("./VendorsView", () => ({
  default: (p: { weddingId: string }) => <div data-testid="vendors">{p.weddingId}</div>,
}));
vi.mock("./RegistryView", () => ({
  // Surfaces `view`: both sub-tabs mount the SAME component, so a mock reading
  // only weddingId would keep passing with the gift list and the gift log wired
  // to the same sub.
  default: (p: { weddingId: string; view: string }) => (
    <div data-testid="registry" data-view={p.view}>
      {p.weddingId}
    </div>
  ),
}));
vi.mock("./DirectoryBrowseView", () => ({
  default: (p: { weddingId: string }) => <div data-testid="directory-browse">{p.weddingId}</div>,
}));
vi.mock("./UpsellPanel", () => ({
  default: (p: { feature: string }) => (
    <div data-testid="upsell-panel" data-feature={p.feature}>
      Locked
    </div>
  ),
}));
vi.mock("./ChecklistView", () => ({
  default: (p: { weddingId: string }) => <div data-testid="checklist">{p.weddingId}</div>,
}));
vi.mock("./BudgetView", () => ({
  default: (p: { weddingId: string }) => <div data-testid="budget">{p.weddingId}</div>,
}));
vi.mock("./EnquiriesView", () => ({
  default: (p: { weddingId: string }) => <div data-testid="enquiries-view">{p.weddingId}</div>,
}));

import ModuleShell, { PANEL_LOADER_KEYS } from "./ModuleShell";

/** Render with controllable module + sub signals so a test can drive the
 *  parent's "active view" the way OrganiserApp would on a hash change. */
function renderShell(opts: {
  canManage?: boolean;
  canEdit?: boolean;
  module?: Module;
  sub?: string;
  entitlements?: string[];
  guestCap?: number;
}) {
  const [module, setModule] = createSignal<Module>(opts.module ?? "overview");
  const [sub, setSub] = createSignal(opts.sub ?? "index");
  const onModule = vi.fn((m: Module) => {
    setModule(m);
    // Mirror OrganiserApp: a module switch resets the sub to the module default.
    setSub(
      m === "guests" || m === "registry"
        ? "list"
        : m === "invite"
          ? "design"
          : m === "settings"
            ? "wedding"
            : "index",
    );
  });
  const onSub = vi.fn((s: string) => setSub(s));
  const utils = render(() => (
    <ModuleShell
      weddingId="wed_1"
      weddingName="R & V"
      weddingSlug="r-and-v"
      canManage={opts.canManage ?? true}
      canEdit={opts.canEdit ?? true}
      module={module()}
      sub={sub()}
      onModule={onModule}
      onSub={onSub}
      entitlements={opts.entitlements ?? []}
      guestCap={opts.guestCap ?? 100}
    />
  ));
  return { ...utils, onModule, onSub, setModule, setSub };
}

describe("ModuleShell", () => {
  afterEach(() => cleanup());

  /** The persistent rail. The nav also renders a narrow-container sheet trigger,
   *  so module queries are scoped to the rail landmark rather than the document. */
  const rail = () => screen.getByRole("navigation", { name: /Wedding modules/i });

  it("renders the module rail with every module and lands on Overview", () => {
    renderShell({});
    for (const label of ["Overview", "Events", "Guests", "Invite", "Settings"]) {
      expect(within(rail()).getByRole("button", { name: new RegExp(label) })).toBeTruthy();
    }
    expect(screen.getByTestId("overview")).toBeTruthy();
  });

  it("marks the active module with aria-current", () => {
    renderShell({ module: "guests", sub: "list" });
    const guests = within(rail()).getByRole("button", { name: /Guests/ });
    expect(guests.getAttribute("aria-current")).toBe("page");
    const overview = within(rail()).getByRole("button", { name: /Overview/ });
    expect(overview.getAttribute("aria-current")).toBeNull();
  });

  it("reports a module switch up via onModule and follows the controlled prop", () => {
    const { onModule } = renderShell({});
    fireEvent.click(within(rail()).getByRole("button", { name: /Events/ }));
    expect(onModule).toHaveBeenCalledWith("events");
    expect(screen.getByTestId("events")).toBeTruthy();
  });

  it("shows the Events sub-tabs (List + Edit) and switches to the events editor", async () => {
    const { onSub } = renderShell({ module: "events", sub: "list" });
    expect(screen.getByRole("tab", { name: /List/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Edit/ })).toBeTruthy();
    // The read view shows the events table.
    expect(screen.getByTestId("events")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Edit/ }));
    expect(onSub).toHaveBeenCalledWith("edit");
    // `findBy`, not `getBy`: the editor is lazy() — it arrives a microtask after
    // the tab is chosen, behind the panel's Suspense fallback.
    expect(await screen.findByTestId("events-editor")).toBeTruthy();
    expect(screen.queryByTestId("events")).toBeNull();
  });

  it("hides the Events Edit sub from a read-only viewer", () => {
    // A viewer can't edit — the editor-only Edit sub is filtered out, so the
    // sub-tab bar collapses to a single view and the editor is never reachable.
    renderShell({ canManage: false, canEdit: false, module: "events", sub: "edit" });
    expect(screen.queryByRole("tab", { name: /Edit/ })).toBeNull();
    expect(screen.queryByTestId("events-editor")).toBeNull();
    // Falls back to the read events table.
    expect(screen.getByTestId("events")).toBeTruthy();
  });

  it("shows the Guests sub-tabs (Households + RSVPs) and switches between them", () => {
    const { onSub } = renderShell({ module: "guests", sub: "list" });
    expect(screen.getByRole("tab", { name: /Households/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /RSVPs/ })).toBeTruthy();
    // The Households sub is a READ view now — the import moved into Edit.
    expect(screen.getByTestId("guests")).toBeTruthy();
    expect(screen.queryByTestId("import")).toBeNull();

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

  it("hides the owner-only Codes sub from a co-host and falls a deep link back", async () => {
    // A co-host (editor) deep-linking invite/codes must not see the owner-only
    // Codes panel — it resolves to the invite module's default (Design) sub.
    renderShell({ canManage: false, canEdit: true, module: "invite", sub: "codes" });
    expect(screen.queryByRole("tab", { name: /Codes/ })).toBeNull();
    expect(screen.queryByTestId("codes")).toBeNull();
    // The builder is lazy() — awaited for the same reason the events editor is.
    expect(await screen.findByTestId("invite-design")).toBeTruthy();
  });

  describe("settings profile — RSVP-by is the co-host's one writable field", () => {
    // Without these, swapping canEditRsvpDeadline to props.canManage (or
    // dropping it) leaves the whole feature dead in the portal with every
    // organiser and API test still green.
    it("gives an editor co-host the RSVP-by date but not the rest of the profile", () => {
      renderShell({ canManage: false, canEdit: true, module: "settings", sub: "wedding" });
      const panel = screen.getByTestId("settings");
      expect(panel.getAttribute("data-can-manage")).toBe("false");
      expect(panel.getAttribute("data-can-edit-rsvp")).toBe("true");
    });

    it("gives a viewer co-host neither", () => {
      renderShell({ canManage: false, canEdit: false, module: "settings", sub: "wedding" });
      const panel = screen.getByTestId("settings");
      expect(panel.getAttribute("data-can-manage")).toBe("false");
      expect(panel.getAttribute("data-can-edit-rsvp")).toBe("false");
    });

    it("gives the owner both", () => {
      renderShell({ canManage: true, canEdit: true, module: "settings", sub: "wedding" });
      const panel = screen.getByTestId("settings");
      expect(panel.getAttribute("data-can-manage")).toBe("true");
      expect(panel.getAttribute("data-can-edit-rsvp")).toBe("true");
    });
  });

  describe("co-hosts — adding follows canEdit, managing follows canManage", () => {
    // The additive/subtractive split has to survive the trip from OrganiserApp
    // through this shell: an editor may ADD a co-host (weddingEditor) but not
    // remove or demote one (weddingOwner). Wiring `canAdd` to the wrong flag
    // silently disables the feature with the API still granting it.
    it("gives an editor co-host the add form but not role/remove", () => {
      renderShell({ canManage: false, canEdit: true, module: "settings", sub: "hosts" });
      const panel = screen.getByTestId("hosts");
      expect(panel.getAttribute("data-can-add")).toBe("true");
      expect(panel.getAttribute("data-can-manage")).toBe("false");
    });

    it("gives a viewer co-host neither", () => {
      renderShell({ canManage: false, canEdit: false, module: "settings", sub: "hosts" });
      const panel = screen.getByTestId("hosts");
      expect(panel.getAttribute("data-can-add")).toBe("false");
      expect(panel.getAttribute("data-can-manage")).toBe("false");
    });

    it("gives the owner both", () => {
      renderShell({ canManage: true, canEdit: true, module: "settings", sub: "hosts" });
      const panel = screen.getByTestId("hosts");
      expect(panel.getAttribute("data-can-add")).toBe("true");
      expect(panel.getAttribute("data-can-manage")).toBe("true");
    });
  });

  /**
   * The CSV import moved out of the Guests READ tab (where it sat above the
   * household list carrying BOTH sheets) and into each module's Edit sub, as the
   * alternative to the on-page editor. These pin the two halves that have no
   * visible symptom when they break: that Edit offers the choice at all, and that
   * each module's import is scoped to its OWN sheet.
   */
  describe("chunk prefetch map", () => {
    it("keys PANEL_LOADERS on module:sub pairs that actually exist", () => {
      // `warmPanel` looks these up as `${module}:${sub}` and swallows a miss
      // (`?.()` + `.catch(() => {})`), so a key naming a module or sub that no
      // longer exists is invisible: no error, no failing test, just the hover
      // prefetch quietly dead and `PanelLoading` flashing on every Edit click.
      // The `schedule` → `events` rename is exactly that hazard, and this is the
      // same drift-guard shape the root CLAUDE.md prescribes for any constant
      // that has to agree with a string somewhere else.
      expect(PANEL_LOADER_KEYS.length).toBeGreaterThan(0);
      for (const key of PANEL_LOADER_KEYS) {
        const [module, sub] = key.split(":");
        expect(isModule(module!), `${key}: "${module}" is not a module`).toBe(true);
        expect(isSubOf(module as Module, sub!), `${key}: "${sub}" is not a sub of ${module}`).toBe(
          true,
        );
      }
    });
  });

  describe("edit sub — web editor or spreadsheet import", () => {
    const importMode = () => screen.getByRole("radio", { name: /spreadsheet import/i });

    it("lands on the editor, with import one click away", async () => {
      renderShell({ module: "guests", sub: "edit" });
      expect(await screen.findByTestId("guests-editor")).toBeTruthy();
      expect(screen.queryByTestId("import")).toBeNull();
      expect(importMode().getAttribute("aria-checked")).toBe("false");
    });

    it("swaps the guests editor for a GUESTS import", async () => {
      renderShell({ module: "guests", sub: "edit" });
      await screen.findByTestId("guests-editor");
      fireEvent.click(importMode());
      expect(screen.getByTestId("import").getAttribute("data-kind")).toBe("guests");
      expect(screen.queryByTestId("guests-editor")).toBeNull();
    });

    it("swaps the events editor for an EVENTS import", async () => {
      renderShell({ module: "events", sub: "edit" });
      await screen.findByTestId("events-editor");
      fireEvent.click(importMode());
      expect(screen.getByTestId("import").getAttribute("data-kind")).toBe("events");
      expect(screen.queryByTestId("events-editor")).toBeNull();
    });

    it("keeps the import out of a viewer's reach entirely", () => {
      // Edit is editor-gated, so a viewer deep-linking it lands on the read view
      // and never sees the mode switch, let alone the import.
      renderShell({ canManage: false, canEdit: false, module: "events", sub: "edit" });
      expect(screen.queryByRole("radiogroup")).toBeNull();
      expect(screen.queryByTestId("import")).toBeNull();
    });
  });

  describe("viewer read-only", () => {
    it("hides the import write surface from the guest list", () => {
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

  describe("entitlement gating — vendors module", () => {
    it("renders UpsellPanel when the vendors entitlement is absent", () => {
      // No entitlements → vendors module is locked.
      renderShell({ module: "vendors", sub: "index", entitlements: [] });
      expect(screen.getByTestId("upsell-panel")).toBeTruthy();
      expect(screen.getByTestId("upsell-panel").getAttribute("data-feature")).toBe("vendors");
      expect(screen.queryByTestId("vendors")).toBeNull();
      expect(screen.queryByTestId("directory-browse")).toBeNull();
    });

    it("renders the vendors feature views when the vendors entitlement is present", () => {
      renderShell({ module: "vendors", sub: "index", entitlements: ["vendors"] });
      expect(screen.queryByTestId("upsell-panel")).toBeNull();
      expect(screen.getByTestId("vendors")).toBeTruthy();
    });

    it("renders the browse sub-view when entitled and active() is 'browse'", () => {
      renderShell({ module: "vendors", sub: "browse", entitlements: ["vendors"] });
      expect(screen.queryByTestId("upsell-panel")).toBeNull();
      expect(screen.getByTestId("directory-browse")).toBeTruthy();
    });

    it("does not show UpsellPanel for other entitlements (only absent vendors key locks)", () => {
      // Has other entitlements but not vendors → still locked.
      renderShell({ module: "vendors", sub: "index", entitlements: ["capacity_500", "ai"] });
      expect(screen.getByTestId("upsell-panel")).toBeTruthy();
      expect(screen.queryByTestId("vendors")).toBeNull();
    });
  });

  /**
   * `RegistryView` is `lazy()`, so a mounted registry panel arrives a microtask
   * after the render — every positive assertion here has to await it. The
   * NEGATIVE ones do not, and deliberately are not awaited: the point of the
   * locked case is that the chunk is never asked for at all.
   */
  describe("entitlement gating — registry module", () => {
    it("renders UpsellPanel when the registry entitlement is absent", () => {
      // No wedding holds this entitlement yet, so the locked state is the NORMAL
      // one: every registry route answers 402 today. The gate has to keep the
      // views unmounted, or the module fires a guaranteed-failing fetch.
      renderShell({ module: "registry", sub: "list", entitlements: [] });
      expect(screen.getByTestId("upsell-panel")).toBeTruthy();
      expect(screen.getByTestId("upsell-panel").getAttribute("data-feature")).toBe("registry");
      expect(screen.queryByTestId("registry")).toBeNull();
    });

    it("renders the gift list when the registry entitlement is present", async () => {
      renderShell({ module: "registry", sub: "list", entitlements: ["registry"] });
      expect(screen.queryByTestId("upsell-panel")).toBeNull();
      expect((await screen.findByTestId("registry")).getAttribute("data-view")).toBe("list");
    });

    it("renders the gift log on the gifts sub", async () => {
      renderShell({ module: "registry", sub: "gifts", entitlements: ["registry"] });
      expect((await screen.findByTestId("registry")).getAttribute("data-view")).toBe("gifts");
    });

    it("stays locked on another module's entitlement", () => {
      // The vendors key unlocks vendors, nothing else.
      renderShell({ module: "registry", sub: "list", entitlements: ["vendors"] });
      expect(screen.getByTestId("upsell-panel").getAttribute("data-feature")).toBe("registry");
      expect(screen.queryByTestId("registry")).toBeNull();
    });

    it("gives a viewer the module read-only rather than hiding it", async () => {
      // Every module has a read view; the write controls are gated INSIDE
      // RegistryView by canEdit, not by hiding the module from the rail.
      renderShell({
        canManage: false,
        canEdit: false,
        module: "registry",
        sub: "gifts",
        entitlements: ["registry"],
      });
      expect(within(rail()).getByRole("button", { name: /Registry/ })).toBeTruthy();
      expect((await screen.findByTestId("registry")).getAttribute("data-view")).toBe("gifts");
    });

    it("offers both sub-tabs and reports a switch up", async () => {
      const { onSub } = renderShell({
        module: "registry",
        sub: "list",
        entitlements: ["registry"],
      });
      expect(screen.getByRole("tab", { name: /Gift list/ })).toBeTruthy();
      fireEvent.click(screen.getByRole("tab", { name: /Gifts received/ }));
      expect(onSub).toHaveBeenCalledWith("gifts");
      expect((await screen.findByTestId("registry")).getAttribute("data-view")).toBe("gifts");
    });
  });

  /**
   * The sub-tab strip follows the APG tabs pattern with **manual activation**:
   * arrows move focus, Enter/Space selects. That choice is load-bearing rather
   * than stylistic — every panel behind a tab mounts a view that fetches, so
   * selection-follows-focus would fire a request per keypress on the way past.
   * These tests pin the half of the pattern that has no visible symptom when it
   * breaks: the roving tabindex, the wiring between tab and panel, and the fact
   * that moving focus does *not* select.
   */
  describe("sub-tab keyboard semantics (APG tabs, manual activation)", () => {
    /** Guests carries three visible tabs for an editor — Households / Edit /
     *  RSVPs — so Home and End have somewhere to travel that the arrows don't. */
    const tabs = () => screen.getAllByRole("tab");

    it("keeps only the selected tab in the tab order", () => {
      renderShell({ module: "guests", sub: "edit" });
      const order = tabs().map((t) => [t.textContent, t.getAttribute("tabindex")]);
      expect(order).toEqual([
        ["Households", "-1"],
        ["Edit", "0"],
        ["RSVPs", "-1"],
      ]);
    });

    it("points every tab at the module's one panel, and the panel back at the selected tab", () => {
      renderShell({ module: "guests", sub: "rsvps" });
      const panel = screen.getByRole("tabpanel");
      expect(panel.id).toBe("subpanel-guests");
      for (const tab of tabs()) expect(tab.getAttribute("aria-controls")).toBe("subpanel-guests");
      // The panel names itself after whichever tab is selected, so a screen
      // reader entering the panel hears the view it is actually in.
      expect(panel.getAttribute("aria-labelledby")).toBe("subtab-guests-rsvps");
      expect(document.getElementById("subtab-guests-rsvps")?.textContent).toBe("RSVPs");
    });

    it("moves focus with the arrow keys without selecting", () => {
      const { onSub } = renderShell({ module: "guests", sub: "list" });
      const [households, edit] = tabs();
      households!.focus();
      fireEvent.keyDown(households!, { key: "ArrowRight" });
      expect(document.activeElement).toBe(edit);
      // The whole point of manual activation: focus landed on Edit, but the
      // guest editor has not mounted and no sub change was reported.
      expect(onSub).not.toHaveBeenCalled();
      expect(screen.queryByTestId("guests-editor")).toBeNull();
    });

    it("wraps at both ends", () => {
      renderShell({ module: "guests", sub: "list" });
      const list = tabs();
      const [households, , rsvps] = list;
      households!.focus();
      fireEvent.keyDown(households!, { key: "ArrowLeft" });
      expect(document.activeElement).toBe(rsvps);
      fireEvent.keyDown(rsvps!, { key: "ArrowRight" });
      expect(document.activeElement).toBe(households);
    });

    it("jumps to the ends with Home and End", () => {
      renderShell({ module: "guests", sub: "edit" });
      const [households, edit, rsvps] = tabs();
      edit!.focus();
      fireEvent.keyDown(edit!, { key: "End" });
      expect(document.activeElement).toBe(rsvps);
      fireEvent.keyDown(rsvps!, { key: "Home" });
      expect(document.activeElement).toBe(households);
    });

    it("selects the focused tab on click, and only then swaps the panel", async () => {
      const { onSub } = renderShell({ module: "guests", sub: "list" });
      const [, edit] = tabs();
      edit!.focus();
      fireEvent.click(edit!);
      expect(onSub).toHaveBeenCalledWith("edit");
      // The guests editor is lazy() — awaited, like the other two write panels.
      expect(await screen.findByTestId("guests-editor")).toBeTruthy();
      expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
        "subtab-guests-edit",
      );
    });

    it("claims no tab role at all for a module with a single view", () => {
      // Overview has no sub-tabs. A lone tab is not a tablist, and a panel with
      // nothing to label it must not advertise a tabpanel role — that would
      // promise a strip the host can never find.
      renderShell({ module: "overview" });
      expect(screen.queryByRole("tablist")).toBeNull();
      expect(screen.queryByRole("tab")).toBeNull();
      expect(screen.queryByRole("tabpanel")).toBeNull();
    });

    it("re-mints the tab/panel id pair when the module changes", () => {
      // Ids are derived from the module so the pair can never straddle two
      // modules mid-switch and leave aria-labelledby pointing at a dead node.
      const { setModule, setSub } = renderShell({ module: "guests", sub: "list" });
      expect(screen.getByRole("tabpanel").id).toBe("subpanel-guests");
      setModule("settings");
      setSub("hosts");
      const panel = screen.getByRole("tabpanel");
      expect(panel.id).toBe("subpanel-settings");
      expect(panel.getAttribute("aria-labelledby")).toBe("subtab-settings-hosts");
      expect(document.getElementById("subtab-settings-hosts")).toBeTruthy();
    });
  });
});
