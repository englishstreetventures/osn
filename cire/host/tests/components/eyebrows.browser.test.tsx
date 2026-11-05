import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({
  useAuth: () => ({ authFetch, activeProfileId: () => "usr_amy" }),
}));
vi.mock("@shared/toast", () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

import Eyebrow from "@cire/ui/eyebrow";

import CreateWeddingForm from "../../src/components/CreateWeddingForm";
import EnquireDialog from "../../src/components/EnquireDialog";
import ImageCropModal from "../../src/components/ImageCropModal";
import RemintPanel from "../../src/components/RemintPanel";
import SecurityPanel from "../../src/components/SecurityPanel";

/*
 * No small-caps line repeats the heading under it (DESIGN.md §3, "A line earns
 * its place"), on the headed views the end-to-end flows never open: the
 * account's Security view, the re-mint panel, the new-wedding form (which is
 * also the whole page for an organiser with no weddings yet), a vendor's
 * enquiry dialog, which needs a directory listing the stack does not seed, and
 * the picture crop, which needs a picture it does not seed either. The form
 * and the two dialogs are pictured at a phone's width and a desktop's, light
 * and dark, in `e2e-artifacts/cire-eyebrows/host/` at the repository root
 * (gitignored).
 */

/** The text of the small-caps line straight above `heading`, or "" when there is none. */
function eyebrowOver(heading: HTMLElement): string {
  const above = heading.previousElementSibling;
  if (!above) return "";
  const style = getComputedStyle(above);
  // `normal` parses to NaN, which is not small caps.
  const ratio = Number.parseFloat(style.letterSpacing) / Number.parseFloat(style.fontSize);
  return style.textTransform === "uppercase" && ratio >= 0.09
    ? (above.textContent ?? "").trim()
    : "";
}

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;
const THEMES = ["light", "dark"] as const;

/** `path` resolves from this file's directory: four levels up is the repository root. */
const shot = (name: string) => `../../../../e2e-artifacts/cire-eyebrows/host/${name}.png`;

/** Waits out every finite animation, so a picture is of a page at rest. */
async function settle() {
  await document.fonts.ready;
  await Promise.all(
    document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => {})),
  );
}

/** Pictures the page as it stands at each width, in each theme. */
async function pictureEach(name: string) {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      await page.viewport(viewport.width, viewport.height);
      document.documentElement.dataset.theme = theme;
      await settle();
      await page.screenshot({ path: shot(`${name}-${viewport.width}-${theme}`) });
    }
  }
}

/** The portal's two faces are Astro's built fonts; a test sets their fallbacks. */
function useFallbackFonts() {
  const root = document.documentElement;
  root.style.setProperty("--font-ui", 'system-ui, -apple-system, "Segoe UI", sans-serif');
  root.style.setProperty("--font-flair", '"Iowan Old Style", Palatino, Georgia, serif');
}

const urls: string[] = [];

/** A `blob:` URL of an 800×400 picture: two tones under a grid. */
async function picture(): Promise<string> {
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
  ctx.stroke();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no blob"))), "image/png"),
  );
  const url = URL.createObjectURL(blob);
  urls.push(url);
  return url;
}

afterEach(() => {
  cleanup();
  for (const url of urls.splice(0)) URL.revokeObjectURL(url);
  authFetch.mockReset();
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute("style");
});

describe("a view's heading stands without an eyebrow", () => {
  it("is read by a reader that sees a kept one", () => {
    render(() => (
      <div>
        <Eyebrow>Kept</Eyebrow>
        <h2>Heading</h2>
      </div>
    ));
    expect(eyebrowOver(screen.getByRole("heading", { name: "Heading" }))).toBe("Kept");
  });

  it("on Security", () => {
    render(() => <SecurityPanel />);
    expect(eyebrowOver(screen.getByRole("heading", { name: /devices & passkeys/i }))).toBe("");
  });

  it("on the re-mint panel", async () => {
    authFetch.mockResolvedValue(
      new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } }),
    );
    render(() => <RemintPanel weddingId="wed_a" />);
    const heading = await screen.findByRole("heading", { name: "Change the code style" });
    expect(eyebrowOver(heading)).toBe("");
  });

  it("on the new-wedding form", async () => {
    useFallbackFonts();
    render(() => (
      <main class="page-frame @container/page py-8">
        <CreateWeddingForm onCreated={() => {}} />
      </main>
    ));
    const heading = screen.getByRole("heading", { name: "Start a new celebration" });
    expect(eyebrowOver(heading)).toBe("");
    await pictureEach("create-wedding");
  });

  it("in the enquiry dialog", async () => {
    useFallbackFonts();
    render(() => (
      <EnquireDialog
        open
        weddingId="wed_a"
        directoryVendorId="dv_bloom"
        category="florist"
        vendorName="Bloom & Co"
        onClose={() => {}}
      />
    ));
    const heading = await screen.findByRole("heading", { name: "Enquire with Bloom & Co" });
    expect(eyebrowOver(heading)).toBe("");
    await pictureEach("enquire-dialog");
  });

  it("in the picture crop", async () => {
    useFallbackFonts();
    const imageUrl = await picture();
    render(() => (
      <ImageCropModal
        imageUrl={imageUrl}
        slot="hero"
        initialCrop={null}
        onSave={async () => {}}
        onReset={async () => {}}
        onClose={() => {}}
      />
    ));
    const heading = await screen.findByRole("heading", { name: "Choose what guests see" });
    expect(eyebrowOver(heading)).toBe("");
    await pictureEach("crop-dialog");
  });
});
