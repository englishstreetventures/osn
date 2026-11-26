import { AuthorizeError } from "@osn/client";
import { AuthContext } from "@osn/client/solid";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/App.css";

/**
 * `/authorize` as one layout, screen by screen, in a real browser: each
 * screen that decides draws its one notice slot directly above its actions,
 * holds one Cancel (none on the sign-in screen until its Decline, #2048), and
 * leads with the app's name as an `h1` larger than every other heading (the
 * owner's D2). Each screen's notice is raised the way the page raises it: a
 * decision that fails, drawn in the danger ink, or one that asks for a fresh
 * sign-in, drawn in the info tone's secondary ink. Shots at 390 and 1440px,
 * light and dark, go to `__screenshots__/` beside this file.
 */

const api = vi.hoisted(() => ({
  context: null as unknown,
  submitDecision: (() => Promise.resolve({ redirectTo: "" })) as (body: unknown) => Promise<{
    redirectTo: string;
  }>,
}));

vi.mock("../../src/lib/authorize", () => ({
  authorizeClient: {
    getContext: () => Promise.resolve(api.context),
    submitDecision: (body: unknown) => api.submitDecision(body),
    decline: () => new Promise(() => {}),
  },
}));
vi.mock("../../src/lib/auth", () => ({
  osnAuth: {},
  PRODUCT_NAME: "Musubi",
  TURNSTILE_SITEKEY: undefined,
}));
// The panel's provider bootstraps a session over the network; the page's own
// context below stands in for it.
vi.mock("@osn/client/solid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@osn/client/solid")>()),
  AuthProvider: (props: { children: unknown }) => props.children,
}));
vi.mock("../../src/lib/authClients", () => ({
  // Sign-in starts the autofill ceremony on mount; it waits here for ever.
  loginClient: { passkeyBegin: () => new Promise(() => {}) },
  recoveryClient: {},
  registrationClient: { checkHandle: () => Promise.resolve({ available: true }) },
}));
vi.mock("../../src/lib/webauthn-registration-deferred", () => ({
  runPasskeyRegistrationDeferred: () => {},
}));

import { AuthorizePage } from "../../src/pages/AuthorizePage";

const SHOTS = "__screenshots__/AuthorizeScreens.browser.test.tsx";
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const ada = {
  id: "usr_ada",
  handle: "ada",
  email: "ada@example.com",
  displayName: "Ada Lovelace",
  avatarUrl: null,
};
const work = { ...ada, id: "usr_ada_work", handle: "ada_work", displayName: null };

function context(overrides: Record<string, unknown> = {}) {
  return {
    client: { clientId: "cli_abc", name: "Cire", logoUrl: null, firstParty: false },
    scopes: ["openid", "profile", "email"],
    signedIn: true,
    pendingDeletion: false,
    profiles: [ada],
    linkedProfileId: null,
    ...overrides,
  };
}

function authValue() {
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
    profiles: resource([]),
    activeProfileId: () => null,
    adoptSession: () => Promise.resolve(),
  };
}

function renderAt(search: string) {
  const history = createMemoryHistory();
  history.set({ value: `/authorize?request=oar_0123456789ab${search}` });
  render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
    <AuthContext.Provider value={authValue() as any}>
      <MemoryRouter history={history}>
        <Route path="/authorize" component={AuthorizePage} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
}

/** A decision that fails without ending the request: the copy map's sentence. */
const failing = () => Promise.reject(new AuthorizeError("rate_limited", 429, "Too many attempts."));

async function settled() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await document.fonts.ready;
  await Promise.all(
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)),
  );
}

const px = (element: Element) => parseFloat(getComputedStyle(element).fontSize);

/** The colour `value` resolves to, read off a probe in the page. */
function resolved(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}

/** The ink each notice tone draws its words in. */
const INK = {
  danger: "var(--color-ui-danger)",
  info: "var(--color-ui-ink-secondary)",
} as const;

