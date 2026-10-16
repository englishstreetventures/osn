import { render, cleanup } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";

import { Icon } from "../../src/components/Icon";

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
});
