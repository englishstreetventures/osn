import { render, cleanup } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";

import { Icon } from "../../src/explore/icons";

describe("Icon", () => {
  afterEach(cleanup);

  it("renders an SVG for a known icon name", () => {
    const { container } = render(() => <Icon name="search" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
  });

  it("renders nothing for an unknown icon name", () => {
    const { container } = render(() => <Icon name="nonexistent" />);
    expect(container.innerHTML).toBe("");
  });

  it("applies custom size", () => {
    const { container } = render(() => <Icon name="clock" size={24} />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("width")).toBe("24");
    expect(svg.getAttribute("height")).toBe("24");
  });

  it("uses default size of 16 when not specified", () => {
    const { container } = render(() => <Icon name="bell" />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.getAttribute("height")).toBe("16");
  });

  const knownIcons = [
    "search",
    "clock",
    "map-pin",
    "bell",
    "filter",
    "plus",
    "chevron-right",
    "layers",
    "heart",
    "zap",
  ];

  for (const name of knownIcons) {
    it(`renders "${name}" icon as valid SVG`, () => {
      const { container } = render(() => <Icon name={name} />);
      const svg = container.querySelector("svg");
      expect(svg).toBeTruthy();
      expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg!.getAttribute("stroke")).toBe("currentColor");
    });
  }
});
