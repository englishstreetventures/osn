import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The portal's corners and small fields, read from a real engine: a text field
 * is the 14px `field` corner, an action button is a pill, and a small field is
 * one of two heights by what it does (DESIGN.md §4, "The small fields").
 *
 * - A filter in a view bar — the RSVP search box and, on a phone, its sort
 *   select — is 28px, so the 14px corner is half its height: a pill.
 * - A small field that edits a value — the budget's money cells, its payment
 *   form and its price per head — is 34px, so the same corner leaves a
 *   straight side.
 *
 * The corners come from the host stylesheet's role map (`--ui-radius-field`,
 * `--ui-radius-control`), which no unit test resolves: happy-dom computes no
 * `var()` and lays nothing out, so only a browser can say what a field paints
 * and how tall it is.
 *
 * Each case leaves screenshots under `__screenshots__/` beside this file
 * (gitignored), at a phone's width and a laptop's, light and dark: the RSVP bar
 * with the search box it measures, the reply editor open, and the budget's
 * fields.
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

import BudgetView from "../../src/components/BudgetView";
import RsvpView from "../../src/components/RsvpView";
import { __resetBudgetCache } from "../../src/lib/budget-store";
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

/**
 * A field's height, its corner and whether that corner rounds its ends, named
 * so a failure says which field. A corner of at least half the height is the
 * radius a box needs before its ends are round.
 */
function shape(name: string, el: Element) {
  const height = Math.round(el.getBoundingClientRect().height * 100) / 100;
  const radius = corner(el);
  return { name, height, corner: radius, pill: Number.parseFloat(radius) >= height / 2 };
}

/** A filter in a bar: 28px, so the 14px corner rounds its ends. */
const FILTER = { height: 28, corner: "14px", pill: true };
/** A small field that edits a value: 34px, so the 14px corner leaves a straight side. */
const FORM_FIELD = { height: 34, corner: "14px", pill: false };

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
  __resetBudgetCache();
  delete document.documentElement.dataset.theme;
});

describe("the RSVP page's corners", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`draws fields at 14px and buttons as pills, ${viewport.name}px ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        await renderRsvps(viewport.compact);

        // The search box filters the list, so it is a filter's 28px and the
        // field role's 14px corner rounds its ends; on a phone the sort select
        // beside it is the same (DESIGN.md §4, "The small fields"). A laptop
        // sorts from the head row and draws no select.
        const searchBox = document.querySelector('input[type="search"]')!;
        expect(shape("search", searchBox)).toEqual({ name: "search", ...FILTER });
        const sort = screen.queryByRole("combobox", { name: "Sort guests" });
        expect(sort && shape("sort", sort)).toEqual(
          viewport.compact ? { name: "sort", ...FILTER } : null,
        );
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

const BUDGET = {
  items: [
    {
      id: "it",
      weddingId: "wed_1",
      category: "venue",
      name: "Reception venue",
      estimateMinor: 1_200_000,
      quotedMinor: null,
      actualMinor: null,
      notes: null,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  payments: [],
  budgetTotalMinor: null,
  currency: "AUD",
  // An API that sends the event list can store a price per head.
  events: [],
};

describe("the budget's small fields", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`draws a field that edits a value at 34px, ${viewport.name}px ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        authFetch.mockResolvedValue(
          new Response(JSON.stringify(BUDGET), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
        render(() => <BudgetView weddingId="wed_1" canEdit canManage />);
        (await screen.findByRole("button", { name: "payments (0)" })).click();
        screen.getByRole("button", { name: "per head" }).click();
        await screen.findByRole("textbox", { name: "Payment label" });
        await document.fonts.ready;

        const fields = {
          quote: screen.getByRole("spinbutton", { name: "Quote" }),
          "payment label": screen.getByRole("textbox", { name: "Payment label" }),
          amount: screen.getByRole("spinbutton", { name: "Amount" }),
          "due date": screen.getByLabelText("Due date"),
          "price per head": screen.getByRole("spinbutton", { name: "Price per head (AUD)" }),
        };
        for (const [name, field] of Object.entries(fields)) {
          expect(shape(name, field)).toEqual({ name, ...FORM_FIELD });
        }

        fields["payment label"].scrollIntoView({ block: "center" });
        await page.screenshot({ path: shot(`budget-fields-${viewport.name}-${theme}`) });
      });
    }
  }
});
