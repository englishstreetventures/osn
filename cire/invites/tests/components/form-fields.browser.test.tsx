import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";
import { EventSheet } from "../../src/components/EventSheet";
import { GiftMoneyPanel } from "../../src/components/gift-registry/GiftMoneyPanel";
import { GiftRegistryItemCard } from "../../src/components/gift-registry/GiftRegistryItemCard";
import { GuestEmailBox } from "../../src/components/GuestEmailBox";
import { LoginSection } from "../../src/components/LoginSection";
import type { ClaimResult, EventSummary, FamilyMember } from "../../src/components/types";

/**
 * Every text field a guest types in, measured in a real engine: the code field,
 * the email box, a plus-one's names, the RSVP sheet's "Anything else" and the
 * gift page's amount, name, quantity and "From". Each is the cire apps' one
 * form-field height — `h-8.5`, 2.125rem, which is 34px at this site's 16px root
 * and 36.125px at the 17px root it takes from 1024px — with the 14px field
 * corner, short of a pill (cire/host/DESIGN.md §4, "One form-field height";
 * wiki cire-invite-designs §Corners, labels and motion).
 *
 * happy-dom lays nothing out and computes no `var()`, so only a browser can say
 * how tall a field is and what corner it paints.
 */

vi.mock("@shared/rp-auth/solid", () => ({
  AuthProvider: (props: { children: unknown }) => props.children,
  useAuth: () => ({ session: () => null, authFetch: fetch, signIn: () => {} }),
}));

const VIEWPORTS = [
  { name: "390", width: 390, height: 900 },
  { name: "1440", width: 1440, height: 900 },
] as const;

const priya: FamilyMember = {
  guestId: "g-priya",
  firstName: "Priya",
  lastName: "Sharma",
  nickname: null,
  eventIds: ["event-1"],
  plusOneAllowed: true,
  plusOneOf: null,
};

const household: ClaimResult = {
  publicId: "SHARMA-JOY-RK97",
  familyName: "Sharma",
  members: [priya],
  events: [],
  rsvps: [],
};

const event: EventSummary = {
  id: "event-1",
  name: "Mehndi",
  description: null,
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

/** 2.125rem at the page's root size. */
function fieldHeight(): number {
  return 2.125 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
}

/** Each field that is not the form-field shape, as measured; `[]` when all are. */
function misfits(fields: Record<string, Element>) {
  const want = fieldHeight();
  const off: object[] = [];
  for (const [name, el] of Object.entries(fields)) {
    const height = Math.round(el.getBoundingClientRect().height * 1000) / 1000;
    const corner = getComputedStyle(el).borderTopLeftRadius;
    const pill = Number.parseFloat(corner) >= height / 2;
    if (Math.abs(height - want) > 0.01 || corner !== "14px" || pill) {
      off.push({ name, height, want, corner, pill });
    }
  }
  return off;
}

/** Waits out a sheet's opening motion, so its fields are measured at rest. */
async function settle() {
  await new Promise(requestAnimationFrame);
  await Promise.allSettled(document.getAnimations().map((a) => a.finished));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the guest site's form fields", () => {
  for (const viewport of VIEWPORTS) {
    it(`are one height with the field corner, ${viewport.name}px`, async () => {
      await page.viewport(viewport.width, viewport.height);
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))),
      );

      // The claim panel before a code: its one field.
      render(() => <LoginSection apiUrl="https://api.test" result={null} onClaimed={() => {}} />);
      const code = await screen.findByRole("textbox", { name: "Invitation code" });
      expect(misfits({ code })).toEqual([]);
      cleanup();

      // A claimed household that may bring a guest: the plus-one's names.
      render(() => (
        <LoginSection
          apiUrl="https://api.test"
          result={household}
          onClaimed={() => {}}
          onPlusOneChange={() => {}}
        />
      ));
      const first = await screen.findByLabelText("First name", {}, { timeout: 3000 });
      expect(
        misfits({ "plus-one first": first, "plus-one last": screen.getByLabelText("Last name") }),
      ).toEqual([]);
      cleanup();

      // The member's own address.
      render(() => (
        <GuestEmailBox
          apiUrl="https://api.test"
          member={priya}
          email={null}
          onChange={() => {}}
          onMemberRequired={() => {}}
        />
      ));
      expect(misfits({ email: screen.getByLabelText("Your email, Priya") })).toEqual([]);
      cleanup();

      // The RSVP sheet's free text, behind Attending and Other.
      render(() => (
        <EventSheet
          panel="rsvp"
          siteUrl="https://invite.test/w"
          event={event}
          members={[priya]}
          apiUrl="https://api.test"
          onClose={() => {}}
        />
      ));
      const fieldset = screen.getByRole("group", { name: /priya sharma/i });
      fireEvent.click(within(fieldset).getByText("Attending"));
      (within(fieldset).getByText("Other").closest("label") as HTMLElement).click();
      const other = await within(fieldset).findByRole("textbox", { name: /anything else/i });
      await settle();
      expect(misfits({ "anything else": other })).toEqual([]);
      cleanup();

      // The gift page: a sum of the guest's own, and their name.
      render(() => (
        <GiftMoneyPanel
          apiUrl="https://api.test"
          slug="anita-and-ben"
          currency="AUD"
          inviteHref="/cire/invite?slug=anita-and-ben"
        />
      ));
      fireEvent.click(screen.getByLabelText(/another amount/i));
      const amount = await screen.findByLabelText(/^Amount/);
      expect(
        misfits({ amount, "your name": screen.getByLabelText("Your name (optional)") }),
      ).toEqual([]);
      cleanup();

      // A gift to reserve: how many, and who from.
      render(() => (
        <GiftRegistryItemCard
          item={{
            id: "gi-1",
            kind: "product",
            title: "Copper pan",
            description: null,
            imageName: null,
            imageCrop: null,
            externalUrl: null,
            priceMinor: null,
            quantityWanted: 4,
            quantityClaimed: 0,
            category: null,
            sortOrder: 0,
          }}
          currency="AUD"
          imageBase={null}
          claim={undefined}
          canClaim
          busy={false}
          onClaim={async () => false}
          onRelease={() => {}}
        />
      ));
      fireEvent.click(screen.getByRole("button", { name: "Reserve" }));
      const quantity = await screen.findByRole("spinbutton", { name: /how many/i });
      expect(
        misfits({ "how many": quantity, from: screen.getByRole("textbox", { name: /from/i }) }),
      ).toEqual([]);
    });
  }
});
