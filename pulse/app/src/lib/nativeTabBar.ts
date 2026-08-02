import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";

/**
 * True once a real `UITabBar` is on screen. The DOM tabs read this and stop
 * rendering, so the two are never both visible.
 */
const [nativeTabBarActive, setNativeTabBarActive] = createSignal(false);
export { nativeTabBarActive };

export type NativeTab = {
  id: string;
  title: string;
  systemImage?: string;
  enabled?: boolean;
};

type TabSelected = { id: string };

/**
 * Bumped by every install and every teardown. Both are async, and the router
 * can order them faster than the IPC round-trip completes — a navigation
 * straight to `/welcome` can start a teardown while the install for the
 * previous route is still in flight. Whoever bumped last wins; an older call
 * that lands afterwards keeps its hands off the shared state.
 */
let generation = 0;

/**
 * Installs or replaces the native tab bar, and returns whether it took.
 *
 * There is no platform sniffing here on purpose: the plugin itself reports
 * `Unsupported` everywhere but iOS, so a rejected call is the answer. That
 * also covers an older build of the shell that has no such plugin at all.
 */
export async function installNativeTabBar(
  tabs: NativeTab[],
  selectedId: string | undefined,
  onSelect: (id: string) => void,
): Promise<boolean> {
  if (!isTauri()) return false;

  const mine = ++generation;
  const channel = new Channel<TabSelected>();
  channel.onmessage = (message) => onSelect(message.id);

  try {
    await invoke("plugin:pulse-tabbar|set_tabs", {
      options: { tabs, selectedId },
      onSelect: channel,
    });
  } catch {
    if (mine === generation) setNativeTabBarActive(false);
    return false;
  }

  // A teardown, or a newer install, overtook this one. Its result is the
  // current truth; claiming the bar is up here would strand it on screen.
  if (mine !== generation) return false;

  setNativeTabBarActive(true);
  return true;
}

/** Moves the highlight after a route change that did not come from a tap. */
export async function setSelectedNativeTab(id: string): Promise<void> {
  if (!nativeTabBarActive()) return;
  try {
    await invoke("plugin:pulse-tabbar|set_selected_tab", { options: { id } });
  } catch {
    // A route with no tab of its own; leave the highlight where it is.
  }
}

/** Removes the bar and gives the webview its full height back. */
export async function clearNativeTabs(): Promise<void> {
  // Gated on the platform, not on `nativeTabBarActive()`: an install may
  // still be in flight, and it would put up a bar we have already decided to
  // take down. Bumping the generation is what cancels it.
  if (!isTauri()) return;

  generation++;
  setNativeTabBarActive(false);
  try {
    await invoke("plugin:pulse-tabbar|set_tabs", {
      options: { tabs: [] },
      onSelect: new Channel<TabSelected>(),
    });
  } catch {
    // Nothing left to do: the bar is either already gone or was never there.
  }
}
