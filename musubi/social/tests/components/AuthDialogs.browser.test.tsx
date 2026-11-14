import { AuthContext } from "@osn/client/solid";
import { Button } from "@shared/ui/ui/button";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/App.css";

/**
 * Musubi's sign-in and create-account dialogs, `AuthDialogs` with the real
 * `@osn/auth-ui` views inside, in a real browser at a phone's widths and a
 * desktop's, light and dark.
 *
 * Each dialog has one layout (`osn/auth-ui/DESIGN.md` §4, `DESIGN.md`
 * §Responsive layout, Dialogs): the title alone in the header, centred; the
 * step's body; then a footer whose Cancel, `secondary`, comes first, beside
 * the step's one action, both `sm`, 40px tall below `md` and 32px from it.
 * It opens with focus on the dialog itself. Where the title sits, which
 * variant paints Cancel and whether the pair fits a 320px sheet are computed
 * style and layout, which happy-dom cannot see.
 *
 * Each case writes a shot under the gitignored `e2e-artifacts/musubi-dialogs/`.
 */

// Every call the views make waits for ever, so each holds its first step.
vi.mock("../../src/lib/authClients", () => {
  const wait = () => new Promise<never>(() => {});
  return {
    loginClient: { passkeyBegin: wait, passkeyComplete: wait },
    recoveryClient: {},
    registrationClient: { checkHandle: wait },
  };
});

const never = () => new Promise<never>(() => {});

import { AuthDialogs } from "../../src/components/AuthDialogs";

/** Relative to this file: the repository's `e2e-artifacts/`. */
const SHOTS = "../../../../e2e-artifacts/musubi-dialogs";

/** Signed out, as anyone who opens these dialogs is. */
function signedOut() {
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
    session: resource(null),
    profiles: resource(null),
    activeProfileId: () => null,
    adoptSession: never,
  };
}

/** One of the two dialogs open, with a `secondary` `sm` probe outside it. */
async function openDialog(which: "signIn" | "register", width: number, theme: string) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  await page.viewport(width, width < 768 ? 844 : 900);
  render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
    <AuthContext.Provider value={signedOut() as any}>
      <Button variant="secondary" size="sm">
        Probe secondary
      </Button>
      <AuthDialogs
        showSignIn={which === "signIn"}
        onShowSignInChange={() => {}}
        showRegister={which === "register"}
        onShowRegisterChange={() => {}}
      />
    </AuthContext.Provider>
  ));
  const name = which === "signIn" ? "Sign in to Musubi" : "Create your Musubi account";
  const sheet = await waitFor(() => screen.getByRole("dialog", { name }));
  await settle();
  return sheet;
}

/** Waits for every animation that ends: the sheet's entry fade and its scrim's. */
async function settle() {
  const ending = document
    .getAnimations()
    .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? 0));
  await Promise.all(ending.map((a) => a.finished.catch(() => {})));
}

/** A button's paint, to compare one variant with another. */
function look(element: Element) {
  const style = getComputedStyle(element);
  return {
    backgroundColor: style.backgroundColor,
    color: style.color,
    borderTopWidth: style.borderTopWidth,
  };
}

/** The names of the buttons in the footer the dialog's Cancel sits in, in order. */
function footerRow(sheet: HTMLElement): string[] {
  const cancel = within(sheet).getByRole("button", { name: "Cancel" });
  return [...cancel.parentElement!.querySelectorAll("button")].map((b) => b.textContent ?? "");
}

/**
 * The dialog's layout, checked against `DESIGN.md`: the header holds the
 * title alone, centred in the sheet; the footer's Cancel `secondary`, every
 * footer button inside the sheet's 16px padding at the height the width calls
 * for, on one row; nothing scrolls sideways.
 */
