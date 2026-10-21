import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * A helper's row gained a second dropdown — what they see on the run sheet — on
 * a line of its own under the name, the role dropdown and Remove. Only a real
 * engine can say every part of the row stays inside it and each dropdown is
 * wide enough to show its value at phone width, with a long handle, and that
 * the question asked before opening the whole run sheet fits a phone. Measured
 * at phone and desktop width, in both ramps. Only a real engine, too, turns an
 * arrow key on a closed select into a pick, so the keyboard case is here.
 *
 * Each case leaves a screenshot under `__screenshots__/` beside this file
 * (gitignored), so a reviewer can look at what was measured.
 *
 * The factories below are written literally: the shared-factory idiom in
 * `test-support/mocks.ts` does not resolve in the browser project.
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

import HostsPanel from "../../src/components/HostsPanel";
import { __resetHostsCache } from "../../src/lib/hosts-store";

const HOSTS = [
  { hostId: "whost_amy", osnProfileId: "usr_amy", handle: "amy", role: "owner", createdAt: 0 },
  {
    hostId: "whost_max",
    osnProfileId: "usr_max",
    handle: "maximiliana_featherstone",
    role: "helper",
    createdAt: 1,
    runSheetScope: "full",
  },
  { hostId: "whost_jo", osnProfileId: "usr_jo", handle: "jo", role: "helper", createdAt: 2 },
  { hostId: "whost_cy", osnProfileId: "usr_cy", handle: "cy", role: "editor", createdAt: 3 },
];

const VIEWPORTS = [
  { name: "phone", width: 375, height: 812 },
  { name: "desktop", width: 1440, height: 900 },
] as const;
const THEMES = ["dark", "light"] as const;

/** Beside this file, in the gitignored `__screenshots__/`. */
const shot = (name: string) => `__screenshots__/HostsPanel.scope.browser.test.tsx/${name}.png`;

const contains = (outer: DOMRect, inner: DOMRect) =>
  inner.left >= outer.left - 0.5 &&
  inner.right <= outer.right + 0.5 &&
  inner.top >= outer.top - 0.5 &&
  inner.bottom <= outer.bottom + 0.5;

/**
 * Is the select wide enough to show the option it has chosen? A select squeezed
 * by its neighbours keeps its box inside the row and shows a bare chevron, so
 * being inside the row is not enough. Measured against the chosen option's text
 * in the select's own font, inside its padding.
 */
function showsItsValue(select: HTMLSelectElement): boolean {
  const style = getComputedStyle(select);
  const probe = document.createElement("span");
  probe.style.font = style.font;
  probe.style.letterSpacing = style.letterSpacing;
  probe.style.position = "absolute";
  probe.style.whiteSpace = "pre";
  probe.textContent = select.selectedOptions[0]?.textContent ?? "";
  document.body.append(probe);
  const text = probe.getBoundingClientRect().width;
  probe.remove();
  const inner =
    select.clientWidth -
    Number.parseFloat(style.paddingLeft) -
    Number.parseFloat(style.paddingRight);
  return inner >= text - 0.5;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  __resetHostsCache();
  authFetch.mockReset();
  authFetch.mockImplementation(async () =>
    json({ hosts: HOSTS, total: HOSTS.length, peopleLimit: null }),
  );
});

afterEach(() => {
  // A `showModal()` dialog sits in the top layer and survives a render
  // cleanup; the next test would mount behind it with its page inert.
  for (const d of document.querySelectorAll("dialog[open]")) (d as HTMLDialogElement).close();
  cleanup();
  delete document.documentElement.dataset.theme;
});

function renderPanel() {
  render(() => (
    // The page gutter a phone gets, so the row has the width it would have.
    <div class="bg-bg text-text @container/panel" style={{ padding: "16px" }}>
      <HostsPanel weddingId="wed_1" callerRole="owner" />
    </div>
  ));
}

