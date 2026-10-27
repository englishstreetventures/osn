import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import type { CropperImage, CropperSelection } from "cropperjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";

import "../../src/styles/global.css";

import ImageCropModal from "../../src/components/ImageCropModal";
import type { ImageCrop } from "../../src/lib/image-crop";

/**
 * The crop editor in real Chromium, with real pointer and wheel input, for what
 * only layout can show: where the crop box opens, how far a drag can take it
 * before the editor refuses the move, and what that costs the page.
 *
 * - A drag of the box reads no layout: the containment check works from image
 *   bounds the editor already holds.
 * - Those bounds follow the image when it zooms, in either direction, so a drag
 *   past the image's edge is refused at the edge the organiser sees.
 * - The box opens over the image, and a saved crop reopens where it was saved,
 *   even while the modal's entry animation is still scaling the dialog and even
 *   when the browser already holds the image.
 * - Nothing the editor adds to `window` outlives it.
 *
 * Fixture: an 800×400 PNG drawn on a canvas, a fresh `blob:` URL per test, in
 * the `hero` slot, whose Original preset is 16:9 — at 1280×900 the image shows
 * at about 622×311 and the box spans its full height with room on both sides.
 * Input goes through CDP, which addresses the test iframe directly because a
 * headless run leaves it unscaled at the page origin.
 *
 * Artifact: `cire/host/.vitest/attachments/image-crop/` — the editor after each
 * refused drag. Same fixture and viewport every run, and every test but the two
 * that need the animation settles it before the image loads, so cropperjs
 * centres the image at full scale and the pictures repeat.
 */

const ARTIFACTS = "../../.vitest/attachments/image-crop";

/** Each drag moves the pointer this many px per event. */
const STEP = 4;
/** The editor's own rounding slack at each edge. */
const EDGE = 1;

const urls: string[] = [];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const url of urls.splice(0)) URL.revokeObjectURL(url);
  for (const el of document.querySelectorAll("[data-held-image]")) el.remove();
});

/** A fresh `blob:` URL of an 800×400 two-tone picture with a grid on it. */
async function fixtureUrl(): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 400;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#c9a27e";
  ctx.fillRect(0, 0, 400, 400);
  ctx.fillStyle = "#3d5a73";
  ctx.fillRect(400, 0, 400, 400);
  ctx.strokeStyle = "#ffffff";
  ctx.beginPath();
  for (let x = 100; x < 800; x += 100) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 400);
  }
  for (let y = 100; y < 400; y += 100) {
    ctx.moveTo(0, y);
    ctx.lineTo(800, y);
  }
  ctx.stroke();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no blob"))), "image/png"),
  );
  const url = URL.createObjectURL(blob);
  urls.push(url);
  return url;
}

function open(imageUrl: string, initialCrop: ImageCrop | null = null) {
  const onSave = vi.fn(async (_crop: ImageCrop) => {});
  render(() => (
    <ImageCropModal
      imageUrl={imageUrl}
      slot="hero"
      initialCrop={initialCrop}
      onSave={onSave}
      onReset={async () => {}}
      onClose={() => {}}
    />
  ));
  const dialog = document.querySelector("dialog");
  if (!dialog) throw new Error("the modal rendered no dialog");
  return { dialog, onSave };
}

/**
 * The dialog's entry transitions. Reading a layout property first flushes the
 * style change that starts them; without it `getAnimations()` comes back empty.
 */
function entryAnimations(dialog: HTMLDialogElement): Animation[] {
  void dialog.offsetHeight;
  return dialog.getAnimations({ subtree: true });
}

/** Jump the entry animation to its end, so the dialog is at full scale. */
function settle(dialog: HTMLDialogElement) {
  for (const animation of entryAnimations(dialog)) animation.finish();
}

/** How much smaller than its own layout box the dialog is drawn. */
const drawnScale = (dialog: HTMLDialogElement) =>
  dialog.getBoundingClientRect().width / dialog.offsetWidth;

const image = () => document.querySelector("cropper-image") as CropperImage;
const selection = () => document.querySelector("cropper-selection") as CropperSelection;
const imageRect = () => image().getBoundingClientRect();
const boxRect = () => selection().getBoundingClientRect();

/**
 * Wait until the editor has opened the crop box and cropperjs has sized and
 * centred the image, which it marks with an inline `transform`.
 */
async function boxOpened() {
  await waitFor(() => {
    expect(selection().width).toBeGreaterThan(0);
    expect(image().style.transform).not.toBe("");
  });
}

const centre = (r: DOMRect) => ({
  x: Math.round(r.left + r.width / 2),
  y: Math.round(r.top + r.height / 2),
});

async function mouse(
  type: "mouseMoved" | "mousePressed" | "mouseReleased",
  at: { x: number; y: number },
) {
  await cdp().send("Input.dispatchMouseEvent", {
    type,
    x: at.x,
    y: at.y,
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: type === "mouseMoved" ? 0 : 1,
  });
}

