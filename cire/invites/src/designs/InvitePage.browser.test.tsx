import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

import "../styles/global.css";
import { afterEach, describe, expect, it, vi } from "vitest";

import { noteClaimed } from "../components/claim-session";
import { SWEEP_DURATION_MS, TOTAL_DURATION_MS } from "../components/rsvp-responded";
import { SAVED_DWELL_MS } from "../components/rsvp-saved";
import type { ClaimResult } from "../components/types";
import { Z_LAYER } from "../lib/z-index";
import { noSession, withSession } from "../test-support/claim-fetch";
import classicInvitePage from "./classic/InvitePage";
import galaInvitePage from "./gala/InvitePage";

/**
 * The whole invite page, in a real browser, with a real RSVP save measured on
 * the Respond button afterwards.
 *
 * `InvitePage.test.tsx` mocks `RsvpModal`, `motion`, `UnlockReveal.motion`,
 * `@shared/toast` and `PulseAccountLink` — necessarily, to assert the page's
 * wiring in isolation. That leaves nothing anywhere in the suite that exercises
 * the confirmation inside the page it actually ships in: the themed events
 * `<section>`, the Motion-One-animated `[data-event-card]` wrappers each with a
 * leftover inline `transform`, and the modal overlay that unmounts on top of it
 * all.
 *
 * Only `PulseAccountLink` and the OSN `AuthProvider` are stubbed here — they
 * reach the account API and have their own tests. Everything the confirmation
 * and the toast touch is the real thing.
 */

vi.mock("../components/PulseAccountLink", () => ({
  PulseAccountLink: () => <div data-testid="pulse-account-link-stub" />,
}));

vi.mock("@shared/rp-auth/solid", () => ({
  AuthProvider: (props: { children: unknown }) => props.children,
}));

/** Two members on one event, so a partial save is possible. */
const claim: ClaimResult = {
  publicId: "SHARMA-JOY-RK97",
  familyName: "Sharma",
  members: [
    { guestId: "guest-priya", firstName: "Priya", lastName: "Sharma", eventIds: ["event-1"] },
    { guestId: "guest-raj", firstName: "Raj", lastName: "Sharma", eventIds: ["event-1"] },
  ],
  events: [
    {
      id: "event-1",
      name: "Mehndi",
      description: "Henna evening",
      startAt: "2026-09-18T16:00:00+10:00",
      endAt: "2026-09-18T22:00:00+10:00",
      timezone: "Australia/Sydney",
      address: "Sharma Residence",
      dressCodeDescription: null,
      dressCodePalette: null,
      pinterestUrl: null,
      mapsUrl: null,
      sortOrder: 0,
      imageUrl: null,
    },
  ],
  rsvps: [],
};

