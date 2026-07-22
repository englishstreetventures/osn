// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import ModuleSidebar from "./ModuleSidebar";

/**
 * ModuleSidebar is the IA shell's primary nav — a keyboard-accessible <nav> of
 * module buttons with aria-current on the active one. It's presentational: it
 * renders every module (all have a read view, so nothing is hidden here — write
 * gating lives inside each module) and reports selections up.
 */
describe("ModuleSidebar", () => {
  afterEach(() => cleanup());

  /** The persistent rail. Both surfaces sit in the DOM — the container query
   *  hides one with `display: none`, which happy-dom doesn't apply — so module
   *  queries are scoped to the rail landmark rather than the document.
   *
   *  Both navs legitimately carry the same accessible name (only one is ever
   *  rendered to a real user), so the rail is picked as the one *outside* the
   *  dialog rather than by name alone — otherwise this helper would start
   *  throwing the moment a test queried it with the sheet open. */
  const rail = () => {
    const navs = screen.getAllByRole("navigation", { name: /Wedding modules/i });
    const found = navs.find((nav) => !nav.closest('[role="dialog"]'));
    if (!found) throw new Error("no module rail outside the sheet");
    return found;
  };

  it("renders every module in workflow order", () => {
    render(() => <ModuleSidebar active="overview" onSelect={vi.fn()} />);
    const labels = within(rail())
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(labels).toEqual([
      "◈Overview",
      "◇Schedule",
      "✓Checklist",
      "$Budget",
      "⬡Vendors",
      "✎Guests",
      "✦Invite",
      "✧Settings",
    ]);
  });

  it("marks the active module with aria-current and no others", () => {
    render(() => <ModuleSidebar active="invite" onSelect={vi.fn()} />);
    const marked = within(rail())
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-current") === "page");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toContain("Invite");
  });

  it("opens a sheet listing every module and closes it on a selection", async () => {
    const onSelect = vi.fn();
    render(() => <ModuleSidebar active="overview" onSelect={onSelect} />);

    // The narrow-container surface: a trigger naming the current module, so a
    // guest never has to open the sheet to know where they are.
    const trigger = screen.getByRole("button", { name: /Modules/ });
    expect(trigger.textContent).toContain("Overview");
    fireEvent.click(trigger);

    const sheet = await screen.findByRole("dialog", { name: /Wedding modules/i });
    const sheetLabels = within(sheet)
      .getAllByRole("button")
      // Drop the close button; keep the module rows.
      .filter((b) => b.getAttribute("aria-label") !== "Close modules")
      .map((b) => b.textContent);
    expect(sheetLabels).toHaveLength(8);
    expect(sheetLabels[0]).toContain("Overview");
    // Every module reachable in one screen — the point of replacing the strip.
    expect(sheetLabels.some((l) => l?.includes("Settings"))).toBe(true);

    fireEvent.click(within(sheet).getByRole("button", { name: /Budget/ }));
    expect(onSelect).toHaveBeenCalledWith("budget");
    // Picking a module dismisses the sheet rather than leaving it over the panel.
    // Asserted on the trigger's expanded state, not on unmount: Kobalte defers the
    // removal until the exit keyframe ends, and happy-dom applies no stylesheet, so
    // the node lingers here in a way it never would in a browser.
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
  });

  it("reports the selected module up via onSelect", () => {
    const onSelect = vi.fn();
    render(() => <ModuleSidebar active="overview" onSelect={onSelect} />);
    fireEvent.click(within(rail()).getByRole("button", { name: /Settings/ }));
    expect(onSelect).toHaveBeenCalledWith("settings");
  });

  it("is a labelled navigation landmark", () => {
    render(() => <ModuleSidebar active="overview" onSelect={vi.fn()} />);
    expect(rail().tagName).toBe("NAV");
    expect(rail().getAttribute("aria-label")).toBe("Wedding modules");
  });
});
