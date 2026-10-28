import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The portal's corners, read from a real engine on the RSVP page: a text field
 * is the 14px `field` corner, and an action button is a pill.
 *
 * Both come from the host stylesheet's role map (`--ui-radius-field`,
 * `--ui-radius-control`), which no unit test resolves: happy-dom computes no
 * `var()`, so only a browser can say that `rounded-ui-field` on the search box
 * paints 14px rather than falling back to the control's pill.
 *
 * Each case leaves two screenshots under `__screenshots__/` beside this file
 * (gitignored), at a phone's width and a laptop's, light and dark: the bar
 * with the search box it measures, and the reply editor open.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));
vi.mock("../../src/lib/rsvp-changes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/rsvp-changes")>()),
  fetchRsvpChangeRows: async () => null,
  markRsvpChangesSeen: async () => {},
}));

import RsvpView from "../../src/components/RsvpView";
import { eventPayload, guestList } from "../test-support/rsvp-guests";

const PAYLOAD = { events: [eventPayload("evt_ceremony", "Ceremony", guestList(12), 0)] };

const VIEWPORTS = [
  { name: "390", width: 390, height: 1100, compact: true },
  { name: "1280", width: 1280, height: 900, compact: false },
] as const;
const THEMES = ["light", "dark"] as const;

/** Beside this file, in the gitignored `__screenshots__/`. */
const shot = (name: string) => `__screenshots__/soft-shapes.browser.test.tsx/${name}.png`;

const corner = (el: Element) => getComputedStyle(el).borderTopLeftRadius;

async function renderRsvps(compact: boolean) {
  authFetch.mockResolvedValue(
    new Response(JSON.stringify(PAYLOAD), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  render(() => <RsvpView weddingId="wed_1" canEdit compact={compact} />);
  await vi.waitFor(() => expect(document.querySelector('input[type="search"]')).not.toBeNull(), {
    timeout: 5_000,
  });
  await document.fonts.ready;
}

/** Opens the reply editor on the first row that has one to record. */
async function openEditor() {
  const [record] = await screen.findAllByRole("button", { name: /^Record reply for / });
  record!.click();
  const save = await screen.findByRole("button", { name: "Save reply" });
  return save.closest("form")!;
}

afterEach(() => {
  cleanup();
  authFetch.mockReset();
  delete document.documentElement.dataset.theme;
});

describe("the RSVP page's corners", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`draws fields at 14px and buttons as pills, ${viewport.name}px ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        await renderRsvps(viewport.compact);

        // A text field takes the field role's 14px. The search box is 28px
        // tall, so that corner is half its height and draws round ends
        // (DESIGN.md §4, "The small fields"); whether a 28px field should keep
        // it is an open question for the owner.
        const searchBox = document.querySelector('input[type="search"]')!;
        expect(corner(searchBox)).toBe("14px");
        searchBox.scrollIntoView({ block: "start" });
        await page.screenshot({ path: shot(`rsvp-bar-${viewport.name}-${theme}`) });

        const form = await openEditor();
        // The editor's own fields, written by hand in the view, take it too,
        // and at their height it leaves a straight side: not a pill.
        const fields = [...form.querySelectorAll("select, textarea")];
        expect(fields.length).toBeGreaterThan(0);
        for (const field of fields) {
          expect(corner(field)).toBe("14px");
          expect(14).toBeLessThan(field.getBoundingClientRect().height / 2);
        }
        // The editor opens inside the list's 6px frame — a table cell, or a
        // row on a phone — so it takes the nested step, never a corner larger
        // than the frame around it.
        expect(corner(form)).toBe("6px");

        // An action is a pill: its corner reaches at least half its height,
        // which is the radius a box needs before its ends are round, and is
        // over 16px, so it is neither the field step nor the card step.
        const save = within(form).getByRole("button", { name: "Save reply" });
        const saveCorner = Number.parseFloat(corner(save));
        expect(saveCorner).toBeGreaterThanOrEqual(save.getBoundingClientRect().height / 2);
        expect(saveCorner).toBeGreaterThan(16);

        form.scrollIntoView({ block: "center" });
        await page.screenshot({ path: shot(`rsvp-editor-${viewport.name}-${theme}`) });
      });
    }
  }
});
