import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * Settings › Export, as painted, at a phone and a desktop width in both themes
 * (`DESIGN.md` §7, "The whole wedding as one download").
 *
 * Three guarantees only a stylesheet and a layout engine can give:
 *
 * - every notice is no wider than the prose measure, so the saved line, a
 *   failure and the non-owner's note read as one column, not a band;
 * - the panel never scrolls sideways, even with the longest file name a slug
 *   can make (60 letters, no hyphen, so no place to break);
 * - every word clears 4.5:1 on what it sits on, the accent link in the info
 *   notice on the card included, and the delete dialog's link on the raised
 *   `Modal` plane.
 */

const state = vi.hoisted(() => ({ value: { phase: "idle" } as unknown }));
vi.mock("../../src/lib/wedding-archive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/wedding-archive")>()),
  weddingArchiveState: () => () => state.value,
}));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch: vi.fn() }) }));
vi.mock("../../src/lib/touch-feedback", () => ({ haptic: () => {} }));

import DeleteWeddingDialog from "../../src/components/DeleteWeddingDialog";
import WeddingExport from "../../src/components/WeddingExport";

const THEMES = ["light", "dark"] as const;
const WIDTHS = [390, 1280] as const;
/** The longest slug `slugifyDisplayName` makes: 60 letters, nothing to break at. */
const LONG_SLUG = "a".repeat(60);

type Case = { name: string; canManage: boolean; state: unknown };
const CASES: readonly Case[] = [
  {
    name: "ready",
    canManage: true,
    state: { phase: "ready", fileName: `cire-wedding-${LONG_SLUG}.zip`, size: 4_200_000 },
  },
  ...(["forbidden", "notFound", "limit", "server", "network", "cut"] as const).map((reason) => ({
    name: `failed, ${reason}`,
    canManage: true,
    state: { phase: "failed", reason },
  })),
  { name: "not an owner", canManage: false, state: { phase: "idle" } },
  { name: "preparing", canManage: true, state: { phase: "preparing", received: 4_200_000 } },
];

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

/** Paint `layers` bottom-up on a 1px canvas and read back plain `rgb`. */
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

/** What `element` paints its word over: the page ground, then every background
 *  from the outermost ancestor in, its own last. */
function backdropOf(element: Element): string {
  const layers: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    layers.push(getComputedStyle(node).backgroundColor);
  }
  const ground = getComputedStyle(document.documentElement).getPropertyValue("--bg");
  return composite([ground, ...layers.toReversed()]);
}

function ratioOf(element: Element): number {
  const under = backdropOf(element);
  return contrastRatio(composite([under, getComputedStyle(element).color]), under)!;
}

/** Every element in `root` that holds words of its own, with its ratio. */
function wordRatios(root: Element): [string, number][] {
  const out: [string, number][] = [];
  for (const el of root.querySelectorAll("*")) {
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent!.trim())
      .join(" ")
      .trim();
    if (own) out.push([own.slice(0, 40), Math.round(ratioOf(el) * 100) / 100]);
  }
  return out;
}

const sizes = (el: Element) => Math.round(el.getBoundingClientRect().width * 10) / 10;

function mount(c: Case) {
  state.value = c.state;
  return render(() => (
    <div class="p-4">
      <WeddingExport
        weddingId="wed_1"
        weddingSlug={LONG_SLUG}
        canManage={c.canManage}
        coHosts={{ href: "#/w/wed_1/settings/hosts", onOpen: () => {} }}
      />
    </div>
  ));
}

/** The loader pulses; read it at rest. */
async function still() {
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    describe(`Settings › Export, ${width}px, ${theme}`, () => {
      for (const c of CASES) {
        it(`${c.name}: notices stay in the prose measure, the panel stays put, words read`, async () => {
          document.documentElement.dataset.theme = theme;
          await page.viewport(width, 900);
          const { container } = mount(c);
          // The loader's line pulses; its words are read at rest.
          for (const a of document.getAnimations()) a.cancel();

          const panel = container.firstElementChild!.firstElementChild as HTMLElement;
          const notices = c.canManage
            ? [...panel.querySelectorAll("[role='alert'], [role='status'] > div")]
            : [panel.children[1]!];
          expect(notices.length, `${c.name} notices`).toBe(c.name === "preparing" ? 0 : 1);
          for (const notice of notices) {
            // The notice, or the region it sits in, carries the prose cap; the
            // notice is no wider than the box that carries it.
            const cap = [notice, notice.parentElement!].find(
              (el) => getComputedStyle(el).maxWidth !== "none",
            );
            expect(cap, `${c.name} notice has a prose cap`).toBeDefined();
            expect(sizes(notice), `${c.name} notice width`).toBeLessThanOrEqual(sizes(cap!) + 0.5);
            expect(
              notice.getBoundingClientRect().right,
              `${c.name} notice edge`,
            ).toBeLessThanOrEqual(innerWidth);
          }
          expect(panel.scrollWidth, `${c.name} panel scrollWidth vs clientWidth`).toBe(
            panel.clientWidth,
          );

          const low = wordRatios(panel).filter(([, r]) => r < WCAG_TEXT_MIN);
          expect([c.name, low]).toEqual([c.name, []]);
        });
      }

      it("ready: the saved line reads as a sentence, the file name whole", async () => {
        document.documentElement.dataset.theme = theme;
        await page.viewport(width, 900);
        mount(CASES[0]!);
        expect(screen.getByRole("status", { name: "Wedding downloaded" }).textContent).toContain(
          `Downloaded cire-wedding-${LONG_SLUG}.zip (4.2\u00a0MB).`,
        );
      });

      it("not an owner: the Co-hosts link in the info notice reads on the card", async () => {
        document.documentElement.dataset.theme = theme;
        await page.viewport(width, 900);
        mount(CASES.find((c) => c.name === "not an owner")!);
        expect(ratioOf(screen.getByRole("link", { name: "Co-hosts" }))).toBeGreaterThanOrEqual(
          WCAG_TEXT_MIN,
        );
      });

      it("the delete dialog's link reads on the raised Modal plane", async () => {
        document.documentElement.dataset.theme = theme;
        await page.viewport(width, 900);
        render(() => (
          <DeleteWeddingDialog
            weddingId="wed_1"
            slug="ruth-and-vik"
            onDeleted={() => {}}
            exportPage={{ href: "#/w/wed_1/settings/export", onOpen: () => {} }}
          />
        ));
        fireEvent.click(screen.getByRole("button", { name: "Delete wedding…" }));
        const link = await screen.findByRole("link", { name: "Download the whole wedding" });
        await still();
        expect(ratioOf(link)).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
      });
    });
  }
}
