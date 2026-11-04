import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";
import { StatusDot, StatusMark, type MarkTone } from "../../src/components/StatusMark";

/**
 * A reply's glyph sits in the middle of its circle as painted. Layout cannot
 * show it: a circle drawn as a box's background snaps to the pixel grid while
 * a glyph drawn as an SVG inside it does not, so at a fractional position —
 * which a row of text puts a mark at as often as not — the two part by up to
 * half a pixel, and the box geometry still reads centred. So this paints each
 * reply at each of its three sizes at four sub-pixel offsets, screenshots it
 * at 1×, and finds the circle's centre and the glyph's centre in the pixels:
 * the circle from how far each pixel is from the page, the glyph from how far
 * it is from the circle's own fill. The pictures stay in `__screenshots__/`.
 */

afterEach(cleanup);

const TONES: readonly MarkTone[] = ["yes", "no", "maybe"];
const OFFSETS = ["0px", "0.25px", "0.5px", "0.75px"] as const;

type Rgb = readonly [number, number, number];

const distance = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A colour as painted, read back from a 1px canvas. */
function rgbOf(color: string): Rgb {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0]!, d[1]!, d[2]!];
}

/** A screenshot's pixels, decoded in the page. */
async function pixels(base64: string) {
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;
  const at = (x: number, y: number): Rgb => {
    const i = (y * image.width + x) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!];
  };
  return { width: image.width, height: image.height, at };
}

type Pixels = Awaited<ReturnType<typeof pixels>>;

/** The weighted centre of `weight` over the image, in pixels. */
function centre(img: Pixels, weight: (rgb: Rgb) => number): { x: number; y: number } {
  let sum = 0;
  let x = 0;
  let y = 0;
  for (let j = 0; j < img.height; j += 1) {
    for (let i = 0; i < img.width; i += 1) {
      const w = weight(img.at(i, j));
      sum += w;
      x += w * (i + 0.5);
      y += w * (j + 0.5);
    }
  }
  return { x: x / sum, y: y / sum };
}

/** The circle's own fill: the commonest colour far from the page. */
function fillOf(img: Pixels, ground: Rgb): Rgb {
  const counts = new Map<string, { rgb: Rgb; n: number }>();
  for (let j = 0; j < img.height; j += 1) {
    for (let i = 0; i < img.width; i += 1) {
      const rgb = img.at(i, j);
      if (distance(rgb, ground) < 40) continue;
      const key = rgb.join(",");
      const seen = counts.get(key) ?? { rgb, n: 0 };
      seen.n += 1;
      counts.set(key, seen);
    }
  }
  return [...counts.values()].reduce((a, b) => (b.n > a.n ? b : a)).rgb;
}

function Marks(props: { tone: MarkTone; offset: string }) {
  return (
    <div class="bg-bg flex items-start gap-3 p-2">
      {(["inline", "stacked", "dot"] as const).map((kind) => (
        <span
          data-kind={kind}
          class="inline-flex"
          style={{
            "padding-top": `calc(0.25rem + ${props.offset})`,
            "padding-left": `calc(0.25rem + ${props.offset})`,
          }}
        >
          {kind === "dot" ? (
            <StatusDot tone={props.tone} />
          ) : (
            <StatusMark tone={props.tone} label="" stacked={kind === "stacked"} />
          )}
        </span>
      ))}
    </div>
  );
}

describe("a reply's glyph", () => {
  it("sits in the middle of its circle as painted, at every size and sub-pixel place", async () => {
    document.documentElement.dataset.theme = "dark";
    const off: object[] = [];
    for (const tone of TONES) {
      for (const offset of OFFSETS) {
        const { container } = render(() => <Marks tone={tone} offset={offset} />);
        const row = container.firstElementChild!;
        const ground = rgbOf(getComputedStyle(row).backgroundColor);
        for (const dot of container.querySelectorAll<HTMLElement>("[data-status-dot]")) {
          const kind = dot.closest<HTMLElement>("[data-kind]")!.dataset.kind!;
          const shot: unknown = await page.screenshot({ element: dot, save: false, base64: true });
          const img = await pixels(
            typeof shot === "string" ? shot : (shot as { base64: string }).base64,
          );
          const fill = fillOf(img, ground);
          const circle = centre(img, (rgb) =>
            Math.min(1, distance(rgb, ground) / distance(fill, ground)),
          );
          const glyph = centre(img, (rgb) => {
            const d = distance(rgb, fill);
            return d > 30 && distance(rgb, ground) > 30 ? d : 0;
          });
          const dx = Math.round((glyph.x - circle.x) * 100) / 100;
          const dy = Math.round((glyph.y - circle.y) * 100) / 100;
          if (Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3) off.push({ tone, kind, offset, dx, dy });
        }
        await page.screenshot({
          path: `__screenshots__/StatusMark.browser.test.tsx/${tone}-${offset}.png`,
          element: row,
        });
        cleanup();
      }
    }
    delete document.documentElement.dataset.theme;
    expect(off).toEqual([]);
  });
});
