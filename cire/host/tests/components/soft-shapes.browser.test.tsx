import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The portal's corners and field heights, read from a real engine: a text field
 * is the 14px `field` corner, an action button is a pill, and a field is one of
 * two heights by what it does (DESIGN.md §4, "One form-field height").
 *
 * - A filter in a view bar — the RSVP search box and, on a phone, its sort
 *   select — is 28px, so the 14px corner is half its height: a pill.
 * - A form field — any field that enters or edits a value, at either size — is
 *   34px, so the same corner leaves a straight side. A button in a row with one
 *   is 34px too: the budget's Add item, Add payment and the budget's own Save
 *   and Cancel, the registry's Find pictures, the co-host form's Add host.
 *
 * The corners come from the host stylesheet's role map (`--ui-radius-field`,
 * `--ui-radius-control`), which no unit test resolves: happy-dom computes no
 * `var()` and lays nothing out, so only a browser can say what a field paints
 * and how tall it is.
 *
 * Each case leaves screenshots under `__screenshots__/` beside this file
 * (gitignored), at a phone's width and a laptop's, light and dark: the RSVP bar
 * with the search box it measures, the reply editor open, the budget's fields,
 * the registry's add form and inline editor, and the co-host form.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({
  useAuth: () => ({ authFetch, activeProfileId: () => "usr_amy" }),
}));
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
import HostsPanel from "../../src/components/HostsPanel";
import RegistryView from "../../src/components/RegistryView";
import RsvpView from "../../src/components/RsvpView";
import { __resetBudgetCache } from "../../src/lib/budget-store";
import { __resetHostsCache } from "../../src/lib/hosts-store";
import { __resetRegistryCache } from "../../src/lib/registry-store";
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
/** A form field: 34px, so the 14px corner leaves a straight side. */
const FORM_FIELD = { height: 34, corner: "14px", pill: false };

/** A button in a row with a form field: the field's height. */
const ACTION_HEIGHT = 34;

/**
 * Every field in `fields` and button in `actions` that is not the shape it
 * should be, as measured, so `toEqual([])` names each one that is off.
 */
