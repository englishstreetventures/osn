import { AuthContext } from "@osn/client/solid";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/App.css";

/**
 * The step-up sheet in Settings → Security, in a real browser.
 *
 * "Add passkey" mounts `StepUpDialog`, which is `@shared/ui`'s `Dialog` with
 * `presentation="sheet"`: a bottom sheet as wide as the screen below `md`, a
 * centred 384px card above. Its authenticator-code step is a row of six
 * `OtpInput` boxes inside the sheet's 16px padding, so at 320px the row is
 * 288px and each box at least 40px (`DESIGN.md` §Responsive layout, Code
 * boxes). Widths, the focus hand-back and Escape take a real browser.
 *
 * The factories are written literally: the shared-factory idiom in
 * `test-support/` does not resolve in the browser project.
 */

// The passkey's name; one case sets it to the longest name the field takes.
const fixture = vi.hoisted(() => ({ label: "Work laptop" }));

vi.mock("@osn/auth-ui/ProfileOnboarding", () => ({ ProfileOnboarding: () => null }));
vi.mock("../../src/lib/authClients", () => ({
  registrationClient: { checkHandle: () => Promise.resolve({ available: true }) },
  passkeysClient: {
    list: () =>
      Promise.resolve({
        passkeys: [
          {
            id: "pk_aaaaaaaaaaaa",
            label: fixture.label,
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
  // The emailed link's wait: the request answers, and its status never does.
  stepUpClient: {
    emailBegin: () =>
      Promise.resolve({
        requestId: "stepup_0123456789ab",
        claimSecret: "c".repeat(64),
        pairingCode: "47",
        expiresAt: 1_900_000_000,
      }),
    emailStatus: () => new Promise(() => {}),
  },
  // Enrolled, so the step-up offers the authenticator, whose step is the code row.
  totpClient: { status: () => Promise.resolve({ enrolled: true }) },
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

/** Settings → Security, then "Add passkey": the step-up sheet, and the button that opened it. */
async function openSheet() {
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
  const opener = await waitFor(() => screen.getByRole("button", { name: "Add passkey" }));
  await userEvent.click(opener);
  const sheet = await waitFor(() => screen.getByRole("dialog", { name: "Confirm it's you" }));
  return { sheet, opener };
}

/** The sheet's authenticator-code step: its row of boxes. */
async function openCodeStep() {
  const { sheet } = await openSheet();
  await userEvent.click(
    await waitFor(() => within(sheet).getByRole("button", { name: "Use your authenticator app" })),
  );
  const row = await waitFor(() =>
    within(sheet).getByRole("group", { name: "Code from your authenticator app" }),
  );
  return { sheet, row };
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
  fixture.label = "Work laptop";
});

/**
 * Each shot is taken in its own render with the theme set before it, never by
 * flipping the theme on a drawn page: the buttons' colour transitions would be
 * caught half way. Shots wait for the sheet's entry fade (`--ui-dur-fast`).
 */
const settle = () => new Promise((r) => setTimeout(r, 300));

describe("the step-up sheet in Settings → Security", () => {
  it.each(["light", "dark"])(
    "is a bottom sheet at 390px that takes focus and gives it back on Escape (%s)",
    async (theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      await page.viewport(390, 844);
      const { sheet, opener } = await openSheet();
      const box = sheet.getBoundingClientRect();
      expect(box.left).toBeCloseTo(0, 1);
      expect(box.width).toBeCloseTo(390, 1);
      expect(box.bottom).toBeCloseTo(window.innerHeight, 0);
      const style = getComputedStyle(sheet);
      expect(style.borderTopLeftRadius).toBe("16px");
      expect(style.borderTopRightRadius).toBe("16px");
      expect(style.borderBottomLeftRadius).toBe("0px");
      expect(style.borderBottomRightRadius).toBe("0px");
      // Focus moves into the sheet: the first factor.
      await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
      expect(document.activeElement).toBe(
        within(sheet).getByRole("button", { name: "Use passkey" }),
      );
      await settle();
      await page.screenshot({ path: `${SHOTS}/step-up-sheet-390-${theme}.png` });

      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      // Back on "Add passkey", which the host disabled while the sheet was open.
      await waitFor(() => expect(document.activeElement).toBe(opener));
    },
  );

  it("holds Resend while the emailed link's wait runs, at 390px", async () => {
    await page.viewport(390, 844);
    const { sheet } = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "Use email instead" }));
    const resend = await waitFor(() =>
      within(sheet).getByRole("button", { name: /^Resend in \d+s$/ }),
    );
    expect((resend as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).getByText("47")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Use another method" })).toBeTruthy();
    await settle();
    await page.screenshot({ path: `${SHOTS}/step-up-sheet-email-390.png` });
  });

  it.each(["light", "dark"])("gives the code row at least 260px at 320px (%s)", async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    // Tall enough that the sheet never scrolls.
    await page.viewport(320, 900);
    const { sheet, row } = await openCodeStep();
    expect(sheet.getBoundingClientRect().width).toBeCloseTo(320, 1);
    const width = row.getBoundingClientRect().width;
    expect(width).toBeGreaterThanOrEqual(260);
    // The sheet's 16px each side: 288px.
    expect(width).toBeCloseTo(288, 0);
    const boxes = within(row).getAllByRole("textbox");
    expect(boxes).toHaveLength(6);
    for (const box of boxes) expect(box.getBoundingClientRect().width).toBeGreaterThanOrEqual(40);
    // Every action stays inside the sheet's 16px padding, 40px tall or more.
    const inner = sheet.getBoundingClientRect().right - 16;
    for (const button of within(sheet).getAllByRole("button")) {
      expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(inner + 0.5);
      expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(40);
    }
    await settle();
    await page.screenshot({ path: `${SHOTS}/step-up-code-320-${theme}.png` });
  });

  it.each(["light", "dark"])("is a centred 384px card at 1440px (%s)", async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    await page.viewport(1440, 900);
    const { sheet, row } = await openCodeStep();
    const box = sheet.getBoundingClientRect();
    expect(box.width).toBeCloseTo(384, 1);
    expect(box.left).toBeCloseTo((1440 - 384) / 2, 0);
    // The row inside the sheet's 16px padding and 1px edge.
    expect(row.getBoundingClientRect().width).toBeCloseTo(384 - 2 - 32, 1);
    await settle();
    await page.screenshot({ path: `${SHOTS}/step-up-code-1440-${theme}.png` });
  });
});

describe("a passkey row in Settings → Security", () => {
  it("wraps a 64-character name and keeps Rename and Delete inside the card at 320px", async () => {
    // The rename field's longest name, with no space to break at.
    fixture.label = "x".repeat(64);
    await page.viewport(320, 2400);
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
    const rename = await waitFor(() => screen.getByRole("button", { name: "Rename" }));
    const card = settingsCard(rename);
    const inner =
      card.getBoundingClientRect().right - parseFloat(getComputedStyle(card).paddingRight);
    for (const name of ["Rename", "Delete"]) {
      const button = screen.getByRole("button", { name });
      expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(inner + 0.5);
    }
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    await page.screenshot({ path: `${SHOTS}/passkey-long-name-320.png` });
  });
});
