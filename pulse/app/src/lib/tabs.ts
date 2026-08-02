/**
 * The one list of primary tabs. Both the DOM nav in `ExploreNav` and the
 * native `UITabBar` read it, so the two can never disagree about what exists,
 * what it is called, or where it goes.
 */

export type Tab = {
  id: string;
  label: string;
  /** SF Symbol, used only by the native bar. */
  systemImage: string;
} & ({ path: string; disabled?: never } | { path?: never; disabled: true });

export const TABS: readonly Tab[] = [
  { id: "home", label: "Home", path: "/", systemImage: "sparkles" },
  { id: "calendar", label: "Calendar", path: "/calendar", systemImage: "calendar" },
  { id: "hosting", label: "Hosting", disabled: true, systemImage: "person.2" },
];

/** Which tab a route belongs to, or `undefined` for routes off the tab bar. */
export function tabIdForPath(pathname: string): string | undefined {
  return TABS.find((tab) => tab.path === pathname)?.id;
}

export function pathForTabId(id: string): string | undefined {
  return TABS.find((tab) => tab.id === id)?.path;
}
