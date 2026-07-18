// @vitest-environment happy-dom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import UpsellPanel from "./UpsellPanel";

describe("UpsellPanel", () => {
  afterEach(() => cleanup());

  it("renders the vendors feature title and blurb", () => {
    const { getByText } = render(() => <UpsellPanel feature="vendors" />);
    expect(getByText(/Vendors & directory/i)).toBeTruthy();
    expect(getByText(/Browse trusted wedding vendors/i)).toBeTruthy();
  });

  it("renders an inert CTA button (disabled — Phase 1, checkout not wired)", () => {
    const { getByRole } = render(() => <UpsellPanel feature="vendors" />);
    const btn = getByRole("button");
    expect(btn).toBeTruthy();
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});
