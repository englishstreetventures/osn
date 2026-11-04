import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../src/styles/global.css";

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({
  useAuth: () => ({ authFetch, activeProfileId: () => "usr_amy" }),
}));
vi.mock("@shared/toast", () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

import CreateWeddingForm from "../../src/components/CreateWeddingForm";
import RemintPanel from "../../src/components/RemintPanel";
import SecurityPanel from "../../src/components/SecurityPanel";

/*
 * A block pressed to choose (the 2026-11-04 consistency audit, item 4): the
 * code-style radio cards on a new wedding and in the re-mint panel are marked
 * as `choice` marks an answer, at their own 14px corner — a gold edge and a 2px
 * ring at 60%, no wash — and an unchosen card under the pointer goes halfway,
 * a 1px ring and an edge apart from the chosen one's, so a hover never reads
 * as a choice made. And Security's heading and link take the portal's section
 * heading (the display face, light) and secondary action (`outline`).
 */

afterEach(() => {
  cleanup();
  authFetch.mockReset();
});

const paint = (property: "color" | "backgroundColor", value: string) => {
  const probe = document.createElement("div");
  probe.style[property] = value;
  document.body.append(probe);
  const color = getComputedStyle(probe)[property];
  probe.remove();
  return color;
};

/** The spread of the one visible ring a `box-shadow` draws, in px, or 0. */
function ringSpread(el: Element): number {
  const shadow = getComputedStyle(el).boxShadow;
  if (shadow === "none") return 0;
  const rings = shadow.split(/,(?![^(]*\))/).map((s) => s.trim());
  const visible = rings.find((r) => !r.startsWith("rgba(0, 0, 0, 0)") && !/\/ 0\)/.test(r));
  const lengths = visible?.match(/-?\d+(\.\d+)?px/g) ?? [];
  return lengths.length ? Number.parseFloat(lengths.at(-1)!) : 0;
}

const settled = (el: Element) => Promise.all(el.getAnimations().map((a) => a.finished));

/** What a chosen card and an unchosen one paint, at rest and under the pointer. */
async function measure(chosen: HTMLElement, idle: HTMLElement) {
  await settled(chosen);
  const style = getComputedStyle(chosen);
  const before = { corner: style.borderTopLeftRadius, ring: ringSpread(idle) };
  await userEvent.hover(idle);
  await settled(idle);
  return {
    corner: before.corner,
    chosenEdge: style.borderTopColor === paint("color", "var(--gold)"),
    chosenRing: ringSpread(chosen),
    chosenGround: style.backgroundColor === paint("backgroundColor", "var(--bg)"),
    idleRing: before.ring,
    hoveredRing: ringSpread(idle),
    hoveredEdgeApart: getComputedStyle(idle).borderTopColor !== style.borderTopColor,
  };
}

const CHOSEN_AND_HALFWAY = {
  corner: "14px",
  chosenEdge: true,
  chosenRing: 2,
  chosenGround: true,
  idleRing: 0,
  hoveredRing: 1,
  hoveredEdgeApart: true,
};

describe("a code-style card", () => {
  it("is marked as a chosen answer on a new wedding, and goes halfway under the pointer", async () => {
    render(() => <CreateWeddingForm onCreated={() => {}} />);
    const radios = screen.getAllByRole("radio");
    const chosen = radios.find((r) => (r as HTMLInputElement).checked)!.closest("label")!;
    const idle = radios.find((r) => !(r as HTMLInputElement).checked)!.closest("label")!;
    expect(await measure(chosen, idle)).toEqual(CHOSEN_AND_HALFWAY);
  });

  it("is marked the same way in the re-mint panel", async () => {
    authFetch.mockResolvedValue(
      new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } }),
    );
    render(() => <RemintPanel weddingId="wed_a" />);
    const radios = await vi.waitFor(() => {
      const found = screen.getAllByRole("radio");
      expect(found.length).toBeGreaterThan(1);
      return found;
    });
    const chosen = radios.find((r) => (r as HTMLInputElement).checked)!.closest("label")!;
    const idle = radios.find((r) => !(r as HTMLInputElement).checked)!.closest("label")!;
    expect(await measure(chosen, idle)).toEqual(CHOSEN_AND_HALFWAY);
  });
});

describe("Security", () => {
  it("heads its section in the display face, light, and leads to musubi as an outline", async () => {
    render(() => <SecurityPanel />);
    const heading = screen.getByRole("heading", { name: /devices & passkeys/i });
    expect(getComputedStyle(heading).fontWeight).toBe("300");
    const link = screen.getByRole("link", { name: /manage on musubi/i });
    const rest = getComputedStyle(link).backgroundColor;
    await userEvent.hover(link);
    await settled(link);
    expect(getComputedStyle(link).backgroundColor).toBe(rest);
    expect(getComputedStyle(link).borderTopColor).toBe(paint("color", "var(--gold)"));
  });
});
