import { AuthContext } from "@osn/client/solid";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/App.css";
import { AccountMenu } from "../../src/components/AccountMenu";

/**
 * The account menu's profile rows with the names that are hardest to draw, in
 * a real browser: two initials in the row's 20px circle, and a name with no
 * space in it in a row of the 240px panel at 390px. Shots go to
 * `__screenshots__/` beside this file.
 */

const SHOTS = "__screenshots__/AccountMenu.browser.test.tsx";

type Face = { id: string; handle: string; displayName: string | null; avatarUrl: null };

const face = (id: string, handle: string, displayName: string | null): Face => ({
  id,
  handle,
  displayName,
  avatarUrl: null,
});

function authValue(profiles: Face[]) {
  const resource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: value,
      refetch: () => {},
      mutate: () => {},
    });
  const claims = btoa(JSON.stringify({ sub: profiles[0]!.id, handle: profiles[0]!.handle }));
  return {
    session: resource({ accessToken: `e30.${claims}.sig`, expiresAt: Date.now() + 300_000 }),
    profiles: resource(profiles),
    activeProfileId: () => profiles[0]!.id,
    logout: () => Promise.resolve(),
    switchProfile: () => new Promise(() => {}),
  };
}

async function openMenu(profiles: Face[]) {
  render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
    <AuthContext.Provider value={authValue(profiles) as any}>
      <div class="p-4">
        <AccountMenu triggerLabel="Account menu">
          <span>Open</span>
        </AccountMenu>
      </div>
    </AuthContext.Provider>
  ));
  await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
  await waitFor(() => expect(screen.getAllByRole("menuitemradio")).toHaveLength(profiles.length));
  await document.fonts.ready;
}

beforeEach(async () => {
  await page.viewport(390, 844);
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe("the account menu's profile rows", () => {
  // Two characters at the smallest type step (12px) overflow a 20px circle:
  // "MW" is 22.4px wide and "WW" 23.6px, and "山田" and two joined emoji
  // wrap onto two 18px lines. The menu's circle takes the first one alone.
  it("fit the initials inside the 20px circle, on one line", async () => {
    const names = ["MW", "WW", "山田", "👩‍🚀👨‍🚀"];
    await openMenu(names.map((name, i) => face(`usr_${i}`, `p${i}`, name)));

    const drawn = screen.getAllByRole("menuitemradio").map((row) => {
      const circle = row.querySelector<HTMLElement>("[aria-hidden='true']")!;
      const range = document.createRange();
      range.selectNodeContents(circle.firstElementChild!);
      return {
        initials: circle.textContent,
        circle: circle.getBoundingClientRect(),
        lines: [...range.getClientRects()],
      };
    });
    expect(drawn.map((d) => d.initials)).toEqual(["M", "W", "山", "👩‍🚀"]);
    for (const d of drawn) {
      expect(d.circle.width, `${d.initials}'s circle`).toBe(20);
      expect(d.lines, `${d.initials} on one line`).toHaveLength(1);
      expect(d.lines[0]!.width, `${d.initials} as wide as its circle at most`).toBeLessThanOrEqual(
        d.circle.width,
      );
      expect(d.lines[0]!.left).toBeGreaterThanOrEqual(d.circle.left);
      expect(d.lines[0]!.right).toBeLessThanOrEqual(d.circle.right);
    }
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      await page.screenshot({ path: `${SHOTS}/initials-390-${theme}.png` });
    }
  });

  it("end a 64-character name with no space in an ellipsis, with nothing scrolling sideways", async () => {
    const long = "W".repeat(64);
    await openMenu([face("usr_ada", "ada", "Ada"), face("usr_long", "long_handle", long)]);

    const row = screen.getAllByRole("menuitemradio")[1]!;
    const name = [...row.querySelectorAll<HTMLElement>("span")].find((span) =>
      span.textContent?.startsWith(long),
    )!;
    expect(getComputedStyle(name).textOverflow).toBe("ellipsis");
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
    expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(
      screen.getByRole("menu").getBoundingClientRect().right,
    );
    expect(document.documentElement.scrollWidth).toBe(390);
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      await page.screenshot({ path: `${SHOTS}/long-name-390-${theme}.png` });
    }
  });
});
