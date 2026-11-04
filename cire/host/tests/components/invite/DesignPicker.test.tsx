// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import DesignPicker from "../../../src/components/invite/DesignPicker";

vi.mock("@cire/invite-designs", () => ({
  DESIGNS: [
    { id: "classic", name: "Classic", tier: "free" },
    { id: "gala", name: "Gala", tier: "free" },
  ],
}));

afterEach(cleanup);

function renderPicker(currentId: string) {
  render(() => (
    <DesignPicker
      entitlements={[]}
      currentId={currentId}
      saving={false}
      onSelect={() => {}}
      // A link pill draws only an absolute http(s) address, as the guest
      // invite URL always is.
      previewHref={(id) => `https://invites.example/preview?design=${id}`}
    />
  ));
  return screen.getAllByRole("radio");
}

describe("DesignPicker tab stop", () => {
  it("makes the stored design the one tab stop", () => {
    const tabbable = renderPicker("gala").filter((r) => r.tabIndex === 0);
    expect(tabbable.map((r) => r.textContent)).toEqual([expect.stringContaining("Gala")]);
  });

  it("falls back to the first card when the stored design is not in this build", () => {
    const radios = renderPicker("from-a-newer-build");
    const tabbable = radios.filter((r) => r.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(radios[0]);
  });
});

describe("DesignPicker preview links", () => {
  it("names each link for its design and says it opens in a new tab", () => {
    renderPicker("classic");
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAccessibleName("Preview live Classic (opens in a new tab)");
    expect(links[1]).toHaveAccessibleName("Preview live Gala (opens in a new tab)");
  });
});