describe("a helper's run-sheet scope, painted", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`keeps both dropdowns and Remove inside each helper's row, and the question on screen — ${viewport.name}, ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        renderPanel();
        const scope = (await screen.findByRole("combobox", {
          name: "What @maximiliana_featherstone sees on the run sheet",
        })) as HTMLSelectElement;
        expect(scope.value).toBe("full");

        for (const handle of ["@maximiliana_featherstone", "@jo"]) {
          const row = screen.getByText(handle).closest("li")!;
          const box = row.getBoundingClientRect();
          for (const part of row.querySelectorAll("select, button, span, label")) {
            expect(
              contains(box, part.getBoundingClientRect()),
              `${part.getAttribute("aria-label") || part.textContent} inside ${handle}'s row`,
            ).toBe(true);
          }
          for (const select of row.querySelectorAll("select")) {
            expect(
              showsItsValue(select),
              `${select.getAttribute("aria-label")} shows its value`,
            ).toBe(true);
          }
        }
        // Nothing pushes the page sideways.
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewport.width);
        screen.getByText("@maximiliana_featherstone").closest("ul")!.scrollIntoView({
          block: "center",
        });
        await page.screenshot({ path: shot(`rows-${viewport.name}-${theme}`) });

        const jo = screen.getByRole("combobox", { name: "What @jo sees on the run sheet" });
        fireEvent.change(jo, { target: { value: "full" } });
        const dialog = await screen.findByRole("dialog");
        await Promise.all(dialog.getAnimations({ subtree: true }).map((a) => a.finished));
        const frame = dialog.getBoundingClientRect();
        const screenBox = new DOMRect(0, 0, viewport.width, viewport.height);
        expect(contains(screenBox, frame), "the question inside the screen").toBe(true);
        const confirm = within(dialog).getByRole("button", {
          name: "Yes, show the whole run sheet",
        });
        expect(contains(frame, confirm.getBoundingClientRect())).toBe(true);
        await page.screenshot({ path: shot(`confirm-${viewport.name}-${theme}`) });

        // Nothing has been sent: the list read is the only request.
        expect(authFetch).toHaveBeenCalledTimes(1);
        fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect((jo as HTMLSelectElement).value).toBe("own"));
      });
    }
  }
});

describe("a helper's run-sheet scope, from the keyboard", () => {
  it("keeps focus on the select through the narrowing one arrow key sends, and ignores a key while it is out", async () => {
    await page.viewport(1440, 900);
    const puts: unknown[] = [];
    let answer: () => void = () => {};
    authFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "PUT") {
        return json({ hosts: HOSTS, total: HOSTS.length, peopleLimit: null });
      }
      puts.push(JSON.parse(String(init.body)));
      const host = { osnProfileId: "usr_max", role: "helper", runSheetScope: "own" };
      return new Promise<Response>((resolve) => (answer = () => resolve(json({ host }))));
    });
    renderPanel();
    const scope = (await screen.findByRole("combobox", {
      name: "What @maximiliana_featherstone sees on the run sheet",
    })) as HTMLSelectElement;
    expect(scope.value).toBe("full");
    scope.focus();

    // On a closed select, an arrow key is a pick: up from the whole run sheet
    // is their own tasks, which goes straight out.
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(puts).toEqual([{ scope: "own" }]));
    // Focus stays put, and the write in flight is announced instead.
    expect(document.activeElement).toBe(scope);
    expect(scope.getAttribute("aria-busy")).toBe("true");

    // While it is out, a key sends nothing and asks nothing.
    await userEvent.keyboard("{ArrowDown}");
    expect(scope.value).toBe("own");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(scope);

    answer();
    await waitFor(() => expect(scope.hasAttribute("aria-busy")).toBe(false));
    expect(document.activeElement).toBe(scope);
    expect(scope.value).toBe("own");
    expect(puts).toHaveLength(1);
    await page.screenshot({ path: shot("keyboard-narrowed") });
  });
});
