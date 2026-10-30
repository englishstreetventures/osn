// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";

import ImageField from "../../../src/components/invite/ImageField";

/**
 * The invite picture's picker. Its visible label is a sibling line, not a
 * `<label>`, so the picker carries its own name; without it a screen reader
 * meets an unnamed "Choose File" button.
 */

afterEach(cleanup);

const noop = async () => {};

describe("ImageField", () => {
  it("names its file picker by the picture it sets", () => {
    render(() => (
      <ImageField
        label="Hero image"
        slot="hero"
        url={null}
        crop={null}
        onSelect={() => {}}
        onRemove={() => {}}
        onSaveCrop={noop}
      />
    ));
    const picker = document.querySelector('input[type="file"]');
    expect(picker).toHaveAccessibleName("Hero image: choose a picture");
    expect(screen.queryByRole("button", { name: "Crop" })).toBeNull();
  });
});
