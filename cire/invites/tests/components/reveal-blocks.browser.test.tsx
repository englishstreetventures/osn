import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { batch, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";
// Loaded up front, as the page warms them while a claim is in flight, so the
// boxes render on the frame they open rather than a chunk later.
import "../../src/components/GuestEmailBox";
import "../../src/components/PulseAccountLink";
import { EventSheet } from "../../src/components/EventSheet";
import { GiftMoneyPanel } from "../../src/components/gift-registry/GiftMoneyPanel";
import { GiftRegistryItemCard } from "../../src/components/gift-registry/GiftRegistryItemCard";
import { LoginSection } from "../../src/components/LoginSection";
import type {
  ClaimResult,
  EventSummary,
  FamilyMember,
  RsvpSummary,
} from "../../src/components/types";
import type { GiftRegistryItem } from "../../src/lib/gift-registry-read";

/*
 * The guest site's blocks that open through `@cire/ui/reveal`, measured.
 *
 * Each block — the dietary picker after "Attending", the gift page's "Another
 * amount" field, a gift's reserve form, and the email and musubi boxes after
 * "Who are you?" — grows from nothing as it fades in, on the ladder's slow
 * rung, and goes at once. The opening is sampled a quarter of the way through
 * its transitions: the height is between nothing and the block's own, the
 * content shows down to the box's growing edge with no empty band under it,
 * and the opacity is between nothing and full. A block that snapped open would
 * have no transition to pause, and one that only faded would be at its full
 * height a quarter of the way in.
 *
 * A block that was already open when its state was restored — a reply on file,
 * a household reopened from its session — is simply open: nothing transitions.
 *
 * And a field inside one keeps its whole focus ring. `Reveal` clips what it
 * holds, so the ring of a field at the clip's edge — 2px wide and 2px out —
 * is measured against every box that clips it.
 *
 * happy-dom computes no layout and runs no transitions; none of this is
 * visible below this tier.
 */

const PHONE: readonly [number, number] = [390, 844];
/** Past the `md:` breakpoint, where the dietary pills wrap into rows. */
const WIDE: readonly [number, number] = [1024, 900];

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await page.viewport(...PHONE);
});

const frame = () => new Promise(requestAnimationFrame);

/** The `Reveal` wrapper round an element: the grid whose rows move. */
function revealOf(el: Element): HTMLElement {
  const wrapper = el.closest<HTMLElement>('[class~="grid-rows-[0fr]"], [class~="grid-rows-[1fr]"]');
  if (!wrapper) throw new Error("no Reveal wrapper round the element");
  return wrapper;
}

/**
 * The height the wrapper gives its content: its box less the ring's room
 * (`Reveal`'s padding, which its negative margin hands back to the layout).
 */
function heldHeight(wrapper: HTMLElement): number {
  const s = getComputedStyle(wrapper);
  return (
    wrapper.getBoundingClientRect().height - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)
  );
}

/**
 * How far above the wrapper's own bottom edge the content is cut: the nearest
 * box between them that clips vertically. Zero when the wrapper is the cut, so
 * the content shows as far down as the box has grown.
 */
function cutAboveEdge(wrapper: HTMLElement): number {
  const content = wrapper.firstElementChild!.firstElementChild!;
  let cut = Infinity;
  for (let a = content.parentElement; a; a = a.parentElement) {
    const s = getComputedStyle(a);
    if (s.overflowY === "clip" || s.overflowY === "hidden") {
      cut = Math.min(cut, a.getBoundingClientRect().bottom - parseFloat(s.borderBottomWidth));
    }
    if (a === wrapper) break;
  }
  return wrapper.getBoundingClientRect().bottom - cut;
}

/**
 * The wrapper's opening, a frame after it began: which properties transition;
 * a quarter of the way through, the height it holds, its opacity and how far
 * above its edge the content is cut; then the settled height and opacity.
 */
async function sampleOpening(wrapper: HTMLElement) {
  await frame();
  const running = wrapper.getAnimations() as CSSTransition[];
  const properties = running.map((a) => a.transitionProperty).toSorted();
  const durations = running.map((a) => Number(a.effect?.getTiming().duration));
  for (const a of running) {
    a.pause();
    a.currentTime = Number(a.effect?.getTiming().duration ?? 0) / 4;
  }
  const quarter = {
    height: heldHeight(wrapper),
    opacity: Number(getComputedStyle(wrapper).opacity),
    cut: cutAboveEdge(wrapper),
  };
  for (const a of running) a.finish();
  await frame();
  return {
    properties,
    durations,
    quarter,
    settled: { height: heldHeight(wrapper), opacity: Number(getComputedStyle(wrapper).opacity) },
  };
}