const row = (guestId: string) => ({
  guestId,
  eventId: "event-1",
  status: "attending" as const,
  dietary: "",
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function respondButton(): HTMLButtonElement {
  const card = [...document.querySelectorAll("[data-event-card]")].find((el) =>
    el.textContent?.includes("Mehndi"),
  ) as HTMLElement;
  return [...card.querySelectorAll("button")].find(
    (b) => b.textContent === "Respond",
  ) as HTMLButtonElement;
}

function fill(): HTMLElement {
  return respondButton().querySelector("span[aria-hidden='true']") as HTMLElement;
}

function scaleX(el: HTMLElement): number {
  const raw = getComputedStyle(el).scale;
  if (raw === "none") return 1;
  return Number.parseFloat(raw.split(" ")[0]!);
}

function fieldsetFor(name: string): HTMLElement {
  for (const l of document.querySelectorAll("legend")) {
    if ((l.textContent ?? "").includes(name)) return l.closest("fieldset") as HTMLElement;
  }
  throw new Error(`fieldset for ${name} not found`);
}

function answer(name: string) {
  const buttons = [...fieldsetFor(name).querySelectorAll("button")];
  (buttons.find((b) => b.textContent === "Attending") as HTMLButtonElement).click();
}

/**
 * The sheet's Save button, scoped to the dialog. NOT `document.querySelector(
 * "button[type=submit]")` — the login form stays in the layout after the invite
 * opens (only `display: none`), and its "Open Invitation" submit comes first in
 * the DOM, so an unscoped query silently clicks that instead and the RSVP is
 * never sent.
 */
function save() {
  (document.querySelector('[role="dialog"] button[type="submit"]') as HTMLButtonElement).click();
}

/**
 * The toast element carrying a given message, plus the `position: fixed`
 * container `@shared/toast` mounts it in.
 */
function toastFor(message: string) {
  const el = [...document.querySelectorAll("div")].find((d) => d.textContent === message);
  if (!el) return null;
  let container: HTMLElement | null = el;
  while (container && getComputedStyle(container).position !== "fixed") {
    container = container.parentElement;
  }
  return { el, container };
}

/**
 * The colour an element is actually painted ON, compositing every translucent
 * background between it and the root on a 1x1 canvas.
 *
 * Composited rather than read off one node: the palette's own `--toast-border`
 * is an alpha colour, Tailwind's `/12`-style modifiers compute to `color-mix`
 * results Chrome serialises as `oklab(… / .12)`, and a ratio measured against
 * an uncomposited colour is a ratio for a colour nobody sees. The canvas parses
 * whatever `getComputedStyle` returns, which is the point — no colour parser
 * here has to keep up with CSS Color 4.
 */
function paintedBackdrop(element: Element): string {
  const layers: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") layers.push(bg);
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers.toReversed()) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/** The ink an element is painted IN, composited over its own backdrop. */
function paintedInk(element: Element): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = paintedBackdrop(element);
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = getComputedStyle(element).color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * The nearest ancestor that would become the containing block for a
 * `position: fixed` descendant — a `transform`, `filter`, `perspective`,
 * `contain` or `will-change` on any ancestor does it, and it makes that
 * ancestor a stacking context too. This is the exact mechanism that broke the
 * toast: `<Toaster>` used to live inside the events section, which Motion One
 * leaves with an inline `transform`, so the toast was positioned against the
 * section and stacked inside it — below the page-level `z-100` modal, whatever
 * `z-index` the toast itself carried.
 *
 * Not asserted with `elementFromPoint`: the toast container is deliberately
 * `pointer-events: none`, so hit-testing sees straight through it to whatever
 * is behind and would report a "covered" toast that is painted perfectly well.
 */
function fixedContainingBlockAncestor(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (
      cs.transform !== "none" ||
      cs.filter !== "none" ||
      cs.perspective !== "none" ||
      cs.willChange.includes("transform") ||
      cs.contain.includes("paint") ||
      cs.contain.includes("layout")
    ) {
      return p;
    }
  }
  return null;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `vi.waitFor` options for the settled confirmation. The default 1000ms is too
 * short on purpose-built grounds: the sweep does not START until the sheet's
 * dwell has elapsed and then runs for `SWEEP_DURATION_MS` (500ms). The dwell is
 * a budget measured from the click (`savedDwellMs`), so `SAVED_DWELL_MS` is its
 * ceiling and this timeout stays an upper bound however fast the stubbed reply
 * lands. The generous ceiling costs nothing when the assertion passes —
 * `waitFor` returns as soon as it does — and the state it waits for is
 * permanent, so it can never overshoot.
 */
const SETTLED = { timeout: SAVED_DWELL_MS + SWEEP_DURATION_MS + 3000, interval: 50 };
/**
 * A returning guest: the session restores, so the invite opens with no unlock
 * choreography to wait through. Two preconditions `createSessionRestore`
 * enforces and it is easy to miss — the `cire_claimed` cookie hint
 * (`noteClaimed()`), and a `slug`, without which it skips the request entirely.
 */
function openRestored(Pack: typeof classicInvitePage, rsvpResponses: Response[]) {
  noteClaimed();
  let call = 0;
  const inner = ((input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    // The theme revalidation. An empty body keeps the build-time theme.
    if (url.includes("/api/invite/")) return Promise.resolve(json({}));
    if (url.includes("/api/rsvp")) {
      return Promise.resolve(rsvpResponses[call++] ?? json({ rsvps: [] }));
    }
    return Promise.resolve(json({}, 404));
  }) as typeof fetch;
  vi.stubGlobal("fetch", withSession(claim, inner));
  return render(() => <Pack apiUrl="https://api.test" slug="cire-wedding" />);
}

/**
 * A FIRST-time guest, typing their code. Unlike {@link openRestored} this runs
 * the real `unlockRevealSequence`, which is the difference that matters: Motion
 * One animates the events `<section>` and every `[data-event-card]` and leaves
 * the final inline `transform` behind. A transformed ancestor becomes the
 * containing block for `position: fixed` descendants and creates a stacking
 * context — so anything fixed that lives inside that section (the `<Toaster>`
 * does) stops being positioned against the viewport.
 */
async function openByCode(Pack: typeof classicInvitePage, rsvpResponses: Response[]) {
  let call = 0;
  const inner = ((input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/api/invite/")) return Promise.resolve(json({}));
    if (url.includes("/api/rsvp")) {
      return Promise.resolve(rsvpResponses[call++] ?? json({ rsvps: [] }));
    }
    if (url.includes("/api/claim")) return Promise.resolve(json(claim));
    return Promise.resolve(json({}, 404));
  }) as typeof fetch;
  // No `cire_claimed` hint and no session: the code form is the way in.
  vi.stubGlobal("fetch", noSession(inner));
  const view = render(() => <Pack apiUrl="https://api.test" slug="cire-wedding" />);

  const input = view.getByPlaceholderText(/PATEL-JOY/) as HTMLInputElement;
  fireEvent.input(input, { target: { value: "SHARMA-JOY-RK97" } });
  (
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Open Invitation",
    ) as HTMLButtonElement
  ).click();

  // The reveal choreography is ~1.2s of staggered animation before the cards
  // are settled and clickable.
  await waitFor(() => expect(respondButton()).toBeTruthy(), { timeout: 5000 });
  await wait(1500);
  return view;
}

/**
 * Run every case against BOTH design packs.
 *
 * The confirmation itself lives in `EventCard` and is pack-independent, so
 * duplicating these into a second file would be waste. What is NOT
 * pack-independent is the tree the toast assertions walk: gala nests its cards
 * two wrappers deeper than classic and its reveal (`gala/UnlockReveal.motion.ts`)
 * leaves inline transforms on different nodes at different times. Since the
 * containing-block trap is invisible to happy-dom by construction, a gala-only
 * wrapper that ever gains a `filter` or `will-change: transform` would put the
 * toast back behind the sheet with the fast tier still green — on the pack with
 * no measurement. `describe.each` buys the pack-specific half without
 * duplicating the pack-independent half.
 */
describe.each([
  ["classic", classicInvitePage],
  ["gala", galaInvitePage],
])("InvitePage (%s) — the RSVP confirmation in the page it ships in", (_name, Pack) => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps the Respond fill painted after a complete save", async () => {
    openRestored(Pack, [json({ rsvps: [row("guest-priya"), row("guest-raj")] })]);
    await waitFor(() => expect(respondButton()).toBeTruthy(), { timeout: 3000 });

    expect(scaleX(fill())).toBe(0);

    respondButton().click();
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeTruthy());
    answer("Priya");
    answer("Raj");
    save();

    // `waitFor`, not a fixed sleep: the end state is permanent, so waiting
    // LONGER can never overshoot it, while a sleep sized to
    // `SAVED_DWELL_MS + SWEEP_DURATION_MS` has only its slack to absorb one long
    // task and otherwise reads the sweep mid-travel.
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(scaleX(fill())).toBe(1);
    }, SETTLED);

    // The complaint, stated as an assertion: still filled seconds later.
    // +2000 is well past `TOTAL_DURATION_MS`; these are real sleeps, so the
    // margin is sized to the assertion rather than to rhetoric.
    await wait(TOTAL_DURATION_MS + 2000);
    expect(scaleX(fill())).toBe(1);
    expect(respondButton().querySelector("svg")).not.toBeNull();
  });

  /**
   * The whole reason the toast reads its colours from `--toast-*` rather than
   * re-using the page's `--color-error` / `--color-success`.
   *
   * Those two are walked against `--color-surface`; a toast paints on
   * `--color-surface-raised`, derived as `card ± 0.05` lightness and outside
   * that walk. On the built-in `jewel` preset the page's success green measures
   * 4.29:1 on the raised surface — under the 4.5 text minimum. `derivePalette`
   * emits a toast pair walked against the surface the toast is really on, and
   * this measures the composited result rather than trusting the token.
   *
   * Only a real browser can answer this: jsdom parses no stylesheet, so every
   * `getComputedStyle` here would return the empty string.
   */
  it("paints the toast legibly on the surface it actually sits on", async () => {
    openRestored(Pack, [json({ rsvps: [row("guest-priya")] })]);
    await waitFor(() => expect(respondButton()).toBeTruthy(), { timeout: 3000 });

    respondButton().click();
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeTruthy());
    answer("Priya");
    save();

    const { el } = await vi.waitFor(() => {
      const found = toastFor("Your RSVP for Mehndi has been recorded.");
      expect(found, "no toast element in the DOM at all").toBeTruthy();
      expect(found!.el.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
      return found!;
    }, SETTLED);

    const toast = el.closest(".osn-toast") as HTMLElement;
    expect(toast, "the message is not inside a toast element").toBeTruthy();

    // The message itself, on whatever the toast composites to.
    expect(
      contrastRatio(paintedInk(el), paintedBackdrop(el)),
      "the toast message is illegible on its own surface",
    ).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);

    // And the tone glyph, which is the half that carries the organiser's
    // semantic colour and the half the page tokens got wrong.
    const glyph = toast.querySelector(".osn-toast__glyph")!;
    expect(
      contrastRatio(paintedInk(glyph), paintedBackdrop(glyph)),
      "the tone glyph is illegible on the toast surface",
    ).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
  });

  it("shows the save toast where a guest can actually see it", async () => {
    openRestored(Pack, [json({ rsvps: [row("guest-priya")] })]);
    await waitFor(() => expect(respondButton()).toBeTruthy(), { timeout: 3000 });

    respondButton().click();
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeTruthy());
    answer("Priya");
    save();

    // A ceiling, so anchor it to the state that opens the window rather than to
    // the clock: the toast fires the moment the save lands, and the sheet's
    // label flipping to "Saved" is that same moment. `waitFor` on the toast's
    // geometry then absorbs the toast's enter animation without assuming a
    // duration for it.
    await vi.waitFor(() => {
      const submit = document.querySelector('[role="dialog"] button[type="submit"]');
      // Null once the dwell has already closed the sheet — which also means the
      // save landed, so it satisfies this wait exactly as well as the label
      // does. Reading `.textContent` off null instead throws inside the
      // predicate, and a predicate that can never again succeed retries to the
      // deadline and fails hard rather than degrading (T-E1). The window that
      // has to contain the first poll shrank with the dwell, and this
      // assertion is a clock ANCHOR for the toast checks below, not a claim
      // about how long the sheet stays up.
      expect(submit === null || submit.textContent!.includes("Saved")).toBe(true);
    });
    const { el, container } = await vi.waitFor(() => {
      const found = toastFor("Your RSVP for Mehndi has been recorded.");
      expect(found, "no toast element in the DOM at all").toBeTruthy();
      // Settled into the viewport, not still animating in from above it.
      expect(found!.el.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
      return found!;
    });

    // The mechanism, first: nothing between the toast and <body> may establish a
    // containing block, or it is positioned against that ancestor and stacked
    // inside it — below the sheet, whatever z-index it carries.
    expect(
      fixedContainingBlockAncestor(container!),
      "the toast is trapped inside a transformed ancestor's stacking context",
    ).toBeNull();
    // Two-sided on purpose. `> MODAL` alone is satisfied by any "just make it
    // big" z-index — the previous library hardcoded 9999 — so a one-sided
    // assertion passes while the toast sits ABOVE the consent banner and
    // dialog, the one thing that must never be buried.
    const painted = Number.parseInt(getComputedStyle(container!).zIndex, 10);
    expect(painted, "the toast stacks below the RSVP sheet").toBeGreaterThan(Z_LAYER.MODAL);
    expect(painted, "the toast stacks above the consent layers").toBeLessThan(Z_LAYER.CONSENT);

    // Painted, on screen, and anchored where `top-center` says.
    const rect = el.getBoundingClientRect();
    expect(rect.width, "toast has no box").toBeGreaterThan(0);
    expect(rect.top, "toast is off the top of the viewport").toBeGreaterThanOrEqual(0);
    expect(rect.bottom, "toast is below the fold").toBeLessThanOrEqual(window.innerHeight);
    expect(rect.top, "toast is not anchored to the viewport top").toBeLessThan(200);
  });

  it("keeps the fill painted on the first-visit path, after the reveal has run", async () => {
    await openByCode(Pack, [json({ rsvps: [row("guest-priya"), row("guest-raj")] })]);

    respondButton().click();
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeTruthy());
    answer("Priya");
    answer("Raj");
    save();

    await vi.waitFor(() => expect(scaleX(fill())).toBe(1), SETTLED);
    await wait(TOTAL_DURATION_MS + 2000);
    expect(scaleX(fill())).toBe(1);
  });

  it("shows the save toast on the first-visit path too", async () => {
    // The path the restored test cannot cover: `unlockRevealSequence` has run,
    // so the events section carries Motion One's inline transform and anything
    // fixed inside it is no longer positioned against the viewport.
    await openByCode(Pack, [json({ rsvps: [row("guest-priya")] })]);

    respondButton().click();
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeTruthy());
    answer("Priya");
    save();
    await vi.waitFor(() => {
      const submit = document.querySelector('[role="dialog"] button[type="submit"]');
      // Null once the dwell has already closed the sheet — which also means the
      // save landed, so it satisfies this wait exactly as well as the label
      // does. Reading `.textContent` off null instead throws inside the
      // predicate, and a predicate that can never again succeed retries to the
      // deadline and fails hard rather than degrading (T-E1). The window that
      // has to contain the first poll shrank with the dwell, and this
      // assertion is a clock ANCHOR for the toast checks below, not a claim
      // about how long the sheet stays up.
      expect(submit === null || submit.textContent!.includes("Saved")).toBe(true);
    });

    const { el, container } = await vi.waitFor(() => {
      const found = toastFor("Your RSVP for Mehndi has been recorded.");
      expect(found, "no toast element in the DOM at all").toBeTruthy();
      // Settled into the viewport, not still animating in from above it.
      expect(found!.el.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
      return found!;
    });

    // The mechanism, first: nothing between the toast and <body> may establish a
    // containing block, or it is positioned against that ancestor and stacked
    // inside it — below the sheet, whatever z-index it carries.
    expect(
      fixedContainingBlockAncestor(container!),
      "the toast is trapped inside a transformed ancestor's stacking context",
    ).toBeNull();
    // Two-sided on purpose. `> MODAL` alone is satisfied by any "just make it
    // big" z-index — the previous library hardcoded 9999 — so a one-sided
    // assertion passes while the toast sits ABOVE the consent banner and
    // dialog, the one thing that must never be buried.
    const painted = Number.parseInt(getComputedStyle(container!).zIndex, 10);
    expect(painted, "the toast stacks below the RSVP sheet").toBeGreaterThan(Z_LAYER.MODAL);
    expect(painted, "the toast stacks above the consent layers").toBeLessThan(Z_LAYER.CONSENT);

    // Painted, on screen, and anchored where `top-center` says.
    const rect = el.getBoundingClientRect();
    expect(rect.width, "toast has no box").toBeGreaterThan(0);
    expect(rect.top, "toast is off the top of the viewport").toBeGreaterThanOrEqual(0);
    expect(rect.bottom, "toast is below the fold").toBeLessThanOrEqual(window.innerHeight);
    expect(rect.top, "toast is not anchored to the viewport top").toBeLessThan(200);
  });
  it("T-U1: the code form comes back PAINTED after sign-out", async () => {
    // The unit tier mocks `UnlockReveal.motion` and `motion` away, so it asserts
    // the form is back in the layout and never that it is visible. The real
    // sequence fades the form out with Motion, which leaves its end state as
    // inline styles on the wrapper (`opacity: 0`, plus a `translateY`). Solid's
    // binding there owns only `display`, so without an explicit clear the form
    // returns fully transparent — a blank panel, and the guest's only way out is
    // a reload, which (the session cookie being untouched) re-opens the invite
    // they were trying to leave.
    await openByCode(Pack, []);

    const button = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Sign out"),
    ) as HTMLButtonElement;
    expect(button, "the sign-out control is not rendered").toBeTruthy();
    // The copy names the household it ends, so it cannot read as a generic
    // "start over" — this fixture has two members, so it is the family name.
    expect(button.textContent).toBe("Not Sharma? Sign out");
    button.click();

    const input = document.querySelector("input[aria-label='Invitation code']") as HTMLInputElement;
    await waitFor(() => expect(input.checkVisibility()).toBe(true), { timeout: 3000 });

    // `checkVisibility` with both flags is the honest question: `display` alone
    // was never the failure — opacity was.
    expect(
      input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      "the restored code form is in the layout but not painted",
    ).toBe(true);

    // And the residue is actually gone from the wrapper, not merely overridden
    // somewhere down the tree.
    const wrapper = input.closest("form")?.parentElement as HTMLElement;
    expect(Number.parseFloat(getComputedStyle(wrapper).opacity)).toBe(1);

    // Usable, not just visible — the S-M1 pair to this, measured in a real
    // browser rather than jsdom.
    expect(input.disabled).toBe(false);
    const rect = input.getBoundingClientRect();
    expect(rect.width, "the code field has no box").toBeGreaterThan(0);
  });
});
