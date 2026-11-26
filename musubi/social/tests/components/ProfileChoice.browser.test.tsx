import { AuthContext } from "@osn/client/solid";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/App.css";

/**
 * `ProfileChoice` where it ships, in a real browser: `/authorize`'s account
 * screen (an app asked which account, and the account has two profiles) and
 * its profile picker. Each row is a `radio` whose checked state is the
 * choice, moved by a click anywhere in its row or by the arrow keys; the
 * chosen row's edge is ink and the other's the hairline (DESIGN.md §Choices,
 * the owner's D3). Shots at 390 and 1440px, light and dark, go to
 * `__screenshots__/` beside this file.
 */

const contexts = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../../src/lib/authorize", () => ({
  authorizeClient: {
    getContext: () => Promise.resolve(contexts.current),
    submitDecision: () => new Promise(() => {}),
    decline: () => new Promise(() => {}),
  },
}));
vi.mock("../../src/lib/auth", () => ({
  osnAuth: {},
  PRODUCT_NAME: "Musubi",
  TURNSTILE_SITEKEY: undefined,
}));

import { AuthorizePage } from "../../src/pages/AuthorizePage";

const SHOTS = "__screenshots__/ProfileChoice.browser.test.tsx";
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const ada = {
  id: "usr_ada",
  handle: "ada",
  email: "ada@example.com",
  displayName: "Ada Lovelace",
  avatarUrl: null,
};
const work = {
  id: "usr_ada_work",
  handle: "ada_work",
  email: "ada@example.com",
  displayName: null,
  avatarUrl: null,
};

function context(linkedProfileId: string | null) {
  return {
    client: { clientId: "cli_abc", name: "Cire", logoUrl: null, firstParty: false },
    scopes: ["openid", "profile"],
    signedIn: true,
    pendingDeletion: false,
    profiles: [ada, work],
    linkedProfileId,
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
  return { session: resource(null), profiles: resource([]), activeProfileId: () => null };
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

const radios = () => screen.getAllByRole("radio") as HTMLInputElement[];
const checked = () =>
  radios()
    .filter((radio) => radio.checked)
    .map((radio) => radio.value);
const frameOf = (radio: HTMLInputElement) => radio.closest<HTMLElement>("[data-profile-choice]")!;

/** The colour `value` resolves to, read off a probe in the page. */
function resolved(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}

async function settled() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.all(
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)),
  );
}

beforeEach(async () => {
  await page.viewport(DESKTOP.width, DESKTOP.height);
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe.each([
  // The app knows Ada's profile: it is chosen to start.
  ["the account screen", "&reason=select_account", "usr_ada", "Signed in as", ["usr_ada"]],
  // The app knows none: none is chosen until the person picks.
  ["the picker", "", null, "Choose a profile", []],
])("ProfileChoice on %s", (where, search, linked, heading, start) => {
  it("is a radio per profile, checked by the choice, moved by a press anywhere in its row or an arrow key", async () => {
    contexts.current = context(linked);
    renderAt(search);
    await screen.findByRole("heading", { name: heading });
    const group = screen.getByRole("radiogroup", { name: "Profiles" });
    expect(group).toBeTruthy();
    expect(radios().map((radio) => radio.value)).toEqual(["usr_ada", "usr_ada_work"]);
    expect(checked()).toEqual(start);

    // A press in the second row's padding, well clear of its circle and words.
    const second = frameOf(radios()[1]!);
    const box = second.getBoundingClientRect();
    await userEvent.click(second, { position: { x: box.width - 4, y: box.height - 3 } });
    await waitFor(() => expect(checked()).toEqual(["usr_ada_work"]));

    // The arrow keys move the choice back, as a radio group's do.
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(checked()).toEqual(["usr_ada"]));
    // Choosing moved nothing on: the same screen is up.
    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();

    // The chosen row's edge is ink; the other's the hairline.
    await settled();
    const [first, other] = radios().map(frameOf);
    expect(getComputedStyle(first!).borderTopColor).toBe(resolved("var(--foreground)"));
    expect(getComputedStyle(other!).borderTopColor).toBe(resolved("var(--border)"));
    expect(getComputedStyle(first!).borderTopLeftRadius).toBe("8px");

    for (const viewport of [PHONE, DESKTOP]) {
      for (const theme of ["light", "dark"] as const) {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.classList.toggle("dark", theme === "dark");
        await settled();
        expect(document.documentElement.scrollWidth).toBe(viewport.width);
        await page.screenshot({
          path: `${SHOTS}/${where.replace(/\s+/g, "-")}-${viewport.width}-${theme}.png`,
        });
      }
    }
  });
});

describe("a profile's row with a 64-character name and no space", () => {
  const long = { ...work, id: "usr_long", handle: "long_handle", displayName: "W".repeat(64) };

  /** The row's name ends in an ellipsis inside the row, and nothing scrolls sideways. */
  function endsInEllipsis(row: HTMLElement) {
    const name = [...row.querySelectorAll<HTMLElement>("span")].find(
      (span) => span.textContent === long.displayName,
    )!;
    expect(getComputedStyle(name).textOverflow).toBe("ellipsis");
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
    expect(name.getBoundingClientRect().right).toBeLessThanOrEqual(
      row.getBoundingClientRect().right,
    );
    expect(document.documentElement.scrollWidth).toBe(PHONE.width);
  }

  it("ends the name in an ellipsis on the picker's row and consent's, at 390px", async () => {
    await page.viewport(PHONE.width, PHONE.height);
    contexts.current = { ...context(null), profiles: [ada, long] };
    renderAt("");
    await screen.findByRole("heading", { name: "Choose a profile" });
    await settled();
    endsInEllipsis(frameOf(radios()[1]!));
    await page.screenshot({ path: `${SHOTS}/long-name-picker-390.png` });

    await userEvent.click(frameOf(radios()[1]!));
    await waitFor(() => expect(checked()).toEqual(["usr_long"]));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    const change = await screen.findByRole("button", { name: "Change" });
    await settled();
    // Consent's row: the name beside Change, which stays whole.
    const row = change.parentElement!;
    endsInEllipsis(row);
    expect(change.getBoundingClientRect().right).toBeLessThanOrEqual(
      row.getBoundingClientRect().right,
    );
    await page.screenshot({ path: `${SHOTS}/long-name-consent-390.png` });
  });
});
