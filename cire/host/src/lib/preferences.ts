import { createPreferences } from "@cire/ui/lib/theme";

import { HAPTICS_STORAGE_KEY, THEME_STORAGE_KEY } from "./preference-keys";

/**
 * The host portal's theme and haptics preference: the one set every component
 * reads, made once here under the portal's own keys. What the three theme
 * states mean, and how a choice reaches `data-theme` on `<html>` (the only
 * thing `styles/global.css` reads), is in `@cire/ui/lib/theme`.
 */

export type { Theme, ThemePreference } from "@cire/ui/lib/theme";
export { applyTheme, systemTheme } from "@cire/ui/lib/theme";

const preferences = createPreferences({
  themeKey: THEME_STORAGE_KEY,
  hapticsKey: HAPTICS_STORAGE_KEY,
});

export const {
  readThemePreference,
  readHapticsPreference,
  themePreference,
  theme,
  hapticsEnabled,
  setThemePreference,
  setHapticsEnabled,
  initTheme,
} = preferences;