/** What `--dur-slow` resolves to here, in milliseconds. */
function durSlow(): number {
  const probe = document.createElement("div");
  probe.style.transitionDuration = "var(--dur-slow)";
  document.body.append(probe);
  const ms = parseFloat(getComputedStyle(probe).transitionDuration) * 1000;
  probe.remove();
  return ms;
}

function expectGrowsOpen(sample: Awaited<ReturnType<typeof sampleOpening>>) {
  expect(sample.properties).toEqual(["grid-template-rows", "opacity"]);
  expect(sample.durations).toEqual([durSlow(), durSlow()]);
  expect(sample.settled.height).toBeGreaterThan(0);
  expect(sample.quarter.height).toBeGreaterThan(0);
  expect(sample.quarter.height).toBeLessThan(sample.settled.height);
  // No empty band under the content while the box grows.
  expect(sample.quarter.cut).toBeCloseTo(0, 0);
  expect(sample.quarter.opacity).toBeGreaterThan(0);
  expect(sample.quarter.opacity).toBeLessThan(1);
  expect(sample.settled.opacity).toBe(1);
}

/** A wrapper that is shut: it holds no height and nothing is in it. */
function expectShut(wrapper: HTMLElement) {
  expect(heldHeight(wrapper)).toBe(0);
  expect(wrapper.textContent).toBe("");
}

function rowsTransitioning(wrapper: HTMLElement): boolean {
  return wrapper
    .getAnimations()
    .some((a) => (a as CSSTransition).transitionProperty === "grid-template-rows");
}

/**
 * Whether every box that clips `el` holds its focus outline whole. The outline
 * is the element's border box grown by its offset and width; a box clips on an
 * axis whose `overflow` is not `visible`, at its padding edge. Vertically only
 * `clip` and `hidden` count: a box that scrolls on that axis shows the ring by
 * scrolling to it.
 */
function ringClippers(el: HTMLElement): string[] {
  const style = getComputedStyle(el);
  expect(style.outlineStyle, "the element draws no focus outline").not.toBe("none");
  expect(parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
  const reach = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
  const box = el.getBoundingClientRect();
  const ring = {
    left: box.left - reach,
    right: box.right + reach,
    top: box.top - reach,
    bottom: box.bottom + reach,
  };
  const cut: string[] = [];
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const s = getComputedStyle(a);
    const r = a.getBoundingClientRect();
    const edge = {
      left: r.left + parseFloat(s.borderLeftWidth),
      right: r.right - parseFloat(s.borderRightWidth),
      top: r.top + parseFloat(s.borderTopWidth),
      bottom: r.bottom - parseFloat(s.borderBottomWidth),
    };
    const name = `${a.tagName.toLowerCase()}.${a.className}`;
    if (s.overflowX !== "visible") {
      if (ring.left < edge.left - 0.5) cut.push(`${name} cuts its left`);
      if (ring.right > edge.right + 0.5) cut.push(`${name} cuts its right`);
    }
    if (s.overflowY === "clip" || s.overflowY === "hidden") {
      if (ring.top < edge.top - 0.5) cut.push(`${name} cuts its top`);
      if (ring.bottom > edge.bottom + 0.5) cut.push(`${name} cuts its bottom`);
    }
  }
  return cut;
}

// ── The dietary picker ────────────────────────────────────────────────────

const event: EventSummary = {
  id: "event-1",
  name: "Mehndi",
  description: "Henna evening",
  startAt: "2026-09-18T16:00:00+10:00",
  endAt: "2026-09-18T22:00:00+10:00",
  timezone: "Australia/Sydney",
  address: "12 Banksia Lane",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
  imageUrl: null,
};

const priya: FamilyMember = {
  guestId: "guest-priya",
  firstName: "Priya",
  lastName: "Sharma",
  nickname: null,
  eventIds: ["event-1"],
};

function mountSheet(existingRsvps?: readonly RsvpSummary[]) {
  render(() => (
    <EventSheet
      panel="rsvp"
      siteUrl="https://invite.test/w"
      event={event}
      members={[priya]}
      existingRsvps={existingRsvps}
      apiUrl="https://api.test"
      onClose={() => {}}
    />
  ));
  return screen.getByRole("group", { name: /priya sharma/i }) as HTMLElement;
}

