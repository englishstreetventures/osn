import type { LucideProps } from "lucide-solid";
import { splitProps } from "solid-js";

/** Overview's mark: the portal's original `◈`, redrawn on lucide's 24-unit grid
 *  so it takes the same stroke, caps and sizing as the rest of the module set.
 *  Lucide has no nested diamond. It takes lucide's props, so `ModuleIcon`
 *  renders it like any other icon. */
export default function NestedDiamondIcon(props: LucideProps) {
  const [local, rest] = splitProps(props, ["strokeWidth", "size", "color", "absoluteStrokeWidth"]);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={local.size ?? 24}
      height={local.size ?? 24}
      viewBox="0 0 24 24"
      fill="none"
      stroke={local.color ?? "currentColor"}
      stroke-width={local.strokeWidth ?? 2}
      stroke-linecap="round"
      stroke-linejoin="round"
      {...rest}
    >
      <path d="M12 2.5 21.5 12 12 21.5 2.5 12Z" />
      <path d="M12 8.25 15.75 12 12 15.75 8.25 12Z" fill="currentColor" />
    </svg>
  );
}
