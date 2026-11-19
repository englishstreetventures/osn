/**
 * pulse's share sheet under its own stylesheet at a phone width: the title
 * row with its × stays at the top of the sheet, with no line under it. At
 * 390×844 the sheet fits, so nothing is drawn under the row; on a phone short
 * enough that the sheet passes its 85% cap it scrolls under the row, and a
 * 16px fade from pulse's own sheet colour, `--card`, sits there once the
 * destinations have passed under it. `@shared/ui`'s
 * `dialog-scroll-edge.browser.test.tsx` holds the rest against its test
 * palette; this holds that pulse's stylesheet, which maps `--ui-surface` to
 * `--card`, paints the fade in the sheet's colour. Pulse has no dark theme
 * (`pulse/DESIGN.md` §Future), so light only.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { ShareEventButton } from "../../src/components/ShareEventButton";

import "../../src/app.css";

afterEach(() => cleanup());

const shot = (name: string) => `__screenshots__/share-sheet-edge.browser.test.tsx/${name}.png`;

const frames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

/** A colour as this browser writes it once computed, read from a probe that paints it. */
function resolved(colour: string): string {
  const probe = document.createElement("div");
  probe.style.backgroundColor = colour;
  document.body.append(probe);
  const value = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return value;
}

/** Open the share sheet at `width` × `height`, its rise finished. */
async function open(width: number, height: number) {
  await page.viewport(width, height);
  render(() => <ShareEventButton eventId="evt_1" eventTitle="Picnic" />);
  await userEvent.click(screen.getByRole("button", { name: "Share event" }));
  const sheet = await vi.waitFor(() => screen.getByRole("dialog", { name: "Share event" }));
  const timed = document.getAnimations().filter((a) => a.timeline instanceof DocumentTimeline);
  await Promise.all(timed.map((a) => a.finished.catch(() => undefined)));
  await frames();
  const header = screen.getByRole("heading", { name: "Share event" }).parentElement!;
  return { sheet, header, band: () => getComputedStyle(header, "::after") };
}

it("draws no line and no fade under the title row when the sheet fits", async () => {
  const { sheet, header, band } = await open(390, 844);
  expect(sheet.scrollHeight).toBeLessThanOrEqual(sheet.clientHeight);
  expect(getComputedStyle(header).position).toBe("sticky");
  expect(getComputedStyle(header).borderBottomColor).toBe("rgba(0, 0, 0, 0)");
  expect(Number(band().opacity)).toBe(0);
  await page.screenshot({ path: shot("390x844") });
});

it("keeps the title row and its × in place on a short phone, the fade in pulse's sheet colour", async () => {
  const { sheet, header, band } = await open(390, 844);
  // A window whose 85% cap is 48px short of the sheet's own height.
  await page.viewport(390, Math.floor((sheet.getBoundingClientRect().height - 48) / 0.85));
  await frames();
  expect(sheet.scrollHeight - sheet.clientHeight).toBeGreaterThan(16);
  expect(Number(band().opacity)).toBe(0);

  sheet.scrollTop = sheet.scrollHeight;
  await frames();
  const top = sheet.getBoundingClientRect().top + sheet.clientTop;
  expect(Math.abs(header.getBoundingClientRect().top - top)).toBeLessThanOrEqual(0.5);
  const close = screen.getByRole("button", { name: "Close" }).getBoundingClientRect();
  expect(close.top).toBeGreaterThanOrEqual(top);
  expect(close.bottom).toBeLessThanOrEqual(header.getBoundingClientRect().bottom);
  expect(Number(band().opacity)).toBe(1);
  // pulse's `--card`, `oklch(1 0 0)` in `app.css`, written out here so that
  // losing or moving pulse's `--ui-surface` mapping fails this case, as the
  // contract's fallback grey would otherwise paint both the sheet and the fade.
  const card = resolved("oklch(1 0 0)");
  expect(getComputedStyle(sheet).backgroundColor).toBe(card);
  expect(band().backgroundImage).toBe(`linear-gradient(${card}, rgba(0, 0, 0, 0))`);
  await page.screenshot({ path: shot("390-short-end") });
});