/** Press at `from`, move right `dx` px in `STEP` px moves, release. */
async function dragRight(from: { x: number; y: number }, dx: number) {
  await mouse("mouseMoved", from);
  await mouse("mousePressed", from);
  for (let moved = STEP; moved <= dx; moved += STEP) {
    await mouse("mouseMoved", { x: from.x + moved, y: from.y });
  }
  await mouse("mouseReleased", { x: from.x + dx, y: from.y });
}

/** One wheel notch at `at`: negative `deltaY` zooms in, positive zooms out. */
async function wheel(at: { x: number; y: number }, deltaY: number) {
  await cdp().send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: at.x,
    y: at.y,
    deltaX: 0,
    deltaY,
  });
}

/** Zoom by one notch over the image's centre and wait for the image to change size. */
async function zoom(deltaY: number) {
  const before = imageRect();
  await wheel(centre(before), deltaY);
  await waitFor(() => expect(Math.abs(imageRect().width - before.width)).toBeGreaterThan(10));
  return { before, after: imageRect() };
}

interface AXNode {
  ignored: boolean;
  role?: { value: string };
}

interface Frame {
  frame: { id: string; url: string };
  childFrames?: Frame[];
}

/** Chrome's accessibility tree for the frame this test runs in. */
async function accessibilityTree(): Promise<AXNode[]> {
  const session = cdp();
  const { frameTree } = (await session.send("Page.getFrameTree")) as { frameTree: Frame };
  const find = (node: Frame): Frame | undefined =>
    node.frame.url === location.href ? node : node.childFrames?.map(find).find(Boolean);
  const own = find(frameTree);
  if (!own) throw new Error(`no frame at ${location.href}`);
  const { nodes } = (await session.send("Accessibility.getFullAXTree", {
    frameId: own.frame.id,
  })) as { nodes: AXNode[] };
  return nodes;
}

/** The box's right edge sits at the image's right edge: within one move, and not past it. */
function expectStoppedAtRightEdge(box: DOMRect, img: DOMRect) {
  expect(box.right).toBeLessThanOrEqual(img.right + EDGE);
  expect(box.right).toBeGreaterThanOrEqual(img.right - STEP - EDGE);
}

