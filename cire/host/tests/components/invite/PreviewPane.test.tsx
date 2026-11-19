// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import PreviewPane, { type PreviewPaneProps } from "../../../src/components/invite/PreviewPane";

vi.mock("../../../src/lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../src/lib/api")>("../../../src/lib/api");
  return { ...actual, apiUrl: (path: string) => `https://api.test${path}` };
});

/** A minimal, valid `PreviewPaneProps` fixture: every section empty, the
 *  hero titled. Each case changes the one slot it reads. */
const previewProps: PreviewPaneProps = {
  tokens: {},
  toneSurface: () => "var(--color-bg)",
  design: "classic",
  hero: {
    state: "shown",
    imageUrl: null,
    crop: null,
    cropMobile: null,
    title: "Anita & Ben",
    heroBlur: 28,
    backdropOpacity: 0,
    backdropBlur: 0,
  },
  story: { state: "empty", eyebrow: "", heading: "", body: "" },
  welcome: { message: "" },
  events: { eyebrow: "", heading: "" },
  faq: { state: "empty", questions: [] },
  closing: { state: "empty", message: "", imageUrl: null, imageCrop: null },
};

afterEach(() => {
  cleanup();
});

describe("PreviewPane", () => {
  it("names the pack, falling back to the raw id for one this build doesn't carry", () => {
    // The mid-deploy case. If the `?? props.design` fallback were dropped the
    // label would render EMPTY while the miniature silently showed the default
    // pack's shape — a preview that says nothing about a design it isn't
    // showing, which is worse than the design-blind state it replaced.
    render(() => <PreviewPane {...previewProps} design="not-a-design" />);
    expect(screen.getByTestId("preview-design").textContent).toContain("not-a-design");
    // …and the shape falls back to the default pack rather than to nothing.
    expect(screen.getByLabelText("Invite preview").querySelector(".text-center")).toBeTruthy();
  });

  it("names a catalog pack by its display name, not its id", () => {
    render(() => <PreviewPane {...previewProps} design="gala" />);
    expect(screen.getByTestId("preview-design").textContent).toContain("Gala");
  });

  // The composed preview says WHY a section is missing, as the badge does.
  it("labels a hidden section's placeholder by its reason", () => {
    render(() => <PreviewPane {...previewProps} story={{ ...previewProps.story, state: "off" }} />);
    const strips = [...document.querySelectorAll("[data-hidden-strip]")] as HTMLElement[];
    expect(strips.map((el) => [el.dataset.hiddenStrip, el.textContent])).toEqual([
      ["off", "Our Story — switched off"],
      ["empty", "FAQ — hidden until it has content"],
      ["empty", "Closing — hidden until it has content"],
    ]);
  });

  it("shows the FAQ header and its first questions once it has entries", () => {
    render(() => (
      <PreviewPane
        {...previewProps}
        faq={{ state: "shown", questions: ["Is there parking?", "Are children invited?"] }}
      />
    ));
    const figure = screen.getByRole("figure", { name: "Invite preview" });
    expect(figure.textContent).toContain("Good to Know");
    expect(figure.textContent).toContain("Questions & Answers");
    expect(figure.textContent).toContain("Is there parking? · Are children invited?");
    expect(document.querySelector("[data-hidden-strip]")?.textContent).not.toMatch(/^FAQ/);
  });

  it("labels a switched-off FAQ's placeholder", () => {
    render(() => (
      <PreviewPane {...previewProps} faq={{ state: "off", questions: ["Is there parking?"] }} />
    ));
    const strips = [...document.querySelectorAll("[data-hidden-strip]")].map(
      (el) => el.textContent,
    );
    expect(strips).toContain("FAQ — switched off");
    expect(screen.queryByText(/Is there parking/)).toBeNull();
  });
});