type Screen = {
  name: string;
  search: string;
  context: Record<string, unknown>;
  /** Raises the screen's notice the way the page does. */
  raise: () => Promise<void>;
  /** On screen once the notice is up. */
  ready: () => HTMLElement;
  cancels: number;
  /** The notice's tone: a failure is `danger`, a request to sign in again `info`. */
  tone: keyof typeof INK;
  /** What follows the notice: the last of the actions, or the panel's heading. */
  after: (next: HTMLElement) => string | null | undefined;
  expectedAfter: string;
};

const lastButton = (next: HTMLElement) => [...next.querySelectorAll("button")].at(-1)?.textContent;

const SCREENS: Screen[] = [
  {
    name: "account",
    search: "&reason=select_account",
    context: { profiles: [ada, work], linkedProfileId: "usr_ada" },
    raise: async () => {
      api.submitDecision = failing;
      await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    },
    ready: () => screen.getByRole("heading", { name: "Signed in as" }),
    cancels: 1,
    tone: "danger",
    after: lastButton,
    expectedAfter: "Cancel",
  },
  {
    name: "picker",
    search: "",
    context: { profiles: [ada, work] },
    raise: async () => {
      api.submitDecision = failing;
      await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    },
    ready: () => screen.getByRole("heading", { name: "Choose a profile" }),
    cancels: 1,
    tone: "danger",
    after: lastButton,
    expectedAfter: "Cancel",
  },
  {
    name: "consent",
    search: "",
    context: {},
    raise: async () => {
      api.submitDecision = failing;
      await userEvent.click(await screen.findByRole("button", { name: "Allow" }));
    },
    ready: () => screen.getByRole("button", { name: "Allow" }),
    cancels: 1,
    tone: "danger",
    after: lastButton,
    expectedAfter: "Cancel",
  },
  {
    name: "sign-in",
    search: "",
    context: {},
    // A decision that asks for a fresh sign-in brings the sign-in screen up
    // with "Please sign in again to continue."
    raise: async () => {
      api.submitDecision = () =>
        Promise.reject(new AuthorizeError("login_required", 400, "Re-authentication required"));
      await userEvent.click(await screen.findByRole("button", { name: "Allow" }));
    },
    ready: () => screen.getByRole("heading", { name: "Sign in to Musubi" }),
    cancels: 0,
    tone: "info",
    after: (next) => next.querySelector("h2")?.textContent,
    expectedAfter: "Sign in to Musubi",
  },
];

beforeEach(async () => {
  await page.viewport(DESKTOP.width, DESKTOP.height);
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe.each(SCREENS)("/authorize's $name screen", (where) => {
  it("draws its notice in its tone above its actions, one Cancel, and the app's name as the largest heading", async () => {
    api.context = context(where.context);
    renderAt(where.search);
    await where.raise();
    await waitFor(() => expect(where.ready()).toBeTruthy());
    const notice = await screen.findByRole("alert");

    // The slot sits directly above the screen's actions: on the sign-in
    // screen, the panel; elsewhere, the column of buttons, Cancel last.
    const after = notice.nextElementSibling as HTMLElement;
    expect(after).not.toBeNull();
    expect(where.after(after)).toBe(where.expectedAfter);
    expect(screen.queryAllByRole("button", { name: "Cancel" })).toHaveLength(where.cancels);

    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Cire");
    // The consent screen has no heading but the app's name.
    const others = screen.getAllByRole("heading").filter((heading) => heading !== h1);
    for (const heading of others) expect(px(h1)).toBeGreaterThan(px(heading));

    for (const viewport of [PHONE, DESKTOP]) {
      for (const theme of ["light", "dark"] as const) {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.classList.toggle("dark", theme === "dark");
        await settled();
        expect(document.documentElement.scrollWidth).toBe(viewport.width);
        // The two inks differ in each theme, so the tone is what decides.
        expect(resolved(INK.danger)).not.toBe(resolved(INK.info));
        expect(getComputedStyle(notice).color).toBe(resolved(INK[where.tone]));
        await page.screenshot({ path: `${SHOTS}/${where.name}-${viewport.width}-${theme}.png` });
      }
    }
  });
});
