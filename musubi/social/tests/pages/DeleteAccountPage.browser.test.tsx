import type { AccountDeletionOpenAction, AccountDeletionPreview } from "@osn/client";
import { AccountDeletionRefusedError } from "@osn/client";
import { contrastRatio } from "@shared/color";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/App.css";

/**
 * The deletion flow as people see it: the page inside the real shell, rail on
 * desktop and top bar and tab bar on a phone, Musubi's own stylesheet, in a
 * real Chromium. The account client, the step-up sheet and the session are
 * stand-ins.
 *
 * Holds what the fast tier cannot see:
 *
 * - nothing on any step scrolls sideways on a 320px or 390px phone, the long
 *   words of an app's action, words an app wrote with no space to break at,
 *   and the member picker included;
 * - each step's buttons, the "Delete everything" row, the choices' rows and
 *   an app's "Open in …" link are at least 40px tall below `md` (DESIGN.md
 *   §Touch targets), and the step buttons are `sm`'s 32px from `md`;
 * - the step's heading, not the page, has focus as a step opens;
 * - an unchosen radio's circle and box's edge clear 3:1 on the card in both
 *   themes, read from the painted colours (DESIGN.md §Choices);
 * - "Delete everything" dims each choice once, to 50%, words and circle alike.
 *
 * Each case writes screenshots to `__screenshots__/` beside this file
 * (gitignored): every step and state in light and dark, at 390px and 1280px.
 * The viewports are tall so a whole step is in one picture.
 */

const mocks = vi.hoisted(() => ({
  preview: vi.fn<() => Promise<AccountDeletionPreview>>(),
  deleteAccount: vi.fn(),
}));

vi.mock("@osn/client/solid", async () => {
  const actual = await vi.importActual<typeof import("@osn/client/solid")>("@osn/client/solid");
  const resource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: value,
      refetch: () => {},
      mutate: () => {},
    });
  const token = `h.${btoa(JSON.stringify({ sub: "usr_alice", handle: "alice", email: "alice@example.com" }))}.s`;
  const signedIn = {
    session: resource({ accessToken: token, expiresAt: Date.now() + 300_000 }),
    profiles: resource([
      { id: "usr_alice", handle: "alice", displayName: "Alice", avatarUrl: null },
    ]),
    profilesError: () => undefined,
    refetchProfiles: () => Promise.resolve(),
    activeProfileId: () => "usr_alice",
    pendingDeletion: () => false,
    renewSession: () => Promise.resolve(),
    logout: () => Promise.resolve(),
    adoptSession: () => Promise.resolve(),
    switchProfile: () => new Promise(() => {}),
    createProfile: () => Promise.reject(new Error("not in this test")),
    deleteProfile: () => Promise.resolve(),
  };
  return {
    ...actual,
    AuthProvider: (props: { children?: unknown }) => (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
      <actual.AuthContext.Provider value={signedIn as any}>
        {props.children as never}
      </actual.AuthContext.Provider>
    ),
  };
});
vi.mock("../../src/components/AccountBanners", () => ({ AccountBanners: () => null }));
vi.mock("../../src/lib/authClients", () => ({
  loginClient: {},
  recoveryClient: {},
  registrationClient: {},
  passkeysClient: {},
  stepUpClient: {},
  totpClient: {},
  accountClient: {
    getAccountDeletionPreview: mocks.preview,
    deleteAccount: mocks.deleteAccount,
    exportAccount: () => new Promise(() => {}),
    sendDataLink: () => new Promise(() => {}),
  },
}));
vi.mock("../../src/components/StepUpSheet", () => ({
  default: (props: { onToken: (token: { token: string }) => void }) => {
    queueMicrotask(() => props.onToken({ token: "tok" }));
    return null;
  },
}));

import { Layout } from "../../src/App";
import { DeleteAccountPage } from "../../src/pages/DeleteAccountPage";
import { railChunks, topBarChunks } from "../test-support/shell-chunks";

const SHOTS = "__screenshots__/DeleteAccountPage.browser.test.tsx";

