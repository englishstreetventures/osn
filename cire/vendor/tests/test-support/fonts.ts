/**
 * The portal's two faces are Astro's self-hosted fonts, which only a build
 * emits, so a browser test sets the two variables they would set to the
 * fallbacks `astro.config.mjs` lists for them. Without this, `var(--font-ui)`
 * names nothing and the page draws in the browser's default serif, so any
 * width a test measures is a face the portal never shows. Undone by removing
 * the root's `style` attribute after each test.
 */
export function useFallbackFonts(): void {
  const root = document.documentElement;
  root.style.setProperty("--font-ui", 'system-ui, -apple-system, "Segoe UI", sans-serif');
  root.style.setProperty("--font-flair", '"Iowan Old Style", Palatino, Georgia, serif');
}
