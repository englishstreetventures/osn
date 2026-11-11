/**
 * Musubi's `/verify/:requestId` page as people see it: the real page under a
 * router at its own path, musubi's own stylesheet, in a real Chromium. Only
 * the link client and the captured secret are stand-ins.
 *
 * The page draws three things of its own around `ConfirmLinkPage`, and this
 * holds each against it:
 *
 * - a read that failed is a `Card` with `ConfirmLinkPage`'s fill and radius,
 *   in light and dark, and its Try again is 44px tall below `md` and
 *   `Button`'s own `lg` 40px from it, as wide as the card allows;
 * - a dead link, whether its id names no flow or it lost its secret, is
 *   `ConfirmLinkPage`'s own expired card;
 * - while the read runs, a placeholder holds the ready card's place, so the
 *   product's name above it does not move when the card arrives;
 * - Try again keeps the failed card up, shows the wait on its button, and
 *   says each try and each failure in the page's live region;
 * - nothing scrolls sideways on a 320px phone.
 *
 * Each case writes a screenshot to `__screenshots__/` beside this file
 * (gitignored).
 */

import type { EmailLinkCandidates } from "@osn/client";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/App.css";
import { VerifyEmailLinkPage } from "../../src/pages/VerifyEmailLinkPage";

const link = vi.hoisted(() => ({
  candidates: vi.fn<(id: string, secret: string) => Promise<EmailLinkCandidates>>(),
  confirm: vi.fn(),
  secret: "s".repeat(64) as string | null,
}));

vi.mock("../../src/lib/authClients", () => ({
  emailLinkClient: { candidates: link.candidates, confirm: link.confirm },
}));
vi.mock("../../src/lib/email-link", () => ({
  emailLinkSecret: () => link.secret,
}));

const SIGN_UP = "/verify/signup_0123456789ab";
const UNKNOWN = "/verify/nothing_here";
const FIVE = ["17", "42", "08", "93", "61"];

const PHONE = { width: 320, height: 640 };
const COMMON_PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

const SHOTS = "__screenshots__/VerifyEmailLinkPage.layout.browser.test.tsx";

