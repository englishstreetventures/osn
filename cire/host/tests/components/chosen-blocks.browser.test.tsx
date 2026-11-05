import { cleanup, render, screen, within } from "@solidjs/testing-library";
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
import { FilterSearch, FilterSelect } from "../../src/components/FilterField";
import DesignPicker from "../../src/components/invite/DesignPicker";
import EnvelopePicker from "../../src/components/invite/EnvelopePicker";
import RemintPanel from "../../src/components/RemintPanel";
import SecurityPanel from "../../src/components/SecurityPanel";

/*
 * A block pressed to choose (DESIGN.md §4, One pill language): the
 * code-style radio cards on a new wedding and in the re-mint panel are marked
 * as `choice` marks an answer, at their own 14px corner — a gold edge and a 2px
 * ring at 60%, no wash — and an unchosen card under the pointer goes halfway,
 * a 1px ring and an edge apart from the chosen one's, so a hover never reads
 * as a choice made. At rest an unchosen card moves on the quick step. And Security's heading and link take the portal's section
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

/** The duration `var(--dur-fast)` computes to: the clock a block rests on. */
function quickStep(): string {
  const probe = document.createElement("div");
  probe.style.transitionDuration = "var(--dur-fast)";
  document.body.append(probe);
  const value = getComputedStyle(probe).transitionDuration;
  probe.remove();
  return value;
}

/** What a chosen card and an unchosen one paint, at rest and under the pointer. */
async function measure(chosen: HTMLElement, idle: HTMLElement) {
  await settled(chosen);
  const style = getComputedStyle(chosen);
  const before = {
    corner: style.borderTopLeftRadius,
    ring: ringSpread(idle),
    clock: getComputedStyle(idle).transitionDuration === quickStep(),
  };
  await userEvent.hover(idle);
  await settled(idle);
  return {
    corner: before.corner,
    chosenEdge: style.borderTopColor === paint("color", "var(--gold)"),
    chosenRing: ringSpread(chosen),
    chosenGround: style.backgroundColor === paint("backgroundColor", "var(--bg)"),
    idleRing: before.ring,
    idleOnQuickStep: before.clock,
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
  idleOnQuickStep: true,
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

/*
 * A design or an envelope card is not itself the control: it holds a radio,
 * and a design's card a "Preview live" link beside it. So an unchosen card goes
 * halfway only while the pointer is on its radio and a press there would
 * choose it — never over the card's padding or its link, which choose nothing,
 * and never on a locked choice (DESIGN.md §4, One pill language; §7, Card).
 */
describe("a picker card", () => {
  /** The card's ring spread with the pointer at `target`, once it has moved. */
  async function ringWith(card: HTMLElement, target: HTMLElement, x?: number, y?: number) {
    await userEvent.hover(target, x === undefined ? undefined : { position: { x, y: y ?? x } });
    await settled(card);
    return ringSpread(card);
  }

  it("goes halfway over a design's radio, and not over its padding or its preview link", async () => {
    render(() => (
      <DesignPicker
        entitlements={[]}
        currentId="classic"
        saving={false}
        onSelect={() => {}}
        previewHref={(id) => `https://invites.test/?design=${id}`}
      />
    ));
    const radio = screen.getByRole("radio", { name: /Gala/ });
    const card = radio.parentElement!;
    expect({
      radio: await ringWith(card, radio),
      padding: await ringWith(card, card, 4),
      link: await ringWith(card, within(card).getByRole("link", { name: /Preview live/ })),
    }).toEqual({ radio: 1, padding: 0, link: 0 });
  });

  it("goes halfway over an envelope it may choose, and stays at rest over a locked one", async () => {
    const pick = (entitled: boolean) => (
      <EnvelopePicker
        entitled={entitled}
        currentId={null}
        saving={false}
        heroState="shown"
        onSelect={() => {}}
      />
    );
    const open = render(() => pick(true));
    const choosable = screen.getByRole("radio", { name: /Wax seal/ });
    const free = await ringWith(choosable.parentElement!, choosable);
    open.unmount();
    render(() => pick(false));
    const locked = screen.getByRole("radio", { name: /Wax seal/ });
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    expect({ free, locked: await ringWith(locked.parentElement!, locked) }).toEqual({
      free: 1,
      locked: 0,
    });
  });
});

/*
 * The filter parts' own type and clock, measured here rather than in the RSVP
 * page's suite, which turns every transition off to read colours: a filter's
 * words on the small step, and its edge moving on the hover clock with no
 * outline in the list, so the focus ring lands at once.
 */
describe("a filter part", () => {
  it("sets its words on the small step and moves its edge on the hover clock", () => {
    render(() => (
      <div class="bg-bg w-80 p-4">
        <FilterSearch type="search" aria-label="Search guests" />
        <FilterSelect aria-label="Event">
          <option>Ceremony</option>
        </FilterSelect>
      </div>
    ));
    const clock = (() => {
      const probe = document.createElement("div");
      probe.style.transitionDuration = "var(--dur-fast)";
      document.body.append(probe);
      const value = getComputedStyle(probe).transitionDuration;
      probe.remove();
      return value;
    })();
    const small = (() => {
      const probe = document.createElement("div");
      probe.style.fontSize = "var(--ui-text-sm)";
      document.body.append(probe);
      const value = getComputedStyle(probe).fontSize;
      probe.remove();
      return value;
    })();
    for (const field of [
      screen.getByRole("searchbox", { name: "Search guests" }),
      screen.getByRole("combobox", { name: "Event" }),
    ]) {
      const style = getComputedStyle(field);
      expect([style.fontSize, style.transitionDuration]).toEqual([small, clock]);
      expect(style.transitionProperty).not.toMatch(/outline|all/);
    }
  });
});

describe("Security", () => {
  it("heads its section in the display face, light, and leads to musubi as an outline", async () => {
    render(() => <SecurityPanel />);
    const heading = screen.getByRole("heading", { name: /devices & passkeys/i });
    expect(getComputedStyle(heading).fontWeight).toBe("300");
    const link = screen.getByRole("link", { name: /manage on musubi/i });
    // `outline`: a gold word in a gold edge, not the hairline and the
    // secondary ink a quiet pill rests in.
    expect(getComputedStyle(link).color).toBe(paint("color", "var(--gold-ink)"));
    expect(getComputedStyle(link).borderTopColor).not.toBe(paint("color", "var(--border)"));
    const rest = getComputedStyle(link).backgroundColor;
    await userEvent.hover(link);
    await settled(link);
    expect(getComputedStyle(link).backgroundColor).toBe(rest);
    expect(getComputedStyle(link).borderTopColor).toBe(paint("color", "var(--gold)"));
  });
});
