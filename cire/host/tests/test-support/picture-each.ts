import { page } from "vitest/browser";

/**
 * Pictures for a reviewer, from a browser test: the page as it stands at a
 * phone's width and a desktop's, light and dark. The host's and the vendor
 * portal's browser tests share it.
 */

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;

const THEMES = ["light", "dark"] as const;

export type Theme = (typeof THEMES)[number];

/** Waits out every finite animation, so a picture is of a page at rest. */
export async function settle(): Promise<void> {
  await document.fonts.ready;
  await Promise.all(
    document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => {})),
  );
}

/**
 * Writes `<dir>/<name>-<width>-<theme>.png` at each width in each theme.
 * `dir` resolves from the calling test file's directory, as
 * `page.screenshot`'s path does; `setTheme` puts a theme on the page the way
 * the portal under test does.
 */
export async function pictureEach(
  name: string,
  options: { dir: string; setTheme: (theme: Theme) => void },
): Promise<void> {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      await page.viewport(viewport.width, viewport.height);
      options.setTheme(theme);
      await settle();
      await page.screenshot({ path: `${options.dir}/${name}-${viewport.width}-${theme}.png` });
    }
  }
}
