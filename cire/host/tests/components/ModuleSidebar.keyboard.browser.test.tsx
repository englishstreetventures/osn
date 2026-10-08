/**
 * A locked module's upgrade, reached from the keyboard alone.
 *
 * The card a locked row opens is portalled to the end of `<body>`, so in the
 * document it sits nowhere near its row, and the sheet it opens from on a
 * phone is a modal with a focus trap. Whether Tab, Enter and Escape walk a
 * person from the row to "Upgrade to Gold", into the purchase dialog and back
 * is a property of real focus in a real engine: the unit tier can fire a
 * `focus` event at an element, but it has no Tab key, no `:focus-visible`
 * and no top layer.
 */

import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("@shared/toast", () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
vi.mock("../../src/lib/haptics", () => ({ haptic: () => {} }));

import ModuleSidebar from "../../src/components/ModuleSidebar";
import { __resetModuleRowsStore } from "../../src/lib/module-rows-store";
import { __resetUpgradeStore } from "../../src/lib/upgrade-store";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  __resetModuleRowsStore();
  __resetUpgradeStore();
  authFetch.mockReset();
  authFetch.mockImplementation(async (url: string) => {
    if (url.endsWith("/module-rows")) return json({ budgetLines: 3, tasks: 0, gifts: 0 });
    if (url.endsWith("/catalogue")) {
      return json({
        tier: "ivory",
        upgrades: [
          {
            tier: "gold",
            fromTier: "ivory",
            title: "Gold tier",
            blurb: "Your budget, checklist and gift registry.",
            amountMinor: 2900,
            currency: "AUD",
          },
        ],
      });
    }
    return new Response("{}", { status: 404 });
  });
});

afterEach(() => {
  // A `showModal()` dialog sits in the top layer and survives a render
  // cleanup; the next test would mount behind it with its page inert.
  for (const d of document.querySelectorAll("dialog[open]")) (d as HTMLDialogElement).close();
  cleanup();
});

/** Mount inside a `shell` container of an explicit width, as `ModuleShell` does. */
function mountAt(width: number, opts: { canManage?: boolean } = {}) {
  return render(() => (
    <div class="@container/shell" style={{ width: `${width}px` }}>
      <ModuleSidebar
        weddingId="wed_test"
        weddingSlug="our-day"
        canManage={opts.canManage ?? false}
        active="overview"
        tier="ivory"
        onSelect={() => {}}
      />
    </div>
  ));
}

/** Press Tab until `target` holds focus, as a person would; fail if it never does. */
async function tabTo(target: Element, limit = 12): Promise<void> {
  for (let i = 0; i < limit && document.activeElement !== target; i++) await userEvent.tab();
  expect(document.activeElement).toBe(target);
}

const focused = () => document.activeElement;
const upgradeButton = () => screen.queryByRole("button", { name: "Upgrade to Gold" });

/** An outline the browser actually paints, not just a declared one. */
function paintsOutline(el: Element): boolean {
  const style = getComputedStyle(el);
  return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
}

