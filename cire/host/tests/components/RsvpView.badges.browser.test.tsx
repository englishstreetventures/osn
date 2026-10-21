import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * Each badge in the RSVP table's guest cell carries its explanation twice: as
 * text a screen reader is given and nobody sees, and in a panel a mouse user
 * sees on hover and no screen reader is given. What only a real engine can
 * answer:
 *
 * - that the hidden text is clipped off the screen rather than painted;
 * - that Chrome hands it to assistive technology in the case it was written in —
 *   the badges are `uppercase`, and Chrome passes a `text-transform` into the
 *   text it exposes, so an inherited transform reaches a screen reader as
 *   capitals;
 * - that nothing hands it over a second time, closed or open — a `title` on the
 *   badge, or a panel the badge points at with `aria-describedby`, is exposed as
 *   its description, on top of the text;
 * - that hovering a badge shows the panel, readable and on top, and that the
 *   badge has not become a tab stop on the way.
 *
 * Testing Library and the `page` locators compute names from the DOM in
 * JavaScript, so they cannot see the descriptions or the case. This reads
 * Chrome's own accessibility tree over CDP.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));
// Ada changed her reply since this organiser last looked, so her row is New.
vi.mock("../../src/lib/rsvp-changes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/rsvp-changes")>()),
  fetchRsvpChangeRows: async () => ({ markSeq: 1, rows: [{ guestId: "g1", eventId: null }] }),
  markRsvpChangesSeen: async () => {},
}));

import RsvpView from "../../src/components/RsvpView";

const reply = (guestId: string, firstName: string, extra: Record<string, unknown> = {}) => ({
  guestId,
  firstName,
  lastName: "Test",
  familyName: "Test",
  familyCode: "TEST-CODE-1",
  plusOneOf: null,
  plusOneOfName: null,
  status: "attending",
  dietary: "",
  dietaryPresets: [],
  consentSource: "guest",
  ...extra,
});

/** One reply per badge, so all five render. */
const PAYLOAD = {
  events: [
    {
      id: "evt_1",
      name: "Ceremony",
      invited: 4,
      attending: 4,
      declined: 0,
      maybe: 0,
      responded: 4,
      noResponse: 0,
      guests: [
        reply("g1", "Ada", { submittedBy: { guestId: "g1", firstName: "Ada", viaLink: true } }),
        reply("g2", "Bo", { consentSource: "organiser_attested" }),
        reply("g3", "Cleo", { statusRecordedByHost: true }),
        reply("g4", "Dev", {
          consentSource: "inviter_attested",
          plusOneOf: "g3",
          plusOneOfName: "Cleo Test",
        }),
      ],
      unresponded: [],
    },
  ],
};

/** Each badge's visible word, and the explanation a screen reader gets with it. */
const BADGES = [
  ["New", "Changed by the guest since you last looked"],
  ["linked musubi", "Sent from a signed-in linked musubi account"],
  ["Host-entered", "Recorded by a host (phone/paper RSVP)"],
  [
    "Host-updated",
    "A host last set this status. The dietary requirements are still the ones the guest or their household gave.",
  ],
  [
    "Household-entered",
    "Given by the household that brought them, not by the plus-one. A host may have changed the status since; the dietary requirements are the household's.",
  ],
] as const;

