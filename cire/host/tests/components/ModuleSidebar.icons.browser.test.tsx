import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import "../../src/styles/global.css";

/**
 * The module icons are one size wherever they appear, and only a real engine
 * can say what that size is. The unit tier proves every row renders an icon
 * carrying `size-icon`; it cannot prove the class resolves to anything. A
 * `--size-icon` renamed or dropped from `@theme` leaves the class compiling to
 * no CSS at all, and each SVG then falls back to lucide's own 24px attributes —
 * a third larger than intended, and a regression nothing else would catch.
 *
 * Both layouts are measured from their own mount, because the rail and the
 * sheet trigger are different elements under different container widths.
 */

vi.mock("../../src/lib/haptics", () => ({ haptic: () => {} }));

import ModuleSidebar from "../../src/components/ModuleSidebar";

/** Mount inside a `shell` container of an explicit width, as `ModuleShell` does. */
function mountAt(width: number) {
  return render(() => (
    <div class="@container/shell" style={{ width: `${width}px` }}>
      <ModuleSidebar
        weddingId="wed_test"
        active="overview"
        entitlements={["vendors"]}
        onSelect={() => {}}
      />
    </div>
  ));
}

/** The `--size-icon` token, in pixels, as the page resolves it. */
function tokenPx(): number {
  const probe = document.createElement("div");
  probe.className = "size-icon";
  document.body.append(probe);
  const px = probe.getBoundingClientRect().width;
  probe.remove();
  return px;
}

afterEach(cleanup);

describe("module icons", () => {
  it("resolves the size token to a real box", () => {
    // 1.125rem at the root's 16px. If this is 0, the utility never compiled.
    expect(tokenPx()).toBe(18);
  });

  it("draws every rail icon at the token's size, not lucide's 24px default", () => {
    const { container } = mountAt(1200);
    const rail = container.querySelector("nav[aria-label='Wedding modules']")!;
    const icons = [...rail.querySelectorAll("svg")];
    expect(icons).toHaveLength(9);
    for (const icon of icons) {
      const box = icon.getBoundingClientRect();
      expect(box.width).toBe(18);
      expect(box.height).toBe(18);
    }
  });

  it("draws the sheet trigger's icons at the same size on a phone", () => {
    const { container } = mountAt(375);
    const trigger = container.querySelector("button[aria-label^='Open wedding navigation']")!;
    const icons = [...trigger.querySelectorAll("svg")];
    // The current module's icon and the menu mark beside it.
    expect(icons).toHaveLength(2);
    for (const icon of icons) {
      const box = icon.getBoundingClientRect();
      expect(box.width).toBe(18);
      expect(box.height).toBe(18);
    }
  });
});