function misfits(fields: Record<string, Element>, actions: Record<string, Element> = {}) {
  const off: object[] = [];
  for (const [name, field] of Object.entries(fields)) {
    const measured = shape(name, field);
    const { height, corner: radius, pill } = measured;
    if (height !== FORM_FIELD.height || radius !== FORM_FIELD.corner || pill !== FORM_FIELD.pill) {
      off.push(measured);
    }
  }
  for (const [name, action] of Object.entries(actions)) {
    const height = Math.round(action.getBoundingClientRect().height * 100) / 100;
    if (height !== ACTION_HEIGHT) off.push({ name, height });
  }
  return off;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

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
  __resetRegistryCache();
  __resetHostsCache();
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
        // beside it is the same (DESIGN.md §4, "One form-field height"). A laptop
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
        // and at their height it leaves a straight side: not a pill. Its
        // status select is a form field, 34px; the textarea keeps its own
        // two-row height.
        const fields = [...form.querySelectorAll("select, textarea")];
        expect(fields.length).toBeGreaterThan(0);
        for (const field of fields) {
          expect(corner(field)).toBe("14px");
          expect(14).toBeLessThan(field.getBoundingClientRect().height / 2);
        }
        expect(misfits({ status: within(form).getByRole("combobox", { name: "Status" }) })).toEqual(
          [],
        );
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

describe("the budget's form fields", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`draws every field and the buttons beside them at 34px, ${viewport.name}px ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        authFetch.mockResolvedValue(json(BUDGET));
        render(() => <BudgetView weddingId="wed_1" canEdit canManage />);
        (await screen.findByRole("button", { name: "payments (0)" })).click();
        screen.getByRole("button", { name: "per head" }).click();
        screen.getByRole("button", { name: "Set a budget →" }).click();
        await screen.findByRole("textbox", { name: "Payment label" });
        await document.fonts.ready;

        // The budget's own total, with its Save and Cancel beside it.
        const total = screen.getByRole("spinbutton", { name: "Total budget (AUD)" });
        const capRow = within(total.closest("div:has(> button)") as HTMLElement);
        expect(
          misfits(
            { total },
            {
              "budget Save": capRow.getByRole("button", { name: "Save" }),
              "budget Cancel": capRow.getByRole("button", { name: "Cancel" }),
            },
          ),
        ).toEqual([]);
        // The add-item form at the top and its Add item.
        expect(
          misfits(
            {
              category: screen.getByRole("combobox", { name: "Category" }),
              item: screen.getByRole("textbox", { name: "Item" }),
              estimate: screen.getByRole("spinbutton", { name: "Estimate (optional)" }),
            },
            { "Add item": screen.getByRole("button", { name: "Add item" }) },
          ),
        ).toEqual([]);
        // An item's money cell, its payment form and its price per head.
        expect(
          misfits(
            {
              quote: screen.getByRole("spinbutton", { name: "Quote" }),
              "payment label": screen.getByRole("textbox", { name: "Payment label" }),
              amount: screen.getByRole("spinbutton", { name: "Amount" }),
              "due date": screen.getByLabelText("Due date"),
              "price per head": screen.getByRole("spinbutton", { name: "Price per head (AUD)" }),
            },
            { "Add payment": screen.getByRole("button", { name: "Add payment" }) },
          ),
        ).toEqual([]);

        total.scrollIntoView({ block: "start" });
        await page.screenshot({ path: shot(`budget-top-${viewport.name}-${theme}`) });
        screen.getByRole("textbox", { name: "Payment label" }).scrollIntoView({ block: "center" });
        await page.screenshot({ path: shot(`budget-fields-${viewport.name}-${theme}`) });
      });
    }
  }
});

const REGISTRY_ITEM = {
  id: "itm_1",
  weddingId: "wed_1",
  kind: "product",
  title: "Copper pan",
  description: null,
  imageKey: null,
  imageCrop: null,
  externalUrl: null,
  priceMinor: 12_000,
  quantityWanted: 1,
  quantityClaimed: 0,
  allowPartial: false,
  targetMinor: null,
  category: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

const REGISTRY = {
  settings: {
    weddingId: "wed_1",
    published: false,
    headline: null,
    message: null,
    cashGiftsEnabled: false,
    shippingAddress: null,
    shippingVisibleFrom: null,
    stripeConnected: false,
    stripeChargesEnabled: false,
    updatedAt: null,
  },
  items: [REGISTRY_ITEM],
  gifts: [],
  giftsHasMore: false,
  giftSummary: null,
  currency: "AUD",
  contributionsPrimaryMinor: 0,
  contributionsOtherCurrencyCount: 0,
  takesPayments: true,
};

describe("the registry's form fields", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`draws the add form and the inline editor at 34px, ${viewport.name}px ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        authFetch.mockResolvedValue(json(REGISTRY));
        render(() => (
          <RegistryView weddingId="wed_1" weddingSlug="nadia-and-sam" view="list" canEdit />
        ));
        const gift = await screen.findByRole("textbox", { name: "Gift" });
        await document.fonts.ready;

        // The add form. Its Add gift stands on a line of its own under the
        // picture, not beside a field, so it keeps its own height.
        expect(
          misfits({
            gift,
            price: screen.getByRole("spinbutton", { name: "Price (optional)" }),
            "how many": screen.getByRole("spinbutton", { name: "How many" }),
            link: screen.getByRole("textbox", { name: "Link (optional)" }),
          }),
        ).toEqual([]);
        gift.scrollIntoView({ block: "start" });
        await page.screenshot({ path: shot(`registry-add-${viewport.name}-${theme}`) });

        // The inline editor, with the shop link and Find pictures beside it.
        screen.getByRole("button", { name: "Edit Copper pan" }).click();
        const save = await screen.findByRole("button", { name: "Save" });
        const editor = within(save.closest("form")!);
        editor.getByRole("button", { name: "Use a shop link" }).click();
        const shopLink = await editor.findByRole("textbox", { name: "Shop link" });
        expect(
          misfits(
            {
              "edit gift": editor.getByRole("textbox", { name: "Gift" }),
              "edit price": editor.getByRole("spinbutton", { name: "Price" }),
              "edit how many": editor.getByRole("spinbutton", { name: "How many" }),
              "edit category": editor.getByRole("textbox", { name: "Category" }),
              "edit link": editor.getByRole("textbox", { name: "Link" }),
              "shop link": shopLink,
            },
            { "Find pictures": editor.getByRole("button", { name: "Find pictures" }) },
          ),
        ).toEqual([]);
        shopLink.scrollIntoView({ block: "center" });
        await page.screenshot({ path: shot(`registry-edit-${viewport.name}-${theme}`) });
      });
    }
  }
});

const HOSTS = [
  { hostId: "whost_amy", osnProfileId: "usr_amy", handle: "amy", role: "owner", createdAt: 0 },
  { hostId: "whost_jo", osnProfileId: "usr_jo", handle: "jo", role: "editor", createdAt: 1 },
];

describe("the co-host form", () => {
  for (const viewport of VIEWPORTS) {
    it(`draws the handle field and Add host at 34px, ${viewport.name}px`, async () => {
      await page.viewport(viewport.width, viewport.height);
      authFetch.mockImplementation(async () =>
        json({ hosts: HOSTS, total: HOSTS.length, peopleLimit: null }),
      );
      render(() => (
        <div class="bg-bg text-text @container/panel" style={{ padding: "16px" }}>
          <HostsPanel weddingId="wed_1" callerRole="owner" />
        </div>
      ));
      const handle = await screen.findByRole("combobox", { name: "OSN handle" });
      await document.fonts.ready;

      // `UsernameInput` takes the height through its wrapper (HostsPanel), so
      // this is the one field that reaches it by a descendant selector.
      expect(
        misfits(
          { handle },
          { "Add host": screen.getByRole("button", { name: /^Add (host|as owner)$/ }) },
        ),
      ).toEqual([]);
      handle.scrollIntoView({ block: "center" });
      await page.screenshot({ path: shot(`hosts-add-${viewport.name}`) });
    });
  }
});
