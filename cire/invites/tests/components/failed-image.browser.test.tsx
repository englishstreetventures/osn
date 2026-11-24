import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";
import { commands, page } from "vitest/browser";

import { EventCard } from "../../src/components/EventCard";
import { InviteClosing } from "../../src/components/InviteClosing";
import type { EventSummary } from "../../src/components/types";

import "../../src/styles/global.css";

/**
 * An event image and a closing image whose request fails, in a real browser:
 * a plain image, and a cropped one drawn as a background, which cannot report
 * a failure itself. Every frame round a failed image goes, so a guest never
 * sees an empty bordered box where a picture was meant to be; the couple's
 * closing note stays.
 *
 * The images are asked of a host this file answers itself (`serveImages`):
 * under `/missing/` with the 404 a key with no stored object gets, anywhere
 * else with a picture. A cropped image that does load keeps its frame, and its
 * probe goes. The two widths are screenshotted into
 * `e2e-artifacts/cire-invites/failed-image/` at the repository root
 * (gitignored).
 */

// Typed accessor for the command registered in `vitest.config.ts`.
const serveImages = (commands as unknown as { serveImages: () => Promise<void> }).serveImages;

const API = "https://images.test";

/** Relative to this file: the repository's `e2e-artifacts/`. */
const SHOTS = "../../../../e2e-artifacts/cire-invites/failed-image";

const VIEWPORTS = [
  { name: "1280", width: 1280, height: 1400 },
  { name: "390", width: 390, height: 1600 },
] as const;

const EVENT: EventSummary = {
  id: "9f7a2c14-1b3d-4e5f-8a01-000000000001",
  name: "Mehndi",
  description: "An evening of henna",
  startAt: "2026-09-18T16:00:00+10:00",
  endAt: "2026-09-18T22:00:00+10:00",
  timezone: "Australia/Sydney",
  address: "12 Banksia Lane, Strathfield",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
  imageUrl: "/missing/event/9f7a2c14/image?v=1",
};

const CROP = { x: 0.1, y: 0.1, w: 0.5, h: 0.5, natW: 1200, natH: 800 };

const noop = () => {};

/** Wait until `done()` holds, polling each frame, or fail after `ms`. */
async function until(done: () => boolean, ms: number): Promise<void> {
  const start = performance.now();
  while (!done()) {
    if (performance.now() - start > ms) return;
    await new Promise((r) => requestAnimationFrame(r));
  }
}

afterEach(cleanup);

for (const viewport of VIEWPORTS) {
  it(`drops every frame round an image that fails to load, at ${viewport.name}`, async () => {
    await page.viewport(viewport.width, viewport.height);
    await serveImages();
    const api = API;
    const { container } = render(() => (
      <div class="flex flex-col gap-8 px-6 py-8">
        <EventCard
          event={EVENT}
          apiUrl={api}
          orientation="norm"
          onRespond={noop}
          onDetails={noop}
        />
        <EventCard
          event={{ ...EVENT, name: "Sangeet", imageCrop: CROP }}
          apiUrl={api}
          orientation="alt"
          onRespond={noop}
          onDetails={noop}
        />
        <InviteClosing
          apiUrl={api}
          imageUrl="/missing/image/footer?v=1"
          imageCrop={CROP}
          message="No boxed gifts, please. Your company is the gift."
        />
      </div>
    ));

    // An event card's picture or cropped frame, and the closing section's
    // band: every child of the section but the note's own block.
    const frames = () =>
      container.querySelectorAll("article img:not([data-image-probe]), article [role='img']")
        .length +
      [...(container.querySelector("[data-invite-closing]")?.children ?? [])].filter(
        (child) => !child.querySelector("p"),
      ).length;
    await until(() => frames() === 0, 3000);
    await page.screenshot({
      path: `${SHOTS}/cards-and-closing-${viewport.name}.png`,
      element: container.firstElementChild as HTMLElement,
    });

    expect(frames()).toBe(0);
    for (const grid of container.querySelectorAll<HTMLElement>("[data-has-image]")) {
      expect(grid.dataset.hasImage).toBe("false");
    }
    expect(container.querySelector("[data-invite-closing]")?.textContent).toContain(
      "No boxed gifts",
    );
  });
}

it("keeps the frame of a cropped image that loads, and lets its probe go", async () => {
  await serveImages();
  const { container } = render(() => (
    <EventCard
      event={{ ...EVENT, imageUrl: "/event/9f7a2c14/image?v=1", imageCrop: CROP }}
      apiUrl={API}
      onRespond={noop}
      onDetails={noop}
    />
  ));
  await until(() => container.querySelector("[data-image-probe]") === null, 3000);

  expect(container.querySelector("[data-image-probe]")).toBeNull();
  expect(container.querySelector("[role='img']")).not.toBeNull();
  expect((container.querySelector("[data-has-image]") as HTMLElement).dataset.hasImage).toBe(
    "true",
  );
});