beforeEach(() => {
  link.candidates.mockReset();
  link.confirm.mockReset();
  link.secret = "s".repeat(64);
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

/** Resize, and wait until the frame has the new size before anything mounts. */
async function atViewport({ width, height }: { width: number; height: number }) {
  const resized =
    innerWidth === width && innerHeight === height
      ? Promise.resolve()
      : new Promise<void>((resolve) =>
          window.addEventListener("resize", () => resolve(), { once: true }),
        );
  await page.viewport(width, height);
  await resized;
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/** Settled promises, two frames and loaded faces: a box read before then is a different number. */
async function painted() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await nextFrame();
  await nextFrame();
  await document.fonts.ready;
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The page at `path`, as the app routes it. */
async function open(path: string) {
  const history = createMemoryHistory();
  history.set({ value: path });
  render(() => (
    <MemoryRouter history={history}>
      <Route path="/verify/:requestId" component={VerifyEmailLinkPage} />
    </MemoryRouter>
  ));
  await painted();
}

/** The card a heading sits in: the child of `<main>` that holds it, never the name above it. */
function cardOf(heading: string) {
  return screen
    .getByRole("heading", { level: 1, name: heading })
    .closest("main > *") as HTMLElement;
}

function wordmark() {
  return screen.getByText("Musubi");
}

function look(card: HTMLElement) {
  const style = getComputedStyle(card);
  return { background: style.backgroundColor, radius: style.borderTopLeftRadius };
}

const FAILED = "We couldn't open this link just now";
const DEAD = "This link no longer works";

/** What the link client throws when no answer came: status 0, as `reach` builds it. */
const offline = () => Object.assign(new Error("PLANTED offline"), { status: 0 });
/** `describeAuthError`'s sentence for it. */
const CONNECTION = "We couldn't connect. Check your connection and try again.";

describe("the emailed-link page's own states, on musubi's /verify route", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`draws a failed read in ConfirmLinkPage's card, in ${theme}`, async () => {
      if (theme === "dark") document.documentElement.classList.add("dark");
      await atViewport(PHONE);

      // A link that lost its secret: `ConfirmLinkPage`'s own expired card.
      link.secret = null;
      await open(SIGN_UP);
      const expired = look(cardOf(DEAD));
      cleanup();
      link.secret = "s".repeat(64);

      link.candidates.mockRejectedValue(offline());
      await open(SIGN_UP);
      const card = cardOf(FAILED);
      expect(look(card)).toEqual(expired);
      // In dark the card is a lighter surface than the page; in light both are white.
      const onPage = look(card).background === getComputedStyle(document.body).backgroundColor;
      expect(onPage).toBe(theme === "light");
      expect(getComputedStyle(card).textAlign).toBe("start");

      // The line is the danger notice: red ink, the mark, and "Error" read aloud.
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toBe(`Error: ${CONNECTION}`);
      expect(card.contains(alert)).toBe(true);

      await page.screenshot({ path: `${SHOTS}/failed-320-${theme}.png` });
    });
  }

  it("draws the failed card's Try again 44px tall below md and 40px from md, as wide as the card", async () => {
    link.candidates.mockRejectedValue(offline());
    for (const viewport of [PHONE, DESKTOP]) {
      await atViewport(viewport);
      await open(SIGN_UP);
      const button = screen.getByRole("button", { name: "Try again" });
      const box = button.getBoundingClientRect();
      expect(box.height).toBe(viewport === PHONE ? 44 : 40);

      const card = cardOf(FAILED);
      const padding = Number.parseFloat(getComputedStyle(card).paddingLeft);
      const border = Number.parseFloat(getComputedStyle(card).borderLeftWidth);
      expect(box.width).toBe(card.getBoundingClientRect().width - 2 * (padding + border));
      // The notice sits above the button, inside the card.
      expect(screen.getByRole("alert").getBoundingClientRect().bottom).toBeLessThanOrEqual(box.top);
      expect(document.documentElement.scrollWidth).toBe(viewport.width);
      expect(card.scrollWidth).toBe(card.clientWidth);
      await page.screenshot({ path: `${SHOTS}/failed-${viewport.width}.png` });
      cleanup();
    }
  });

  it("draws a link whose id names no flow, and one with no secret, as ConfirmLinkPage's expired card", async () => {
    await atViewport(PHONE);
    await open(UNKNOWN);
    const unknown = cardOf(DEAD);
    const unknownLook = look(unknown);
    expect(unknown.textContent).toContain("If you confirmed it already");
    expect(link.candidates).not.toHaveBeenCalled();
    expect(document.documentElement.scrollWidth).toBe(PHONE.width);
    await page.screenshot({ path: `${SHOTS}/dead-unknown-320.png` });
    cleanup();

    link.secret = null;
    await open(SIGN_UP);
    const cut = cardOf(DEAD);
    expect(look(cut)).toEqual(unknownLook);
    expect(cut.textContent).toBe(unknown.textContent);
    expect(link.candidates).not.toHaveBeenCalled();
  });

  // The name sits where it did at every width. On a 390px phone and on
  // desktop the column fits the screen, so the placeholder is also the card's
  // height; at 320px the column is taller than a 640px screen either way and
  // only the name's place is held.
  for (const [viewport, columnFits] of [
    [PHONE, false],
    [COMMON_PHONE, true],
    [DESKTOP, true],
  ] as const) {
    it(`holds the ready card's place while the read runs, so the name above does not move, at ${viewport.width}px`, async () => {
      await atViewport(viewport);
      const read = deferred<EmailLinkCandidates>();
      link.candidates.mockReturnValue(read.promise);
      await open(SIGN_UP);

      const region = wordmark().nextElementSibling as HTMLElement;
      expect(region.getAttribute("aria-busy")).toBe("true");
      const shown = [...region.children].filter(
        (block) => getComputedStyle(block).display !== "none",
      ) as HTMLElement[];
      expect(shown).toHaveLength(1);
      expect(shown[0]!.getAttribute("aria-hidden")).toBe("true");
      expect(getComputedStyle(shown[0]!).borderTopLeftRadius).toBe("16px");
      const held = region.getBoundingClientRect().height;
      const before = wordmark().getBoundingClientRect().top;
      await page.screenshot({ path: `${SHOTS}/loading-${viewport.width}.png` });

      read.resolve({ status: "ready", candidates: FIVE });
      await painted();
      const card = cardOf("Confirm this email");
      expect(Math.abs(wordmark().getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
      const heightOff = columnFits ? Math.abs(card.getBoundingClientRect().height - held) : 0;
      expect(heightOff).toBeLessThanOrEqual(2);
      expect(document.documentElement.scrollWidth).toBe(viewport.width);
      await page.screenshot({ path: `${SHOTS}/ready-${viewport.width}.png` });
    });
  }

  it("keeps the failed card up through Try again, shows the wait on its button, and says each try and failure", async () => {
    await atViewport(PHONE);
    link.candidates.mockRejectedValueOnce(offline());
    await open(SIGN_UP);
    const live = document.querySelector("output") as HTMLOutputElement;
    // The first failure is said by the card's own alert as it appears.
    expect(live.textContent).toBe("");

    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = deferred<EmailLinkCandidates>();
      link.candidates.mockReturnValueOnce(retry.promise);
      const tryAgain = screen.getByRole("button", { name: "Try again" });
      tryAgain.focus();
      fireEvent.click(tryAgain);
      await painted();

      const button = screen.getByRole("button", { name: "Checking…" }) as HTMLButtonElement;
      // Busy, not disabled: it keeps focus and refuses a press.
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(button.disabled).toBe(false);
      expect(cardOf(FAILED).contains(button)).toBe(true);
      expect(document.activeElement).toBe(button);
      fireEvent.click(button);
      expect(link.candidates).toHaveBeenCalledTimes(attempt + 2);
      expect(live.textContent).toBe("Checking this link…");
      if (attempt === 0) await page.screenshot({ path: `${SHOTS}/retrying-320.png` });

      retry.reject(offline());
      await painted();
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
      expect(live.textContent).toBe(CONNECTION);
    }
  });
});
