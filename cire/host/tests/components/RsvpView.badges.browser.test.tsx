import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * Each badge in the RSVP table's guest cell carries its explanation as text a
 * screen reader is given and nobody sees. Three things about that only a real
 * engine can answer:
 *
 * - that the text is clipped off the screen rather than painted into the badge;
 * - that Chrome hands it to assistive technology in the case it was written in —
 *   the badge is `uppercase`, and Chrome passes a `text-transform` into the
 *   text it exposes, so an inherited transform reaches a screen reader as
 *   capitals;
 * - that nothing hands it over a second time — a `title` on the badge is
 *   exposed as its description, on top of the text.
 *
 * Testing Library and the `page` locators compute names from the DOM in
 * JavaScript, so they cannot see the last two. This reads Chrome's own
 * accessibility tree over CDP.
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

/** Chrome's accessibility tree for the frame this test runs in. */
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
  return nodes.filter((node) => !node.ignored);
}

afterEach(() => {
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
      const texts = nodes.filter(
        (node) => node.role?.value === "StaticText" && node.name?.value === explanation,
      );
      const descriptions = nodes.filter((node) => node.description?.value === explanation);
      expect([explanation, texts.length, descriptions.length]).toEqual([explanation, 1, 0]);
    }
  });
});