/** Let the sheet's own entry finish, so only the block under test moves. */
async function settleSheet() {
  await frame();
  const dialog = document.querySelector("dialog") as HTMLElement;
  await Promise.allSettled(dialog.getAnimations({ subtree: true }).map((a) => a.finished));
}

const dietaryGroup = (fieldset: HTMLElement) =>
  within(fieldset).queryByRole("group", { name: /dietary requirements for priya/i });

describe("the dietary picker", () => {
  it("grows open after Attending, and goes at once after Not attending", async () => {
    const fieldset = mountSheet();
    await settleSheet();
    expect(dietaryGroup(fieldset)).toBeNull();

    fireEvent.click(within(fieldset).getByText("Attending"));
    const wrapper = revealOf(dietaryGroup(fieldset)!);
    expectGrowsOpen(await sampleOpening(wrapper));

    fireEvent.click(within(fieldset).getByText("Not attending"));
    await frame();
    expect(dietaryGroup(fieldset)).toBeNull();
    expectShut(wrapper);
  });

  it("is simply open, with nothing moving, for a reply on file", async () => {
    const fieldset = mountSheet([
      {
        guestId: priya.guestId,
        eventId: event.id,
        status: "attending",
        dietary: "",
        dietaryPresets: ["vegetarian"],
        dietaryConsentCurrent: true,
      },
    ]);
    await frame();
    const wrapper = revealOf(dietaryGroup(fieldset)!);
    expect(rowsTransitioning(wrapper)).toBe(false);
    expect(heldHeight(wrapper)).toBeGreaterThan(0);
  });

  it.each([
    ["on a phone, where the pills scroll", PHONE],
    ["from md:, where they wrap", WIDE],
  ] as const)("keeps a focused pill's whole ring %s", async (_, viewport) => {
    await page.viewport(...viewport);
    const fieldset = mountSheet();
    await settleSheet();
    fireEvent.click(within(fieldset).getByText("Attending"));
    await settleSheet();

    // Focus from the keyboard, so the pill draws its `:focus-visible` outline.
    const first = within(dietaryGroup(fieldset)!).getAllByRole("checkbox")[0]!;
    first.focus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}{Tab}");
    expect(document.activeElement).toBe(first);
    expect(ringClippers(first.closest("label")!)).toEqual([]);
  });

  it("keeps the whole ring of the Anything else field", async () => {
    const fieldset = mountSheet();
    await settleSheet();
    fireEvent.click(within(fieldset).getByText("Attending"));
    await settleSheet();
    (within(fieldset).getByText("Other").closest("label") as HTMLElement).click();
    await settleSheet();

    const field = within(fieldset).getByPlaceholderText(/no onion/i) as HTMLInputElement;
    field.focus();
    expect(ringClippers(field)).toEqual([]);
  });
});

// ── The gift page's own amount ────────────────────────────────────────────

describe("the gift page's Another amount field", () => {
  it("grows open when chosen, and goes at once when a set amount is", async () => {
    render(() => (
      <GiftMoneyPanel apiUrl="https://api.test" slug="w" currency="AUD" inviteHref="/w" />
    ));
    expect(document.querySelector("[data-gift-money-amount]")).toBeNull();

    fireEvent.click(screen.getByText("Another amount"));
    const field = document.querySelector("[data-gift-money-amount]")!;
    const wrapper = revealOf(field);
    expectGrowsOpen(await sampleOpening(wrapper));

    const set = screen.getAllByRole("radio")[0]!;
    fireEvent.click(set);
    await frame();
    expect(document.querySelector("[data-gift-money-amount]")).toBeNull();
    expectShut(wrapper);
  });
});

// ── A gift's reserve form ─────────────────────────────────────────────────

const gift: GiftRegistryItem = {
  id: "gi-1",
  kind: "product",
  title: "Copper pan",
  description: "For the kitchen.",
  imageName: null,
  imageCrop: null,
  externalUrl: null,
  priceMinor: null,
  quantityWanted: 2,
  quantityClaimed: 0,
  category: null,
  sortOrder: 0,
};

function mountCard() {
  render(() => (
    <div style={{ width: "320px" }}>
      <GiftRegistryItemCard
        item={gift}
        currency="AUD"
        imageBase={null}
        claim={undefined}
        canClaim={true}
        busy={false}
        onClaim={async () => false}
        onRelease={() => {}}
      />
    </div>
  ));
  return document.querySelector("article") as HTMLElement;
}

