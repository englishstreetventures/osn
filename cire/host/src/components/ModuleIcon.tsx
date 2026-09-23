import type { LucideIcon } from "lucide-solid";
import { Dynamic } from "solid-js/web";

/** One navigation icon, drawn at the portal's single icon size. Every surface
 *  that marks a module — the rail, the sheet, the command palette, Overview's
 *  agenda — renders through this, so `--size-icon` and the stroke weight are
 *  set in one place rather than at each call site.
 *
 *  Always decoration: the row's own text carries the meaning, so the icon is
 *  hidden from assistive tech. Colour comes from the surrounding text
 *  (`currentColor`), so a caller tints it with a text utility on `class`. */
export default function ModuleIcon(props: { icon: LucideIcon; class?: string }) {
  return (
    <Dynamic
      component={props.icon}
      aria-hidden="true"
      strokeWidth={1.75}
      class={`size-icon shrink-0 ${props.class ?? ""}`}
    />
  );
}
