/**
 * The one list of primary tabs, which `ExploreNav` draws. A tab either goes
 * somewhere or is a disabled placeholder; never both.
 */

type Tab = {
  id: string;
  label: string;
} & ({ path: string; disabled?: never } | { path?: never; disabled: true });

export const TABS: readonly Tab[] = [
  { id: "home", label: "Home", path: "/" },
  { id: "calendar", label: "Calendar", path: "/calendar" },
  { id: "hosting", label: "Hosting", disabled: true },
];
