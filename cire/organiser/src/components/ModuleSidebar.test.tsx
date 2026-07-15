// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
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

  it("renders every module in workflow order", () => {
    render(() => <ModuleSidebar active="overview" onSelect={vi.fn()} />);
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["◈Overview", "◇Schedule", "✎Guests", "✦Invite", "✧Settings"]);
  });

  it("marks the active module with aria-current and no others", () => {
    render(() => <ModuleSidebar active="invite" onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Invite/ }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(
      screen.getByRole("button", { name: /Overview/ }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("reports the selected module up via onSelect", () => {
    const onSelect = vi.fn();
    render(() => <ModuleSidebar active="overview" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
    expect(onSelect).toHaveBeenCalledWith("settings");
  });

  it("is a labelled navigation landmark", () => {
    render(() => <ModuleSidebar active="overview" onSelect={vi.fn()} />);
    expect(screen.getByRole("navigation", { name: /Wedding modules/i })).toBeTruthy();
  });
});