describe("a gift's reserve form", () => {
  it("adds nothing to the card while it is shut", async () => {
    const card = mountCard();
    await frame();
    const reserve = screen.getByRole("button", { name: "Reserve" });
    const body = reserve.parentElement!.parentElement!;
    const padding = parseFloat(getComputedStyle(body).paddingBottom);
    const gap =
      body.getBoundingClientRect().bottom - reserve.parentElement!.getBoundingClientRect().bottom;
    expect(card.contains(body)).toBe(true);
    expect(gap).toBeCloseTo(padding, 1);
  });

  it("grows open on Reserve, and Cancel shuts it at once with focus back on Reserve", async () => {
    mountCard();
    fireEvent.click(screen.getByRole("button", { name: "Reserve" }));
    const form = document.querySelector("form")!;
    const wrapper = revealOf(form);
    expectGrowsOpen(await sampleOpening(wrapper));

    const cancel = within(form).getByRole("button", { name: "Cancel" });
    cancel.focus();
    await userEvent.keyboard("{Enter}");
    await frame();
    expect(document.querySelector("form")).toBeNull();
    expectShut(wrapper);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reserve" }));
  });

  it("keeps the whole ring of its first field", async () => {
    mountCard();
    fireEvent.click(screen.getByRole("button", { name: "Reserve" }));
    await frame();
    for (const a of revealOf(document.querySelector("form")!).getAnimations()) a.finish();
    await frame();
    const field = screen.getByRole("spinbutton") as HTMLInputElement;
    field.focus();
    expect(ringClippers(field)).toEqual([]);
  });
});

// ── The household's boxes after "Who are you?" ────────────────────────────

const household: ClaimResult = {
  publicId: "FEATHERSTONEHAUGH-JOY-RK97",
  familyName: "Featherstonehaugh",
  members: [
    { guestId: "g-max", firstName: "Maximiliana", lastName: "F", nickname: null, eventIds: [] },
    { guestId: "g-bo", firstName: "Bo", lastName: "F", nickname: null, eventIds: [] },
  ],
  events: [],
  rsvps: [],
  accountLink: { enabled: true, signedIn: false, linkedGuestIds: [] },
  member: null,
};

function stubMemberApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        String(url).endsWith("/api/claim/member")
          ? Response.json({ member: { guestId: "g-max" }, accountLink: household.accountLink })
          : new Response(null, { status: 204 }),
      ),
    ),
  );
}

const emailBox = () => screen.queryByRole("region", { name: "Wedding emails" });

describe("the household's email and musubi boxes", () => {
  it("grow open as one block once a member is chosen", async () => {
    stubMemberApi();
    const [result, setResult] = createSignal<ClaimResult>(household);
    render(() => (
      <LoginSection
        apiUrl="https://api.test"
        result={result()}
        onClaimed={() => {}}
        onSignOut={() => {}}
        onMemberChange={(update) => setResult(update)}
      />
    ));
    await frame();
    expect(emailBox()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Maximiliana" }));
    const box = await screen.findByRole("region", { name: "Wedding emails" });
    const wrapper = revealOf(box);
    const link = await screen.findByText("Link your musubi account");
    expect(revealOf(link)).toBe(wrapper);
    expectGrowsOpen(await sampleOpening(wrapper));
  });

  it("are simply open, with nothing moving, for a household restored from its session", async () => {
    // The page's restore path: the welcome is hidden until the result lands,
    // and the two arrive together.
    const [result, setResult] = createSignal<ClaimResult | null>(null);
    const [revealed, setRevealed] = createSignal(false);
    render(() => (
      <LoginSection
        apiUrl="https://api.test"
        result={result()}
        revealed={revealed()}
        onClaimed={() => {}}
        onSignOut={() => {}}
        onMemberChange={(update) => setResult((r) => (r ? update(r) : r))}
      />
    ));
    await frame();
    batch(() => {
      setRevealed(true);
      setResult({ ...household, member: { guestId: "g-max" } });
    });
    const box = await screen.findByRole("region", { name: "Wedding emails" });
    await frame();
    const wrapper = revealOf(box);
    expect(rowsTransitioning(wrapper)).toBe(false);
    expect(heldHeight(wrapper)).toBeGreaterThan(0);
  });
});
