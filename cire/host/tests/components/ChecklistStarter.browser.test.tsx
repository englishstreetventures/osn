import { cleanup, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The Checklist module of a wedding with no tasks, in the real `ModuleShell`,
 * from the first frame its panel paints while the tasks load until twenty
 * frames after the starter card ("Start from a suggested checklist") arrives.
 *
 * No frame may draw a line across the top of the panel. The starter keeps its
 * preview `Modal` mounted while closed, and that dialog is a flex column: an
 * author `display` beats the user-agent rule that hides a closed `<dialog>`,
 * so unless `Modal` hides it again it lays out as a strip as wide as the
 * dialog and as tall as its two borders, with a shadow under it, on the top
 * edge of the first card in the column. It sits on the add-task form while the
 * tasks load and on the starter card once it mounts, so the card seems to grow
 * out of a line.
 *
 * Every frame is read for a painted box no taller than 3px. The two frames
 * that matter are also screenshotted — the panel while the tasks load, and the
 * first frame with the card — and their pixels read back: the first card's top
 * edge must be one colour from end to end, which it is not with a strip lying
 * over its middle. At 390px the strip is as wide as the card's straight edge,
 * so there the frame reads are what see it. The screenshots go to `e2e-artifacts/cire-host/
 * checklist-starter-line/` at the repository root (gitignored), so a reviewer
 * can see the top of the panel as it was drawn.
 *
 * The factories below are written literally: the shared-factory idiom in
 * `test-support/mocks.ts` does not resolve in the browser project.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("@shared/toast", () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
vi.mock("../../src/lib/haptics", () => ({ haptic: () => {}, hapticsAvailable: () => false }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

import { __resetTasksCache } from "../../src/lib/tasks-store";
import { renderOrganiserPage } from "../test-support/organiser-page";

/** Relative to this file: the repository's `e2e-artifacts/`. */
const SHOTS = "../../../../e2e-artifacts/cire-host/checklist-starter-line";

const VIEWPORTS = [
  { name: "1280", width: 1280, height: 800 },
  { name: "390", width: 390, height: 844 },
] as const;

/** Frames read after the card arrives. */
const FRAMES_AFTER = 20;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const nextFrame = () => new Promise<number>((done) => requestAnimationFrame(done));

/** The panel's animated frame — the box `createAutoSize` clips. */
const frameEl = () => document.getElementById("subpanel-checklist")!;

/** The starter card, once it has mounted. */
const starterCard = () =>
  screen.queryByRole("heading", { name: "Start from a suggested checklist" })?.closest("section") ??
  null;

/** The first bordered box in the checklist's column, the dialog aside. */
function firstCard(): HTMLElement {
  const column = frameEl().querySelector(".flow-root > div")!;
  const card = [...column.children].find(
    (el): el is HTMLElement =>
      el instanceof HTMLElement &&
      el.tagName !== "DIALOG" &&
      Number.parseFloat(getComputedStyle(el).borderTopWidth) > 0,
  );
  if (!card) throw new Error("no bordered card in the checklist column");
  return card;
}

const CLEAR = new Set(["transparent", "rgba(0, 0, 0, 0)"]);

/** Whether `el` puts any paint on the screen: a border, a fill or a shadow. */
function paints(el: Element): boolean {
  if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  const style = getComputedStyle(el);
  const edge = (side: "Top" | "Bottom") =>
    Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
    style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== "none" &&
    !CLEAR.has(style.getPropertyValue(`border-${side.toLowerCase()}-color`));
  return (
    edge("Top") ||
    edge("Bottom") ||
    !CLEAR.has(style.backgroundColor) ||
    (style.boxShadow !== "none" && style.boxShadow !== "")
  );
}

/** Every painted box inside the panel no taller than 3px and at least 8px wide. */
function linesInPanel(): string[] {
  const lines: string[] = [];
  for (const el of frameEl().querySelectorAll("*")) {
    for (const rect of el.getClientRects()) {
      if (rect.height > 3 || rect.width < 8 || !paints(el)) continue;
      lines.push(
        `<${el.tagName.toLowerCase()}> ${Math.round(rect.width)}×${rect.height} at y=${rect.top}`,
      );
    }
  }
  return lines;
}

interface Frame {
  card: boolean;
  lines: string[];
  dialogBoxes: number;
}

/** Read every frame until `stop()`: what the panel draws as a line, if anything. */
function sampleFrames() {
  const frames: Frame[] = [];
  let running = true;
  const read = () => {
    if (!running) return;
    frames.push({
      card: starterCard() !== null,
      lines: linesInPanel(),
      dialogBoxes: frameEl().querySelector("dialog")?.getClientRects().length ?? 0,
    });
    requestAnimationFrame(read);
  };
  requestAnimationFrame(read);
  return {
    frames,
    stop: () => {
      running = false;
    },
  };
}

interface Shot {
  data: ImageData;
  /** Image pixels per CSS pixel. */
  scale: number;
}

/** Screenshot the page to `SHOTS/<name>.png` and read its pixels back. */
async function shoot(name: string): Promise<Shot> {
  const { base64 } = await page.screenshot({ path: `${SHOTS}/${name}.png`, base64: true });
  const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  return {
    data: context.getImageData(0, 0, bitmap.width, bitmap.height),
    scale: bitmap.width / window.innerWidth,
  };
}

/** Clear of the card's rounded corners on both ends of an edge. */
const CORNER = 12;

/**
 * The most a channel may vary along an edge the card draws alone. Measured at
 * 0 with nothing over the edge; the strip lying over its middle 512px at
 * 1280px wide put 17 into the border row and 10 into the row under it.
 */
const EVEN = 4;

/**
 * The largest spread of any colour channel along one image row across `rect`,
 * corners left out. An edge drawn by the card alone is one colour end to end.
 */
function spreadAlong(shot: Shot, rect: DOMRect, y: number): number {
  const { data, scale } = shot;
  const from = Math.ceil((rect.left + CORNER) * scale);
  const to = Math.floor((rect.right - CORNER) * scale);
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (let x = from; x < to; x++) {
    const at = (y * data.width + x) * 4;
    for (let c = 0; c < 3; c++) {
      const v = data.data[at + c]!;
      min[c] = Math.min(min[c]!, v);
      max[c] = Math.max(max[c]!, v);
    }
  }
  return Math.max(...max.map((v, c) => v - min[c]!));
}

/**
 * How evenly the card's top edge is drawn. A 1px border at a fractional offset
 * is spread over two image rows, so both are read.
 */
function topEdgeSpreads(shot: Shot, card: HTMLElement): number[] {
  const rect = card.getBoundingClientRect();
  const top = Math.floor(rect.top * shot.scale);
  return [top, top + 1].map((y) => spreadAlong(shot, rect, y));
}

afterEach(() => {
  cleanup();
  __resetTasksCache();
});

for (const viewport of VIEWPORTS) {
  it(`draws no line across the top of the panel while the checklist loads or as the starter card arrives, at ${viewport.name}`, async () => {
    await page.viewport(viewport.width, viewport.height);
    let answer!: (response: Response) => void;
    const tasks = new Promise<Response>((done) => (answer = done));
    authFetch.mockImplementation(async (input: unknown) => {
      const path = String(input).split("?")[0]!;
      if (path.endsWith("/tasks")) return tasks;
      if (path.endsWith("/changes/head")) return json({ revision: "rev_1" });
      return json({});
    });

    renderOrganiserPage({ module: "checklist", sub: "" });
    const sampler = sampleFrames();
    await screen.findByRole("button", { name: "Add task" });
    await document.fonts.ready;
    for (let i = 0; i < 3; i++) await nextFrame();

    // Shots before any assertion, so a red run still leaves both pictures.
    const loading = await shoot(`loading-${viewport.name}`);
    const loadingEdge = topEdgeSpreads(loading, firstCard());

    answer(json({ tasks: [], viewerHostId: null }));
    await vi.waitFor(() => expect(starterCard()).not.toBeNull());
    const arrived = await shoot(`card-${viewport.name}`);
    const cardEdge = topEdgeSpreads(arrived, starterCard()!);

    const after = sampler.frames.length;
    while (sampler.frames.length < after + FRAMES_AFTER) await nextFrame();
    sampler.stop();

    const loadingFrames = sampler.frames.filter((f) => !f.card);
    const cardFrames = sampler.frames.filter((f) => f.card);
    expect(loadingFrames.length).toBeGreaterThan(0);
    expect(cardFrames.length).toBeGreaterThanOrEqual(FRAMES_AFTER);

    expect(sampler.frames.flatMap((f) => f.lines)).toEqual([]);
    expect(sampler.frames.map((f) => f.dialogBoxes).filter((n) => n > 0)).toEqual([]);

    expect(Math.max(...loadingEdge)).toBeLessThanOrEqual(EVEN);
    expect(Math.max(...cardEdge)).toBeLessThanOrEqual(EVEN);
  });
}
