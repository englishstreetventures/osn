// @vitest-environment happy-dom
import { cleanup, render } from "@solidjs/testing-library";
import Store from "lucide-solid/icons/store";
import { afterEach, describe, expect, it } from "vitest";

import ModuleIcon from "../../src/components/ModuleIcon";
import NestedDiamondIcon from "../../src/components/NestedDiamondIcon";

/**
 * `ModuleIcon` exists so size, stroke and hiding are set in one place for every
 * module mark. Size is proven in the browser tier; stroke is not visible to a
 * box measurement, so it is pinned here, for a library icon and for the one
 * drawn in this repo, which has to honour the same props to sit in the set.
 */

afterEach(cleanup);

const svgOf = (container: HTMLElement) => container.querySelector("svg")!;

describe("ModuleIcon", () => {
  for (const [name, icon] of [
    ["a lucide icon", Store],
    ["NestedDiamondIcon", NestedDiamondIcon],
  ] as const) {
    it(`draws ${name} at the shared size and stroke, hidden, with the caller's class`, () => {
      const { container } = render(() => <ModuleIcon icon={icon} class="text-gold" />);
      const svg = svgOf(container);
      expect(svg.getAttribute("stroke-width")).toBe("1.75");
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.classList.contains("size-icon")).toBe(true);
      expect(svg.classList.contains("text-gold")).toBe(true);
    });
  }
});

describe("NestedDiamondIcon", () => {
  it("takes lucide's size and colour props", () => {
    const { container } = render(() => <NestedDiamondIcon size={32} color="red" />);
    const svg = svgOf(container);
    expect(svg.getAttribute("width")).toBe("32");
    expect(svg.getAttribute("height")).toBe("32");
    expect(svg.getAttribute("stroke")).toBe("red");
  });

  it("falls back to lucide's defaults: 24 units, stroke 2, currentColor", () => {
    const { container } = render(() => <NestedDiamondIcon />);
    const svg = svgOf(container);
    expect(svg.getAttribute("width")).toBe("24");
    expect(svg.getAttribute("stroke-width")).toBe("2");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
  });
});
