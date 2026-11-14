import { AuthHeader } from "@osn/auth-ui/AuthHeader";
import { Button } from "@shared/ui/ui/button";
import { Dialog } from "@shared/ui/ui/dialog";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { ResponsiveDialogContent } from "../../src/components/ResponsiveDialogContent";

import "../../src/App.css";

/**
 * `@osn/auth-ui`'s `AuthHeader`, the title row of the sign-in and
 * create-account views, in Musubi's type and colours, in a real browser.
 *
 * In a dialog it is the sheet's `DialogHeader` holding its `DialogTitle`; on a
 * page (`/authorize`) it is an `h2` with `DialogTitle`'s classes copied, so the
 * title reads the same in both hosts. Whether the copy still matches, whether a
 * long title wraps instead of widening a 320px sheet, and how tall Cancel is
 * below `md` are all computed style and layout, which the package's happy-dom
 * tests cannot see (`osn/auth-ui/DESIGN.md` §3, §4).
 */

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

/** Relative to this file: the repository's `e2e-artifacts/`. */
const SHOTS = "../../../../e2e-artifacts/musubi-auth-header";

/** A product name with no space in it, so only a break inside a word keeps it in. */
const LONG_TITLE = "Create your MusubiForOrganisationsAndCommunities account";

/**
 * Waits for every animation that ends: the card's entry fade or, below `md`,
 * the sheet's rise over `--ui-dur-slow`, and its scrim's. A read of where the
 * sheet sits must wait for it, since below `md` it starts its own height below
 * the bottom edge.
 */
async function settle() {
  const ending = document
    .getAnimations()
    .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? 0));
  await Promise.all(ending.map((a) => a.finished.catch(() => {})));
}

/** Musubi's sign-in sheet, as `AuthDialogs` opens it, with a view's root `div` inside. */
function renderDialogHost(title: string) {
  render(() => (
    <Dialog open onOpenChange={() => {}}>
      <ResponsiveDialogContent>
        <div>
          <AuthHeader host="dialog" title={title} onCancel={() => {}} />
        </div>
      </ResponsiveDialogContent>
    </Dialog>
  ));
}

/** `/authorize`'s column (`AuthorizePage`'s `main`), holding a create-account view's header. */
function PageHost(props: { title: string }) {
  return (
    <main data-testid="column" class="mx-auto w-full max-w-md px-6 py-10">
      <AuthHeader
        host="page"
        title={props.title}
        cancelLabel="Sign in instead"
        onCancel={() => {}}
      />
    </main>
  );
}

const THEMES = ["light", "dark"] as const;

function setTheme(theme: (typeof THEMES)[number]) {
  // Set before the render, never on a drawn page: a button's colour transition
  // would be read half way.
  document.documentElement.classList.toggle("dark", theme === "dark");
}

describe("AuthHeader in Musubi's sheet", () => {
  it.each(THEMES)(
    "wraps a long title beside Cancel at 320px, inside the sheet (%s)",
    async (theme) => {
      setTheme(theme);
      await page.viewport(320, 640);
      renderDialogHost(LONG_TITLE);
      const sheet = await waitFor(() => screen.getByRole("dialog", { name: LONG_TITLE }));
      await settle();

      expect(sheet.getBoundingClientRect().width).toBeCloseTo(320, 1);
      expect(sheet.scrollWidth).toBeLessThanOrEqual(sheet.clientWidth);

      const cancel = within(sheet).getByRole("button", { name: "Cancel" });
      const heading = within(sheet).getByRole("heading", { level: 2, name: LONG_TITLE });
      const button = cancel.getBoundingClientRect();
      // 40px below `md`, never squeezed by the title, inside the header's 16px padding.
      expect(button.height).toBeCloseTo(40, 0);
      expect(cancel.scrollWidth).toBeLessThanOrEqual(cancel.clientWidth);
      expect(button.right).toBeLessThanOrEqual(sheet.getBoundingClientRect().right - 16 + 0.5);
      // The title breaks onto more lines instead of running under Cancel.
      expect(heading.getBoundingClientRect().right).toBeLessThanOrEqual(button.left);
      await page.screenshot({ path: `${SHOTS}/dialog-long-title-320-${theme}.png` });
    },
  );
});

