// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The builder tells its form how tall the sticky save bar is (`--save-bar-h`),
 * so a control focused near the foot of the page scrolls clear of the bar. The
 * variable follows the bar when it grows, and goes with the bar. happy-dom runs
 * no layout, so the test drives a stand-in `ResizeObserver` and a measured
 * height; the real layout is `GuestsStack.browser.test.tsx`'s kind of check.
 */

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});

vi.mock("@shared/toast", async () => {
  const { toastMock } = await import("../test-support/mocks");
  return toastMock();
});

vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

vi.mock("@cire/invite-designs", () => ({
  DESIGNS: [{ id: "classic", name: "Classic", tier: "free" }],
  DEFAULT_DESIGN_ID: "classic",
}));

import InviteBuilder from "../../src/components/InviteBuilder";
import { authFetchMock, resetOrganiserMocks } from "../test-support/mocks";

const CUSTOMISATION = {
  designId: "classic",
  hero: { title: null, subtitle: null, imageUrl: null },
  story: { eyebrow: null, heading: null, body: null, imageUrl: null },
  heroDisplay: { blur: 28, titleBackdrop: { opacity: 0, blur: 0 } },
  theme: {
    headingFont: null,
    bodyFont: null,
    palettePreset: null,
    palette: { ground: null, card: null, ink: null, gilt: null, bloom: null },
    tones: { hero: null, story: null, details: null, welcome: null },
  },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderBuilder() {
  render(() => (
    <InviteBuilder
      weddingId="wed_1"
      weddingSlug="anita-ben"
      weddingName="Anita & Ben"
      view="template"
      canEdit
      entitlements={[]}
    />
  ));
}

let barHeight = 72;
const observers: {
  callback: (entries: unknown[]) => void;
  disconnected: boolean;
  options?: ResizeObserverOptions;
}[] = [];

class FakeResizeObserver {
  private readonly entry: (typeof observers)[number];
  constructor(callback: (entries: unknown[]) => void) {
    this.entry = { callback, disconnected: false };
    observers.push(this.entry);
  }
  observe(_el: Element, options?: ResizeObserverOptions) {
    this.entry.options = options;
  }
  unobserve() {}
  disconnect() {
    this.entry.disconnected = true;
  }
}

describe("InviteBuilder save bar height", () => {
  beforeEach(() => {
    barHeight = 72;
    observers.length = 0;
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const h =
        this.classList.contains("sticky") && this.classList.contains("bottom-0") ? barHeight : 0;
      return { height: h, width: 0, top: 0, left: 0, right: 0, bottom: h, x: 0, y: 0 } as DOMRect;
    });
    authFetchMock.mockImplementation(async () => json(CUSTOMISATION));
  });
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function findForm(): Promise<HTMLFormElement> {
    const save = await screen.findByRole("button", { name: "Save invite" });
    return save.closest("form")!;
  }

  it("writes the bar's height on the form, follows it when it grows, and drops it with the bar", async () => {
    renderBuilder();
    const form = await findForm();
    await Promise.resolve();
    expect(form.style.getPropertyValue("--save-bar-h")).toBe("72px");

    // An error row joins the bar.
    barHeight = 128;
    for (const o of observers) o.callback([]);
    expect(form.style.getPropertyValue("--save-bar-h")).toBe("128px");

    // The bar's whole box, border included, is what covers a control.
    expect(observers.some((o) => o.options?.box === "border-box")).toBe(true);

    cleanup();
    expect(observers.every((o) => o.disconnected)).toBe(true);
    expect(form.style.getPropertyValue("--save-bar-h")).toBe("");
  });
});