function expectLayout(sheet: HTMLElement, width: number) {
  const title = within(sheet).getByRole("heading", { level: 2 });
  const header = title.parentElement!;
  expect(header.querySelectorAll("button")).toHaveLength(0);
  expect(getComputedStyle(title).textAlign).toBe("center");
  const box = sheet.getBoundingClientRect();
  const span = textBox(title);
  expect(Math.abs(span.left + span.width / 2 - (box.left + box.width / 2))).toBeLessThanOrEqual(1);

  const cancel = within(sheet).getByRole("button", { name: "Cancel" });
  const row = [...cancel.parentElement!.querySelectorAll("button")];
  expect(look(cancel)).toEqual(
    look(screen.getByRole("button", { name: "Probe secondary", hidden: true })),
  );
  const tall = width < 768 ? 40 : 32;
  for (const button of row) {
    const rect = button.getBoundingClientRect();
    expect(rect.height).toBeCloseTo(tall, 0);
    // One line: the pair shares a row.
    expect(rect.top).toBeCloseTo(row[0]!.getBoundingClientRect().top, 0);
    expect(rect.right).toBeLessThanOrEqual(box.right - 16 + 0.5);
    expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
  }
  expect(sheet.scrollWidth).toBeLessThanOrEqual(sheet.clientWidth);
}

/** The box the words of `element` take, line boxes and all, not the element's. */
function textBox(element: Element): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(element);
  return range.getBoundingClientRect();
}

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

const THEMES = ["light", "dark"] as const;
const WIDTHS = [320, 390, 1440] as const;

describe("the sign-in dialog", () => {
  for (const theme of THEMES) {
    it.each(WIDTHS)(
      `centres its title and pairs Cancel with Continue at %ipx (${theme})`,
      async (width) => {
        const sheet = await openDialog("signIn", width, theme);
        expect(footerRow(sheet)).toEqual(["Cancel", "Continue"]);
        expectLayout(sheet, width);
        // "Lost your passkey?" is the body's, centred under the field.
        const link = within(sheet).getByRole("button", { name: "Lost your passkey?" });
        const field = within(sheet).getByLabelText("Email or @handle");
        const linkBox = link.getBoundingClientRect();
        const fieldBox = field.getBoundingClientRect();
        expect(linkBox.top).toBeGreaterThan(fieldBox.bottom);
        expect(
          Math.abs(linkBox.left + linkBox.width / 2 - (fieldBox.left + fieldBox.width / 2)),
        ).toBeLessThanOrEqual(1);
        await page.screenshot({ path: `${SHOTS}/sign-in-${width}-${theme}.png` });
      },
    );
  }

  it("opens with focus on the dialog, not on a field or a button", async () => {
    const sheet = await openDialog("signIn", 390, "light");
    await waitFor(() => expect(document.activeElement).toBe(sheet));
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(within(sheet).getByLabelText("Email or @handle"));
  });

  it("pairs Cancel with the recovery chooser's own action at 320px", async () => {
    const sheet = await openDialog("signIn", 320, "light");
    await userEvent.click(within(sheet).getByRole("button", { name: "Lost your passkey?" }));
    const renamed = await waitFor(() =>
      screen.getByRole("dialog", { name: "Recover your account" }),
    );
    expect(footerRow(renamed)).toEqual(["Cancel", "Use a recovery code"]);
    expectLayout(renamed, 320);
    await page.screenshot({ path: `${SHOTS}/recovery-chooser-320-light.png` });
  });
});

describe("the create-account dialog", () => {
  for (const theme of THEMES) {
    it.each(WIDTHS)(
      `centres its title and pairs Cancel with the send at %ipx (${theme})`,
      async (width) => {
        const sheet = await openDialog("register", width, theme);
        expect(footerRow(sheet)).toEqual(["Cancel", "Send verification link"]);
        expectLayout(sheet, width);
        // The body's column, 16px in from each edge: `CheckEmailView`'s layout
        // test copies it, and this is what holds the copy to the real one.
        const column = within(sheet).getByLabelText("Email").getBoundingClientRect().width;
        expect(column).toBeCloseTo(sheet.clientWidth - 32, 0);
        await page.screenshot({ path: `${SHOTS}/create-account-${width}-${theme}.png` });
      },
    );
  }

  it("opens with focus on the dialog, not on the i beside Email", async () => {
    const sheet = await openDialog("register", 390, "light");
    await waitFor(() => expect(document.activeElement).toBe(sheet));
  });
});