describe("AuthHeader on /authorize's column", () => {
  it.each(THEMES)(
    "wraps a long title beside 'Sign in instead' at 320px, with nothing scrolling sideways (%s)",
    async (theme) => {
      setTheme(theme);
      await page.viewport(320, 640);
      render(() => <PageHost title={LONG_TITLE} />);
      const column = screen.getByTestId("column");
      const cancel = screen.getByRole("button", { name: "Sign in instead" });
      const heading = screen.getByRole("heading", { level: 2, name: LONG_TITLE });

      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        document.documentElement.clientWidth,
      );
      const button = cancel.getBoundingClientRect();
      expect(button.height).toBeCloseTo(40, 0);
      expect(cancel.scrollWidth).toBeLessThanOrEqual(cancel.clientWidth);
      // Inside the column's 24px padding: the row draws none of its own.
      expect(button.right).toBeLessThanOrEqual(column.getBoundingClientRect().right - 24 + 0.5);
      expect(heading.getBoundingClientRect().right).toBeLessThanOrEqual(button.left);
      await page.screenshot({ path: `${SHOTS}/page-long-title-320-${theme}.png` });
    },
  );
});

describe("AuthHeader's two hosts", () => {
  it.each(THEMES)("draw the title in the same type and colour, 14px at 500 (%s)", async (theme) => {
    setTheme(theme);
    await page.viewport(1440, 900);
    render(() => (
      <>
        <PageHost title="Sign in to Musubi" />
        <Dialog open onOpenChange={() => {}}>
          <ResponsiveDialogContent>
            <div>
              <AuthHeader host="dialog" title="Sign in to Musubi" onCancel={() => {}} />
            </div>
          </ResponsiveDialogContent>
        </Dialog>
      </>
    ));
    const sheet = await waitFor(() => screen.getByRole("dialog", { name: "Sign in to Musubi" }));
    const inDialog = within(sheet).getByRole("heading", { level: 2 });
    // The open modal dialog hides the rest of the page from the accessibility tree.
    const onPage = within(screen.getByTestId("column")).getByRole("heading", {
      level: 2,
      hidden: true,
    });

    const type = (element: Element) => {
      const style = getComputedStyle(element);
      return {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        color: style.color,
      };
    };
    expect(type(onPage)).toEqual(type(inDialog));
    expect(type(inDialog)).toMatchObject({ fontSize: "14px", fontWeight: "500" });
  });

  it.each(THEMES)(
    "draw Cancel as a secondary Button in a dialog and a ghost one on a page (%s)",
    async (theme) => {
      setTheme(theme);
      await page.viewport(1440, 900);
      render(() => (
        <>
          <PageHost title="Create your Musubi account" />
          {/* Probes: the two variants as any call site draws them. */}
          <Button variant="secondary" size="sm">
            Probe secondary
          </Button>
          <Button variant="ghost" size="sm">
            Probe ghost
          </Button>
          <Dialog open onOpenChange={() => {}}>
            <ResponsiveDialogContent>
              <div>
                <AuthHeader host="dialog" title="Sign in to Musubi" onCancel={() => {}} />
              </div>
            </ResponsiveDialogContent>
          </Dialog>
        </>
      ));
      const sheet = await waitFor(() => screen.getByRole("dialog", { name: "Sign in to Musubi" }));
      const look = (element: Element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          color: style.color,
          borderTopColor: style.borderTopColor,
          borderTopWidth: style.borderTopWidth,
        };
      };
      // The open modal dialog hides the rest of the page from the accessibility tree.
      const outside = (name: string) => screen.getByRole("button", { name, hidden: true });
      const secondary = look(outside("Probe secondary"));
      const ghost = look(outside("Probe ghost"));
      // The two variants differ at rest, or the checks below prove nothing.
      expect(secondary.backgroundColor).not.toBe(ghost.backgroundColor);

      expect(look(within(sheet).getByRole("button", { name: "Cancel" }))).toEqual(secondary);
      expect(look(outside("Sign in instead"))).toEqual(ghost);
    },
  );
});
