import { AuthContext } from "@osn/client/solid";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/App.css";

/**
 * The step-up's code row in Settings → Security, in a real browser.
 *
 * `StepUpDialog` mounts inline in the Security card, below the passkey list,
 * and its emailed-code step is a row of six `OtpInput` boxes that share their
 * column. On a phone the dialog drops its side padding, so the row takes the
 * card's whole column rather than the column less 32px (§Responsive layout,
 * Code boxes, in `DESIGN.md`). Widths take a real layout.
 *
 * The factories are written literally: the shared-factory idiom in
 * `test-support/` does not resolve in the browser project.
 */

vi.mock("@osn/auth-ui/ProfileOnboarding", () => ({ ProfileOnboarding: () => null }));
vi.mock("../../src/lib/authClients", () => ({
  registrationClient: { checkHandle: () => Promise.resolve({ available: true }) },
  passkeysClient: {
    list: () =>
      Promise.resolve({
        passkeys: [
          {
            id: "pk_aaaaaaaaaaaa",
            label: "Work laptop",
            aaguid: null,
            transports: null,
            backupEligible: false,
            backupState: false,
            createdAt: 1_700_000_000,
            lastUsedAt: 1_700_005_000,
          },
        ],
      }),
  },
  stepUpClient: { otpBegin: () => Promise.resolve({ sent: true }) },
  totpClient: { status: () => Promise.resolve({ enrolled: false }) },
  recoveryClient: { getRecoveryCodesStatus: () => Promise.resolve({ active: 10, total: 10 }) },
}));
vi.mock("../../src/lib/webauthn-ceremony", () => ({ runPasskeyCeremony: () => {} }));
vi.mock("../../src/lib/webauthn-registration", () => ({ runPasskeyRegistration: () => {} }));

import { SettingsPage } from "../../src/pages/SettingsPage";

/** Relative to this file: the repository's `e2e-artifacts/`. */
const SHOTS = "../../../../e2e-artifacts/musubi-settings";

/** An unsigned access token carrying the `sub` claim the page reads. */
const ACCESS_TOKEN = `header.${btoa(JSON.stringify({ sub: "prof_1" }))}.signature`;

function authValue() {
  const session = { accessToken: ACCESS_TOKEN, idToken: null, expiresAt: 0, scopes: [] };
  const resource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: value,
      refetch: () => {},
      mutate: () => {},
    });
  return {
    session: resource(session),
    profiles: resource([]),
    activeProfileId: () => null,
  };
}

/** Settings → Security with the step-up's emailed-code step open; its row of boxes. */
async function openCodeStep() {
  const history = createMemoryHistory();
  history.set({ value: "/settings#security" });
  render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
    <AuthContext.Provider value={authValue() as any}>
      <MemoryRouter history={history}>
        <Route path="/settings" component={SettingsPage} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
  await userEvent.click(await waitFor(() => screen.getByRole("button", { name: "Add passkey" })));
  await userEvent.click(
    await waitFor(() => screen.getByRole("button", { name: /Email me a code/ })),
  );
  return waitFor(() => screen.getByRole("group", { name: "Code" }));
}

/** The width of `card`'s content box: its own width less its padding and edge. */
function contentWidth(card: HTMLElement): number {
  const style = getComputedStyle(card);
  return (
    card.getBoundingClientRect().width -
    parseFloat(style.paddingLeft) -
    parseFloat(style.paddingRight) -
    parseFloat(style.borderLeftWidth) -
    parseFloat(style.borderRightWidth)
  );
}

/** The Settings card that holds `el`: the ancestor `main` holds directly. */
function settingsCard(el: HTMLElement): HTMLElement {
  let node = el;
  while (node.parentElement && node.parentElement.tagName !== "MAIN") node = node.parentElement;
  return node;
}

beforeAll(async () => {
  document.documentElement.classList.remove("dark");
  // The Security tab is a lazy chunk; load it under the hook's budget, so each
  // test waits only for the swap.
  await import("../../src/components/SecuritySection");
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

/**
 * Each shot is taken in its own render with the theme set before it, never by
 * flipping the theme on a drawn page: the buttons' colour transitions would be
 * caught half way.
 */
describe("the step-up's code row in Settings → Security", () => {
  it.each(["light", "dark"])("takes the card's whole column at 320px (%s)", async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    // Tall enough that the page never scrolls, so no scrollbar takes a column.
    await page.viewport(320, 2400);
    const row = await openCodeStep();
    const card = settingsCard(row);
    const width = row.getBoundingClientRect().width;
    expect(width).toBeCloseTo(contentWidth(card), 1);
    // `main`'s 16px each side, the card's 20px and its 1px edge: 246px.
    expect(width).toBeCloseTo(246, 0);
    const boxes = within(row).getAllByRole("textbox");
    expect(boxes).toHaveLength(6);
    for (const box of boxes) expect(box.getBoundingClientRect().width).toBeGreaterThanOrEqual(37);
    // Every panel's action stays inside the card, a long one under its heading.
    const inner =
      card.getBoundingClientRect().right - parseFloat(getComputedStyle(card).paddingRight);
    for (const button of within(card).getAllByRole("button")) {
      expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(inner + 0.5);
    }
    await page.screenshot({ path: `${SHOTS}/step-up-code-320-${theme}.png` });
  });

  it.each(["light", "dark"])("keeps its padding inside the card at 1440px (%s)", async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    await page.viewport(1440, 1600);
    const row = await openCodeStep();
    // The dialog's 16px each side, inside the card's column.
    expect(row.getBoundingClientRect().width).toBeCloseTo(contentWidth(settingsCard(row)) - 32, 1);
    await page.screenshot({ path: `${SHOTS}/step-up-code-1440-${theme}.png` });
  });
});