describe("ImageCropModal in Chromium", () => {
  it("reads no layout while the box is dragged, refused moves included", async () => {
    await page.viewport(1280, 900);
    const { dialog } = open(await fixtureUrl());
    settle(dialog);
    await boxOpened();
    const startLeft = boxRect().left;
    const from = centre(boxRect());

    const rects = vi.spyOn(Element.prototype, "getBoundingClientRect");
    const styles = vi.spyOn(window, "getComputedStyle");
    // About 34px of room on the right: the first moves land, the rest are refused.
    await dragRight(from, 60);
    const rectReads = rects.mock.calls.length;
    const styleReads = styles.mock.calls.length;
    rects.mockRestore();
    styles.mockRestore();

    expect(boxRect().left).toBeGreaterThan(startLeft + 24);
    expect(rectReads).toBe(0);
    expect(styleReads).toBe(0);
  });

  it("refuses a drag past the image's edge after a zoom in, at the new edge", async () => {
    await page.viewport(1280, 900);
    const { dialog } = open(await fixtureUrl());
    settle(dialog);
    await boxOpened();

    const { before, after } = await zoom(-100);
    expect(after.right).toBeGreaterThan(before.right + 20);

    await dragRight(centre(boxRect()), 200);
    const box = boxRect();
    // Past where the edge was before the zoom, so the bounds followed it.
    expect(box.right).toBeGreaterThan(before.right + STEP + EDGE);
    expectStoppedAtRightEdge(box, after);
    await page.screenshot({ path: `${ARTIFACTS}/zoomed-in-refused.png` });
  });

  it("refuses a drag past the image's edge after a zoom out, at the new edge", async () => {
    await page.viewport(1280, 900);
    const { dialog } = open(await fixtureUrl());
    settle(dialog);
    await boxOpened();

    // Setup: a small box in the middle of the image, so it still fits once the
    // image shrinks. The canvas and the box share one pixel space.
    const canvas = document.querySelector("cropper-canvas")!.getBoundingClientRect();
    const img = imageRect();
    const sel = selection();
    sel.$change(
      img.left - canvas.left + (img.width - 200) / 2,
      img.top - canvas.top + (img.height - 112) / 2,
      200,
      112,
    );
    await waitFor(() => expect(boxRect().width).toBeCloseTo(200, 0));

    const { before, after } = await zoom(100);
    expect(after.right).toBeLessThan(before.right - 20);

    await dragRight(centre(boxRect()), 300);
    expectStoppedAtRightEdge(boxRect(), after);
    await page.screenshot({ path: `${ARTIFACTS}/zoomed-out-refused.png` });
  });

  it("opens the box over the image while the entry animation is still scaling the dialog", async () => {
    await page.viewport(1280, 900);
    const { dialog } = open(await fixtureUrl());
    const running = entryAnimations(dialog);
    expect(running.length).toBeGreaterThan(0);
    for (const animation of running) {
      animation.pause();
      animation.currentTime = 0;
    }
    await boxOpened();
    // The box was placed while the dialog was drawn at its starting scale.
    expect(drawnScale(dialog)).toBeLessThan(0.99);
    for (const animation of running) animation.finish();
    expect(drawnScale(dialog)).toBeCloseTo(1, 3);

    const img = imageRect();
    const box = boxRect();
    expect(Math.abs(box.top - img.top)).toBeLessThanOrEqual(EDGE);
    expect(Math.abs(box.bottom - img.bottom)).toBeLessThanOrEqual(EDGE);

    await dragRight(centre(box), 120);
    expectStoppedAtRightEdge(boxRect(), img);
    await page.screenshot({ path: `${ARTIFACTS}/opened-mid-animation.png` });
  });

  it("reopens a saved crop where it was saved while the entry animation is still scaling the dialog", async () => {
    await page.viewport(1280, 900);
    const saved: ImageCrop = { x: 0.2, y: 0.2, w: 0.6, h: 0.6, natW: 800, natH: 400 };
    const { dialog, onSave } = open(await fixtureUrl(), saved);
    const running = entryAnimations(dialog);
    expect(running.length).toBeGreaterThan(0);
    for (const animation of running) {
      animation.pause();
      animation.currentTime = 0;
    }
    await boxOpened();
    expect(drawnScale(dialog)).toBeLessThan(0.99);
    for (const animation of running) animation.finish();

    screen.getByRole("button", { name: "Save crop" }).click();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const crop = onSave.mock.calls[0]![0];
    const drift = Math.max(
      Math.abs(crop.x - saved.x),
      Math.abs(crop.y - saved.y),
      Math.abs(crop.w - saved.w),
      Math.abs(crop.h - saved.h),
    );
    // Whole-pixel rounding of the box is worth up to about 0.0016 here; a box
    // placed at the dialog's starting scale is off by about 0.012.
    expect(drift).toBeLessThanOrEqual(0.003);
  });

  it("opens the box over an image the browser already holds, after cropperjs has placed it", async () => {
    await page.viewport(1280, 900);
    const url = await fixtureUrl();
    // The dashboard shows the same picture before the editor opens.
    const held = new Image();
    held.dataset.heldImage = "";
    held.hidden = true;
    held.src = url;
    document.body.append(held);
    await held.decode();

    const { dialog } = open(url);
    // First, before anything yields: the editor's image is already complete,
    // which is the path this test exists for.
    expect(image().$image.complete).toBe(true);
    settle(dialog);
    await boxOpened();

    const img = imageRect();
    const box = boxRect();
    expect(Math.abs(box.top - img.top)).toBeLessThanOrEqual(EDGE);
    expect(Math.abs(box.bottom - img.bottom)).toBeLessThanOrEqual(EDGE);

    await dragRight(centre(box), 20);
    expect(boxRect().left).toBeGreaterThan(box.left + 12);
    await page.screenshot({ path: `${ARTIFACTS}/held-image.png` });
  });

  it("zooms the image without tilting it when two fingers twist as they spread", async () => {
    await page.viewport(1280, 900);
    const { dialog } = open(await fixtureUrl());
    settle(dialog);
    await boxOpened();
    const before = image().$getTransform();
    const at = centre(imageRect());

    // Two touches 120px apart turn 20° and spread to 160px over ten moves.
    const fingers = (spread: number, turn: number) => {
      const dx = Math.cos(turn) * spread;
      const dy = Math.sin(turn) * spread;
      return [
        { id: 1, x: at.x - dx, y: at.y - dy },
        { id: 2, x: at.x + dx, y: at.y + dy },
      ];
    };
    const touch = (
      type: "touchStart" | "touchMove" | "touchEnd",
      touchPoints: { id: number; x: number; y: number }[],
    ) => cdp().send("Input.dispatchTouchEvent", { type, touchPoints });
    await touch("touchStart", fingers(60, 0));
    for (let i = 1; i <= 10; i++) {
      await touch("touchMove", fingers(60 + 2 * i, ((20 * Math.PI) / 180) * (i / 10)));
    }
    await touch("touchEnd", []);

    const [a, b, c, d] = image().$getTransform();
    expect(a).toBeGreaterThan(before[0]! * 1.05);
    expect(d).toBeCloseTo(a!, 6);
    expect(b).toBe(0);
    expect(c).toBe(0);
    const img = imageRect();
    expect(img.width / img.height).toBeCloseTo(2, 2);
  });

  it("gives assistive technology no grid for the guide lines drawn over the box", async () => {
    await page.viewport(1280, 900);
    const { dialog } = open(await fixtureUrl());
    settle(dialog);
    await boxOpened();

    const exposed = (await accessibilityTree()).filter((node) => !node.ignored);
    expect(exposed.map((node) => node.role?.value)).not.toContain("grid");
  });

  it("removes every window resize listener it adds when it closes", async () => {
    await page.viewport(1280, 900);
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const { dialog } = open(await fixtureUrl());
    settle(dialog);
    await boxOpened();
    cleanup();

    const handlers = (spy: typeof added) =>
      spy.mock.calls.filter(([type]) => type === "resize").map(([, handler]) => handler);
    const left = handlers(added).filter((h) => !handlers(removed).includes(h));
    expect(left).toEqual([]);
  });
});
