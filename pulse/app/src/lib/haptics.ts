import { invoke } from "@tauri-apps/api/core";

export type ImpactStyle = "light" | "medium" | "heavy" | "soft" | "rigid";

export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Fires a `UIImpactFeedbackGenerator` haptic with the given style. No-op on desktop. */
export function impact(style: ImpactStyle = "medium"): Promise<void> {
  return invoke("plugin:pulse-bridge|impact", { options: { style } });
}

/** Reads the webview's current safe-area insets, in points. */
export function getSafeAreaInsets(): Promise<SafeAreaInsets> {
  return invoke("plugin:pulse-bridge|get_safe_area_insets");
}