describe("on the rail", () => {
  const rail = (container: HTMLElement) =>
    container.querySelector<HTMLElement>("nav[aria-label='Wedding modules']")!;
  const lockedRow = (container: HTMLElement, label: string) =>
    within(rail(container)).getByRole("button", { name: new RegExp(`^${label} — locked`) });

  it("moves focus from the locked row to a ringed, named Upgrade button on Enter", async () => {
    await page.viewport(1280, 900);
    const { container } = mountAt(1200);
    const row = lockedRow(container, "Checklist");

    await tabTo(row);
    await userEvent.keyboard("{Enter}");

    await expect.poll(focused).toBe(upgradeButton());
    expect(upgradeButton()).not.toBeNull();
    expect(paintsOutline(upgradeButton()!)).toBe(true);
  });

  it("keeps the card after the row in the tab order, both ways", async () => {
    await page.viewport(1280, 900);
    const { container } = mountAt(1200);
    const row = lockedRow(container, "Checklist");
    await tabTo(row);
    await userEvent.keyboard("{Enter}");
    await expect.poll(focused).toBe(upgradeButton());

    // Back to the row, and the card stays open for the way forward.
    await userEvent.tab({ shift: true });
    expect(focused()).toBe(row);
    expect(upgradeButton()).not.toBeNull();

    // Tab from the open row goes into the card, not past it.
    await userEvent.tab();
    expect(focused()).toBe(upgradeButton());

    // Tab from the card's last control goes on to the row after this one,
    // and the card goes.
    await userEvent.tab();
    expect(focused()).toBe(lockedRow(container, "Budget"));
    await expect.poll(upgradeButton).toBeNull();
  });

  it("reaches an owner's download after the upgrade, then the next row", async () => {
    await page.viewport(1280, 900);
    const { container } = mountAt(1200, { canManage: true });
    const row = lockedRow(container, "Budget");
    await tabTo(row);
    await userEvent.keyboard("{Enter}");
    await expect.poll(focused).toBe(upgradeButton());
    const download = await screen.findByRole("button", { name: "Download as CSV" });

    await userEvent.tab();
    expect(focused()).toBe(download);

    await userEvent.tab();
    expect(focused()).toBe(lockedRow(container, "Vendors"));
  });

  it("closes the card on Escape and gives focus back to the row", async () => {
    await page.viewport(1280, 900);
    const { container } = mountAt(1200);
    const row = lockedRow(container, "Checklist");
    await tabTo(row);
    await userEvent.keyboard("{Enter}");
    await expect.poll(focused).toBe(upgradeButton());

    await userEvent.keyboard("{Escape}");

    await expect.poll(upgradeButton).toBeNull();
    await expect.poll(focused).toBe(row);
  });

  it("opens the purchase dialog with focus on Cancel, and Escape comes back to the row", async () => {
    await page.viewport(1280, 900);
    const { container } = mountAt(1200);
    const row = lockedRow(container, "Checklist");
    await tabTo(row);
    await userEvent.keyboard("{Enter}");
    await expect.poll(focused).toBe(upgradeButton());

    await userEvent.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog", { name: /upgrade: gold/i });
    // Cancel, not "Continue to payment": a held Enter must never reach Stripe.
    await expect.poll(focused).toBe(within(dialog).getByRole("button", { name: "Cancel" }));

    await userEvent.keyboard("{Escape}");

    await expect.poll(() => screen.queryByRole("dialog", { name: /upgrade: gold/i })).toBeNull();
    await expect.poll(focused).toBe(row);
  });

  it("keeps a card the pointer opened once the keyboard has gone into it", async () => {
    await page.viewport(1280, 900);
    const { container } = mountAt(1200);
    const row = lockedRow(container, "Checklist");
    await tabTo(row);

    // A pointer resting on the row opens the card without taking focus.
    await userEvent.hover(row);
    await expect.poll(upgradeButton, { timeout: 5000 }).not.toBeNull();
    expect(focused()).toBe(row);

    await userEvent.tab();
    expect(focused()).toBe(upgradeButton());

    // The pointer leaves. A card being used from the keyboard is not a
    // pointer's preview any more, so it stays, and focus with it.
    await userEvent.unhover(row);
    await new Promise((done) => setTimeout(done, 600));
    expect(upgradeButton()).not.toBeNull();
    expect(focused()).toBe(upgradeButton());
  });
});

describe("in the sheet", () => {
  const sheet = () => screen.getByRole("dialog", { name: "Wedding modules" });
  const sheetTrigger = () => screen.getByRole("button", { name: /Open wedding navigation/ });
  const lockedRow = (label: string) =>
    within(sheet()).getByRole("button", { name: new RegExp(`^${label} — locked`) });

  async function openSheetAndCard() {
    await page.viewport(414, 896);
    mountAt(375);
    await tabTo(sheetTrigger());
    await userEvent.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: "Wedding modules" });
    const row = lockedRow("Checklist");
    await tabTo(row);
    await userEvent.keyboard("{Enter}");
    return row;
  }

  it("lets focus into the card past the sheet's focus trap", async () => {
    const row = await openSheetAndCard();
    await expect.poll(focused).toBe(upgradeButton());
    expect(paintsOutline(upgradeButton()!)).toBe(true);

    await userEvent.tab({ shift: true });
    expect(focused()).toBe(row);
    await userEvent.tab();
    expect(focused()).toBe(upgradeButton());
  });

  it("closes only the card on Escape, leaving the sheet open on the row", async () => {
    const row = await openSheetAndCard();
    await expect.poll(focused).toBe(upgradeButton());

    await userEvent.keyboard("{Escape}");

    await expect.poll(upgradeButton).toBeNull();
    await expect.poll(focused).toBe(row);
    expect(sheet()).toBeTruthy();
  });

  it("hands the upgrade to the purchase dialog, and Escape returns to the sheet's trigger", async () => {
    await openSheetAndCard();
    await expect.poll(focused).toBe(upgradeButton());

    await userEvent.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog", { name: /upgrade: gold/i });
    await expect.poll(focused).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    // The sheet plays its exit before it unmounts.
    await expect.poll(() => screen.queryByRole("dialog", { name: "Wedding modules" })).toBeNull();
    expect(focused()).toBe(within(dialog).getByRole("button", { name: "Cancel" }));

    await userEvent.keyboard("{Escape}");

    await expect.poll(() => screen.queryByRole("dialog", { name: /upgrade: gold/i })).toBeNull();
    await expect.poll(focused).toBe(sheetTrigger());
  });
});
