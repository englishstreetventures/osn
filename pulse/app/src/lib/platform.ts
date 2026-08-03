/**
 * True on an iOS Tauri webview, false on desktop Tauri and in a browser.
 *
 * Both halves matter. Without the Tauri check there is no `invoke` to call;
 * without the iOS check a desktop build would route through code paths
 * (native session transport, ephemeral storage) that only make sense where
 * the Keychain and native bridge actually exist.
 */
export function isIosWebview(): boolean {
  if (typeof window === "undefined") return false;
  if (!("__TAURI_INTERNALS__" in window)) return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}
