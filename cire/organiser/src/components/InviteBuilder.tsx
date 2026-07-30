/**
 * Compatibility re-export — the invite builder was split into the `invite/`
 * directory (orchestrator + model + field primitives + previews + design
 * picker + preview pane). Import sites and tests keep this path.
 */
export { default, isDesignLocked, SECTION_MENU_COLUMNS } from "./invite/InviteBuilder";
