import { useAuth } from "@osn/client/solid";
import { useLocation, useNavigate } from "@solidjs/router";
import { createEffect, createMemo, onCleanup, untrack } from "solid-js";

import {
  clearNativeTabs,
  installNativeTabBar,
  nativeTabBarActive,
  setSelectedNativeTab,
  type NativeTab,
} from "../lib/nativeTabBar";
import { pathForTabId, TABS, tabIdForPath } from "../lib/tabs";

/**
 * Drives the native `UITabBar` from the router, and the router from it.
 *
 * Mounted in the root layout rather than in `ExploreNav`, which only renders
 * on `/`: an install scoped to that component would tear the bar down the
 * moment the user reached any other tab.
 *
 * Renders nothing — the bar is a real UIKit view sitting above the webview.
 * Off iOS, `installNativeTabBar` reports failure and the DOM tabs stay.
 */
export function NativeTabBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { session } = useAuth();

  // Every memo below narrows to a primitive before anything downstream reads
  // it. `session()` hands back a fresh object on each token refresh, and
  // `location.pathname` changes on every navigation; without the narrowing,
  // either would rebuild the tab list and reinstall the whole bar.
  const signedIn = createMemo(() => session() != null);
  // Onboarding owns the whole screen; a tab bar there would offer routes the
  // user has not finished signing up for.
  const onWelcome = createMemo(() => location.pathname === "/welcome");

  const wanted = createMemo<NativeTab[]>(() =>
    onWelcome()
      ? []
      : TABS.filter((tab) => tab.id === "home" || signedIn()).map((tab) => ({
          id: tab.id,
          title: tab.label,
          systemImage: tab.systemImage,
          enabled: !tab.disabled,
        })),
  );

  createEffect(() => {
    const tabs = wanted();
    if (tabs.length === 0) {
      void clearNativeTabs();
      return;
    }
    // Untracked: the starting selection is a one-off read, and tracking it
    // would reinstall the bar on every navigation.
    const selected = untrack(() => tabIdForPath(location.pathname));
    void installNativeTabBar(tabs, selected, (id) => {
      const path = pathForTabId(id);
      if (path) navigate(path);
    });
  });

  // Route changed from inside the webview (a link, the back gesture): move
  // the highlight to match. Taps do not come back through here — UIKit does
  // not re-notify us for a selection we set ourselves.
  createEffect(() => {
    const id = tabIdForPath(location.pathname);
    if (id && nativeTabBarActive()) void setSelectedNativeTab(id);
  });

  onCleanup(() => void clearNativeTabs());

  return null;
}