const ORG: AccountDeletionOpenAction = {
  id: "osn:organisation:org_acme",
  app: "osn",
  kind: "organisation_owned",
  label: "You own Acme Climbing Club (@acmeclimbing).",
  choices: [
    { choice: "transfer", description: "@bobwhite becomes the owner.", erased_on: null },
    { choice: "successor", description: "The member you name becomes the owner.", erased_on: null },
    {
      choice: "delete",
      description: "The organisation and its memberships are deleted.",
      erased_on: null,
    },
  ],
  default_choice: null,
  link: null,
  organisation: { id: "org_acme", handle: "acmeclimbing", name: "Acme Climbing Club" },
  successor: {
    profile_id: "usr_bob",
    handle: "bobwhite",
    display_name: "Bob White",
    role: "member",
  },
  candidates: [
    { profile_id: "usr_bob", handle: "bobwhite", display_name: "Bob White", role: "member" },
    { profile_id: "usr_carol", handle: "carol_longhandle_29", display_name: null, role: "member" },
  ],
};

const WEDDING: AccountDeletionOpenAction = {
  id: "cire:wedding:w_1",
  app: "cire",
  kind: "wedding_sole_owner",
  label:
    "You are the only owner of “Sam & Alex’s Wedding”. Add another owner in Cire to keep it, or it is deleted when your account is.",
  choices: [
    {
      choice: "delete",
      description:
        "Deleted with its guests, replies and invite when your account is deleted. Download its guest list and other exports from Cire first if you want a copy. Any other wedding you are the only owner of by then is deleted too.",
      erased_on: 1_796_860_800,
    },
  ],
  default_choice: null,
  link: "https://host.cireweddings.example/#/w/w_1/settings/hosts",
};

const EVENT: AccountDeletionOpenAction = {
  id: "pulse:event:ev_1",
  app: "pulse",
  kind: "events_hosted",
  label: "You host “Sunday Picnic”, starting 6 December 2026.",
  choices: [
    {
      choice: "cancel",
      description:
        "Cancelled when your account is deleted. Its guests see it as cancelled for 14 days; then it is deleted.",
      erased_on: 1_796_256_000,
    },
    {
      choice: "delete",
      description: "Deleted when your account is deleted, with its guest list and messages.",
      erased_on: null,
    },
  ],
  default_choice: "cancel",
  link: null,
};

/** An app's words with no space to break at: 60 characters each. */
const UNBROKEN: AccountDeletionOpenAction = {
  id: "pulse:event:ev_2",
  app: "pulse",
  kind: "events_hosted",
  label: `You host ${"SundayPicnicAtTheBotanicGardens".repeat(2).slice(0, 60)}.`,
  choices: [
    { choice: "cancel", description: "https://pulse.example/e/".padEnd(60, "x"), erased_on: null },
    { choice: "delete", description: "Deleted when your account is deleted.", erased_on: null },
  ],
  default_choice: "cancel",
  link: null,
};

const PHONE_NARROW = { width: 320, height: 1900 };
const PHONE = { width: 390, height: 1900 };
const DESKTOP = { width: 1280, height: 1500 };

type Viewport = typeof PHONE;

async function atViewport({ width, height }: Viewport) {
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

async function painted() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await nextFrame();
  await nextFrame();
  await document.fonts.ready;
}

/** The flow at step 1, inside the shell for the viewport's width. */
async function open(viewport: Viewport) {
  await atViewport(viewport);
  const history = createMemoryHistory();
  history.set({ value: "/settings/delete-account" });
  render(() => (
    <MemoryRouter history={history} root={Layout}>
      <Route path="/settings/delete-account" component={DeleteAccountPage} />
    </MemoryRouter>
  ));
  await (viewport.width < 768 ? topBarChunks() : railChunks());
  await screen.findByRole("heading", { name: "What happens" });
  await painted();
}

const button = (name: string) => screen.getByRole("button", { name });

async function toAnswers() {
  fireEvent.click(button("Continue"));
  await screen.findByRole("heading", { name: "What needs an answer" });
  await waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  await painted();
}

