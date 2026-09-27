import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";
import { LoginSection, type LoginSectionLayout } from "../../src/components/LoginSection";
import type { ClaimResult, FamilyMember } from "../../src/components/types";

/**
 * The plus-one prompt inside the claim and welcome panel, measured in a real
 * browser at phone width. The panel layout is a 400px card inside the page
 * gutter, so on a 375px phone the prompt gets well under 300px; the house
 * button never wraps its label, and a name is typed by a guest, so either can
 * push past the card. jsdom lays nothing out, so only this tier can see it.
 */
vi.mock("@shared/rp-auth/solid", () => ({
  AuthProvider: (props: { children: unknown }) => props.children,
  useAuth: () => ({ session: () => null, authFetch: fetch, signIn: () => {} }),
}));

const LONG = "Maximilianafeatherstonehaughwhittingstall";

const inviter: FamilyMember = {
  guestId: "g-max",
  firstName: "Maximiliana",
  lastName: "Featherstonehaugh",
  nickname: null,
  eventIds: ["e1"],
  plusOneAllowed: true,
  plusOneOf: null,
};

function household(members: FamilyMember[]): ClaimResult {
  return {
    publicId: "FEATHER-JOY-RK97",
    familyName: "Featherstonehaugh",
    members,
    events: [],
    rsvps: [],
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The frame the prompt must stay inside: the card in the panel layout, the
 *  page-wide band otherwise. */
function frame(): DOMRect {
  const el = [...document.querySelectorAll<HTMLElement>("[style]")].find(
    (e) => e.style.getPropertyValue("background-color") === "var(--invite-section-bg)",
  )!;
  return el.getBoundingClientRect();
}

function expectInside(section: HTMLElement) {
  const outer = frame();
  const box = section.getBoundingClientRect();
  expect(box.width, "the prompt has no box").toBeGreaterThan(0);
  expect(box.left).toBeGreaterThanOrEqual(outer.left);
  expect(box.right).toBeLessThanOrEqual(outer.right);
  // A box keeps its width while its text spills out of it, so each is checked
  // for overflow of its own as well as for where it sits.
  expect(section.scrollWidth, "the prompt's content spills sideways").toBeLessThanOrEqual(
    section.clientWidth,
  );
  for (const el of section.querySelectorAll<HTMLElement>("button, input, p, label, a")) {
    const label = `"${el.textContent ?? el.getAttribute("aria-label")}"`;
    expect(el.getBoundingClientRect().right, `${label} runs past the prompt`).toBeLessThanOrEqual(
      box.right + 0.5,
    );
    expect(el.scrollWidth, `${label} overflows its own box`).toBeLessThanOrEqual(
      el.clientWidth + 1,
    );
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

describe.each<LoginSectionLayout>(["band", "panel"])(
  "LoginSection (%s) — the plus-one prompt at phone width",
  (layout) => {
    it("keeps the name form inside the panel", async () => {
      await page.viewport(375, 900);
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))),
      );
      const view = render(() => (
        <LoginSection
          apiUrl="https://api.test"
          result={household([inviter])}
          onClaimed={() => {}}
          onPlusOneChange={() => {}}
          layout={layout}
        />
      ));
      const heading = await view.findByText("Bringing a guest", {}, { timeout: 3000 });
      const section = heading.closest("section") as HTMLElement;
      // Vacuity guard: the form is drawn.
      expect(view.getByLabelText("First name")).toBeTruthy();
      expect(view.getByText("Add guest")).toBeTruthy();
      expectInside(section);
    });

    it("keeps a long name and the removal question inside the panel", async () => {
      await page.viewport(375, 900);
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))),
      );
      const guest: FamilyMember = {
        guestId: "g-guest",
        firstName: LONG,
        lastName: LONG,
        nickname: null,
        eventIds: ["e1"],
        plusOneAllowed: false,
        plusOneOf: "g-max",
      };
      const view = render(() => (
        <LoginSection
          apiUrl="https://api.test"
          result={household([inviter, guest])}
          onClaimed={() => {}}
          onPlusOneChange={() => {}}
          layout={layout}
        />
      ));
      const heading = await view.findByText("Bringing a guest", {}, { timeout: 3000 });
      const section = heading.closest("section") as HTMLElement;
      expect(section.textContent).toContain(LONG);
      expectInside(section);

      fireEvent.click(view.getByText("Remove"));
      expect(view.getByText("Yes, remove")).toBeTruthy();
      expectInside(section);
    });

    // The name fields sit on whatever surface the organiser picked, like the
    // code field above them, and take their edge from the same ink — the one
    // measured to clear 3:1 on every palette.
    it("draws the name fields' edge from the code field's ink", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))),
      );
      const view = render(() => (
        <LoginSection
          apiUrl="https://api.test"
          result={household([inviter])}
          onClaimed={() => {}}
          onPlusOneChange={() => {}}
          layout={layout}
        />
      ));
      const first = (await view.findByLabelText(
        "First name",
        {},
        { timeout: 3000 },
      )) as HTMLElement;
      const code = view.getByLabelText("Invitation code");
      const colour = getComputedStyle(first).borderTopColor;
      expect(colour).not.toBe("");
      expect(colour).toBe(getComputedStyle(code).borderTopColor);
    });
  },
);
