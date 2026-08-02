import { addPluginListener, invoke } from "@tauri-apps/api/core";

export interface GlassPanel {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  cornerRadius: number;
}

/**
 * Positions native `UIGlassEffect` panels directly over the webview, in CSS
 * px (== webview points at the standard device-width viewport scale).
 * Rejects on desktop and outside a Tauri context — callers should fall back
 * to CSS `backdrop-filter` when this rejects.
 */
export function updateGlassPanels(panels: GlassPanel[]): Promise<void> {
  return invoke("plugin:pulse-bridge|update_glass_panels", { options: { panels } });
}

/**
 * Subscribes to a `pulse-bridge` event fired by the native glass panels
 * (`zoomIn`, `zoomOut`, `hourChanged`). Returns an unsubscribe function;
 * rejects on desktop and outside a Tauri context, same as `updateGlassPanels`.
 */
export function onGlassPanelEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  return addPluginListener<T>("pulse-bridge", event, handler).then((listener) => () => {
    listener.unregister().catch(() => {});
  });
}
