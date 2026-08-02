import type { JSX } from "solid-js";

/**
 * Single source of truth for the primary navigation, shared by the desktop
 * rail (`Sidebar`) and the mobile bottom tab bar (`MobileNav`). Icons take a
 * class so each shell can size them (14px rail / 20px tab bar per DESIGN.md).
 */

export interface NavIconProps {
  class?: string;
}

export interface NavItem {
  href: string;
  label: string;
  icon: (props: NavIconProps) => JSX.Element;
  /**
   * Rendered in the mobile tab bar only. Search is the one such item: the
   * desktop rail carries a live search field (`GlobalSearch`), so a nav entry
   * pointing at the same thing would be redundant there — but on mobile the
   * bottom bar is the reachable surface, so search earns a tab.
   */
  mobileOnly?: boolean;
}

export function IconConnections(props: NavIconProps) {
  return (
    <svg
      class={props.class ?? "h-3.5 w-3.5"}
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

/** Plain magnifier — search. */
export function IconSearch(props: NavIconProps) {
  return (
    <svg
      class={props.class ?? "h-3.5 w-3.5"}
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

/**
 * Person-with-a-plus — Discover, i.e. people to add. It used to be a
 * magnifier-with-a-plus, which now belongs to Search; two magnifiers side by
 * side in the tab bar read as the same destination twice.
 */
export function IconDiscover(props: NavIconProps) {
  return (
    <svg
      class={props.class ?? "h-3.5 w-3.5"}
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <line x1="19" y1="8" x2="19" y2="14" />
      <line x1="22" y1="11" x2="16" y2="11" />
    </svg>
  );
}

export function IconOrganisations(props: NavIconProps) {
  return (
    <svg
      class={props.class ?? "h-3.5 w-3.5"}
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M18 21a8 8 0 0 0-16 0" />
      <circle cx="10" cy="8" r="5" />
      <path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" />
    </svg>
  );
}

export function IconSettings(props: NavIconProps) {
  return (
    <svg
      class={props.class ?? "h-3.5 w-3.5"}
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/connections", label: "Connections", icon: IconConnections },
  { href: "/search", label: "Search", icon: IconSearch, mobileOnly: true },
  { href: "/discover", label: "Discover", icon: IconDiscover },
  { href: "/organisations", label: "Organisations", icon: IconOrganisations },
  { href: "/settings", label: "Settings", icon: IconSettings },
];

/** Rail items: everything except the mobile-only Search tab. */
export const DESKTOP_NAV_ITEMS = NAV_ITEMS.filter((item) => !item.mobileOnly);

/** Whether a nav item is the active one for the current path. `/` renders the
 *  Connections page, so the Connections item lights up there too. */
export function isNavActive(pathname: string, href: string): boolean {
  if (pathname === href || pathname.startsWith(href + "/")) return true;
  return href === "/connections" && pathname === "/";
}