async function renderTable() {
  authFetch.mockResolvedValue(
    new Response(JSON.stringify(PAYLOAD), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  // Desktop width, where a mouse is: it persists across the file, so every test
  // sets it before rendering rather than inheriting whatever ran last.
  await page.viewport(1280, 800);
  render(() => <RsvpView weddingId="wed_1" />);
  // Every visible word, New included: it lands once the change feed has loaded.
  await vi.waitFor(() => {
    for (const [word] of BADGES) expect(screen.getByText(word)).toBeTruthy();
  });
  await document.fonts.ready;
}

interface AXNode {
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  description?: { value: string };
}

interface Frame {
  frame: { id: string; url: string };
  childFrames?: Frame[];
}

/** Chrome's accessibility tree for the frame this test runs in, ignored nodes included. */
async function accessibilityTree(): Promise<AXNode[]> {
  const session = cdp();
  const { frameTree } = (await session.send("Page.getFrameTree")) as { frameTree: Frame };
  const find = (node: Frame): Frame | undefined =>
    node.frame.url === location.href ? node : node.childFrames?.map(find).find(Boolean);
  const own = find(frameTree);
  if (!own) throw new Error(`no frame at ${location.href}`);
  const { nodes } = (await session.send("Accessibility.getFullAXTree", {
    frameId: own.frame.id,
  })) as { nodes: AXNode[] };
  return nodes;
}

/**
 * How often Chrome hands a screen reader the explanation: as text a reader
 * reaches, and as any node's description. Descriptions are counted on ignored
 * nodes too, so a trigger Chrome happens to leave out of the tree cannot hide
 * one.
 */
function handedOver(nodes: AXNode[], explanation: string) {
  const texts = nodes.filter(
    (node) =>
      !node.ignored && node.role?.value === "StaticText" && node.name?.value === explanation,
  );
  const descriptions = nodes.filter((node) => node.description?.value === explanation);
  return [explanation, texts.length, descriptions.length];
}

/** Paint `layers` bottom-up on a 1px canvas and read back plain `rgb`. */
function composite(layers: readonly string[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/** The open panel, if any. It is `aria-hidden`, so a role query skips it. */
const panel = () => document.querySelector<HTMLElement>('[role="tooltip"]');

/**
 * Hover a badge by its visible word and wait for its panel. Past the open
 * delay on a cold hover; at once within the skip window after another panel.
 */
async function hoverBadge(word: string): Promise<HTMLElement> {
  await userEvent.hover(screen.getByText(word));
  const open = await vi.waitFor(
    () => {
      const found = panel();
      if (!found) throw new Error(`no panel after hovering ${word}`);
      return found;
    },
    { timeout: 3000 },
  );
  await Promise.all(open.getAnimations().map((animation) => animation.finished));
  return open;
}

/**
 * Move the pointer onto the event's heading and wait for the panel to go, so
 * no open panel covers the next badge and none is left mounted for the next
 * test.
 */
async function moveAway() {
  await userEvent.hover(screen.getByRole("heading", { name: "Ceremony" }));
  await vi.waitFor(() => expect(panel()).toBeNull(), { timeout: 3000 });
}

afterEach(async () => {
  if (panel()) await moveAway();
  delete document.documentElement.dataset.theme;
  cleanup();
  authFetch.mockReset();
});

describe("the RSVP table's badge explanations", () => {
  it("paints none of them", async () => {
    await renderTable();
    for (const [, explanation] of BADGES) {
      const box = screen.getByText(explanation).getBoundingClientRect();
      expect([explanation, box.width <= 1 && box.height <= 1]).toEqual([explanation, true]);
    }
  });

  it("hands each one to a screen reader once, in the case it was written", async () => {
    await renderTable();
    const nodes = await accessibilityTree();
    for (const [, explanation] of BADGES) {
      expect(handedOver(nodes, explanation)).toEqual([explanation, 1, 0]);
    }
  });

  it.each(["light", "dark"] as const)(
    "shows each one on hover, on top and readable, in the %s theme",
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      await renderTable();
      // Nothing is mounted until a pointer asks for it.
      expect(panel()).toBeNull();
      for (const [word, explanation] of BADGES) {
        const badge = screen.getByText(word);
        // Hover only: a badge in every row must not add a tab stop to it.
        expect([word, badge.closest("td button, td a, td [tabindex]")]).toEqual([word, null]);

        const open = await hoverBadge(word);
        expect([word, open.textContent]).toEqual([word, explanation]);
        const box = open.getBoundingClientRect();
        const inView =
          box.width > 0 &&
          box.height > 0 &&
          box.left >= 0 &&
          box.top >= 0 &&
          box.right <= innerWidth &&
          box.bottom <= innerHeight;
        expect([word, inView]).toEqual([word, true]);
        // Painted on top, not clipped by the table's scroller or covered.
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        expect([word, open.contains(hit)]).toEqual([word, true]);
        // Beside the badge, not over it. A badge that wraps to two lines is the
        // case that slips: an inline trigger's box is its last line only.
        const own = badge.getBoundingClientRect();
        const overlaps =
          box.left < own.right &&
          box.right > own.left &&
          box.top < own.bottom &&
          box.bottom > own.top;
        expect([word, overlaps]).toEqual([word, false]);
        expect([word, getComputedStyle(open).opacity]).toEqual([word, "1"]);
        // Its own ground, opaque: the same paint over white and over black. A
        // panel whose background class emits nothing is transparent over the
        // table, and every check above still passes.
        const { backgroundColor, color } = getComputedStyle(open);
        const ground = composite(["white", backgroundColor]);
        expect([word, ground]).toEqual([word, composite(["black", backgroundColor])]);
        const ratio = contrastRatio(composite([ground, color]), ground)!;
        expect([word, ratio >= WCAG_TEXT_MIN]).toEqual([word, true]);

        await page.screenshot({
          path: `__screenshots__/RsvpView.badges.browser.test.tsx/hover-${theme}-${word.toLowerCase().replace(/\W+/g, "-")}.png`,
        });
        await moveAway();
      }
    },
  );

  it("hands each one over once while its panel is open", async () => {
    await renderTable();
    for (const [word, explanation] of BADGES) {
      await hoverBadge(word);
      const nodes = await accessibilityTree();
      const panels = nodes.filter((node) => !node.ignored && node.role?.value === "tooltip");
      expect([word, panels.length]).toEqual([word, 0]);
      expect(handedOver(nodes, explanation)).toEqual([explanation, 1, 0]);
      await moveAway();
    }
  });
});
