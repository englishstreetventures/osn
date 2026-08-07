// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import SectionIntro from "./SectionIntro";

/**
 * SectionIntro is the shared header used at the top of every tab panel — an
 * eyebrow, a serif heading, an optional description, and an optional actions
 * slot. These assert it renders each part and omits the optional ones cleanly.
 */
describe("SectionIntro", () => {
  afterEach(cleanup);

  it("renders the eyebrow and title", () => {
    render(() => <SectionIntro eyebrow="Guest list" title="Households" />);
    expect(screen.getByText("Guest list")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Households" })).toBeTruthy();
  });

  it("renders the description when given", () => {
    render(() => <SectionIntro eyebrow="E" title="T" description="A helpful line." />);
    expect(screen.getByText("A helpful line.")).toBeTruthy();
  });

  it("omits the description when not given", () => {
    render(() => <SectionIntro eyebrow="E" title="T" />);
    // Only the eyebrow + heading text are present; no stray paragraph.
    expect(screen.queryByText("A helpful line.")).toBeNull();
  });

  it("renders the actions slot", () => {
    render(() => (
      <SectionIntro eyebrow="E" title="T" actions={<button type="button">Export</button>} />
    ));
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
  });
});