async function toConfirm() {
  fireEvent.click(button("Continue"));
  await screen.findByRole("heading", { name: "Confirm" });
  await painted();
}

/** Nothing on the page scrolls sideways. */
function expectNoSideScroll(viewport: Viewport) {
  expect(document.documentElement.scrollWidth).toBe(viewport.width);
  const main = document.querySelector("main")!;
  expect(main.scrollWidth).toBe(main.clientWidth);
}

function boxHeight(element: Element) {
  return element.getBoundingClientRect().height;
}

/** Paint `layers` bottom-up on a 1px canvas and read back the colour. */
function composite(layers: readonly string[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/** A drawn choice's edge against the card it sits on, as painted. */
function edgeRatio(control: HTMLElement): number {
  const drawn = control.parentElement!.querySelector<HTMLElement>('span[aria-hidden="true"]')!;
  const layers: string[] = [];
  for (let node: Element | null = drawn.parentElement; node; node = node.parentElement) {
    layers.push(getComputedStyle(node).backgroundColor);
  }
  const ground = composite(layers.toReversed());
  return contrastRatio(composite([ground, getComputedStyle(drawn).borderTopColor]), ground)!;
}

/** What an element is painted at: its opacity and every ancestor's, multiplied. */
function shownOpacity(element: Element): number {
  let opacity = 1;
  for (let node: Element | null = element; node; node = node.parentElement) {
    opacity *= Number(getComputedStyle(node).opacity);
  }
  return opacity;
}

async function shot(name: string, viewport: Viewport, theme: "light" | "dark") {
  await painted();
  expectNoSideScroll(viewport);
  await page.screenshot({ path: `${SHOTS}/${name}-${viewport.width}-${theme}.png` });
}

beforeEach(() => {
  mocks.preview
    .mockReset()
    .mockResolvedValue({ open_actions: [ORG, WEDDING, EVENT], could_not_check: [] });
  mocks.deleteAccount.mockReset();
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe("the deletion flow, in the shell", () => {
  it("fits a 320px phone on every step, with touch-sized controls", async () => {
    mocks.preview.mockResolvedValue({
      open_actions: [ORG, WEDDING, EVENT, UNBROKEN],
      could_not_check: [],
    });
    await open(PHONE_NARROW);
    expectNoSideScroll(PHONE_NARROW);
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "What happens" }));
    expect(boxHeight(button("Continue"))).toBe(40);
    expect(boxHeight(button("Download my data"))).toBe(40);

    await toAnswers();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "What needs an answer" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "The member you name becomes the owner." }));
    await painted();
    expectNoSideScroll(PHONE_NARROW);
    expect(boxHeight(button("Continue"))).toBe(40);
    expect(boxHeight(screen.getByRole("link", { name: "Open in Cire" }))).toBe(40);
    expect(
      boxHeight(screen.getByRole("checkbox", { name: "Delete everything" }).closest("label")!),
    ).toBeGreaterThanOrEqual(44);
    for (const radio of screen.getAllByRole("radio")) {
      expect(boxHeight(radio.closest("label")!)).toBeGreaterThanOrEqual(44);
    }

    fireEvent.change(screen.getByLabelText("New owner"), { target: { value: "usr_carol" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Deleted with its guests/ }));
    await toConfirm();
    expect(document.activeElement).toBe(screen.getByLabelText("Your handle"));
    expectNoSideScroll(PHONE_NARROW);
    expect(boxHeight(button("Delete my account"))).toBe(40);
  }, 30_000);

  for (const theme of ["light", "dark"] as const) {
    it(`edges each unchosen choice at 3:1 on its card in ${theme}, and dims it once`, async () => {
      if (theme === "dark") document.documentElement.classList.add("dark");
      await open(PHONE);
      await toAnswers();
      const radio = screen.getByRole("radio", { name: "@bobwhite becomes the owner." });
      const box = screen.getByRole("checkbox", { name: /^Deleted with its guests/ });
      const everything = screen.getByRole("checkbox", { name: "Delete everything" });
      for (const control of [radio, box, everything]) {
        expect(edgeRatio(control)).toBeGreaterThanOrEqual(3);
      }

      fireEvent.click(everything);
      await painted();
      const circle = radio.parentElement!.querySelector('span[aria-hidden="true"]')!;
      expect(shownOpacity(circle)).toBeCloseTo(0.5, 2);
      expect(shownOpacity(screen.getByText("@bobwhite becomes the owner."))).toBeCloseTo(0.5, 2);
      for (const day of screen.getAllByText(/^Deleted on /)) {
        expect(shownOpacity(day)).toBeCloseTo(0.5, 2);
      }
      expect(shownOpacity(screen.getByText(ORG.label))).toBe(1);
    }, 30_000);
  }

  it("draws the step buttons at sm's 32px from md", async () => {
    await open(DESKTOP);
    expect(boxHeight(button("Continue"))).toBe(32);
    await toAnswers();
    expect(boxHeight(button("Continue"))).toBe(32);
    expect(boxHeight(screen.getByRole("link", { name: "Open in Cire" }))).toBe(32);
  }, 30_000);

  for (const viewport of [PHONE, DESKTOP]) {
    for (const theme of ["light", "dark"] as const) {
      it(`draws each step at ${viewport.width}px in ${theme}`, async () => {
        if (theme === "dark") document.documentElement.classList.add("dark");
        await open(viewport);
        await shot("1-what-happens", viewport, theme);

        await toAnswers();
        await shot("2-answers", viewport, theme);
        fireEvent.click(
          screen.getByRole("radio", { name: "The member you name becomes the owner." }),
        );
        fireEvent.change(screen.getByLabelText("New owner"), { target: { value: "usr_carol" } });
        await shot("2-answers-successor", viewport, theme);

        fireEvent.click(screen.getByRole("checkbox", { name: "Delete everything" }));
        await shot("2-delete-everything", viewport, theme);
        fireEvent.click(screen.getByRole("checkbox", { name: "Delete everything" }));

        // Continue with the wedding unanswered marks it.
        fireEvent.click(button("Continue"));
        expect(screen.getByText("Choose what happens to this.")).toBeTruthy();
        await shot("2-unanswered", viewport, theme);

        fireEvent.click(screen.getByRole("checkbox", { name: /Deleted with its guests/ }));
        await toConfirm();
        await shot("3-confirm", viewport, theme);

        fireEvent.input(screen.getByLabelText("Your handle"), { target: { value: "alicia" } });
        fireEvent.click(button("Delete my account"));
        await screen.findByText("The handle you typed doesn't match. Check it and try again.");
        await shot("3-handle-mismatch", viewport, theme);
      }, 30_000);

      it(`draws the refusals at ${viewport.width}px in ${theme}`, async () => {
        if (theme === "dark") document.documentElement.classList.add("dark");
        mocks.preview.mockResolvedValueOnce({ open_actions: [EVENT], could_not_check: [] });
        mocks.deleteAccount
          .mockRejectedValueOnce(
            new AccountDeletionRefusedError(409, "open_actions", { openActions: [WEDDING] }),
          )
          .mockRejectedValueOnce(
            new AccountDeletionRefusedError(409, "could_not_check", {
              preview: { open_actions: [EVENT, WEDDING], could_not_check: ["pulse", "zap"] },
            }),
          );
        await open(viewport);
        await toAnswers();
        await toConfirm();
        fireEvent.input(screen.getByLabelText("Your handle"), { target: { value: "alice" } });
        fireEvent.click(button("Delete my account"));
        await screen.findByText("Answer the items marked below before you go on.");
        expect(
          within(document.querySelector("[data-marked]")!).getByText(
            "Choose what happens to this.",
          ),
        ).toBeTruthy();
        await shot("2-refused-open-actions", viewport, theme);

        fireEvent.click(screen.getByRole("checkbox", { name: /Deleted with its guests/ }));
        await toConfirm();
        fireEvent.click(button("Delete my account"));
        await screen.findByText(/Pulse and Zap didn't answer/);
        expect(button("Continue").hasAttribute("disabled")).toBe(true);
        await shot("2-could-not-check", viewport, theme);
      }, 30_000);
    }
  }
});
