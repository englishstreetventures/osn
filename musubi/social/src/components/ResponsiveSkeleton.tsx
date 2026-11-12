import { Skeleton, type SkeletonStandIn } from "@shared/ui/ui/skeleton";

/**
 * The placeholder for a row or card whose height changes at `md`: its buttons
 * grow to the 40px touch height below it (`DESIGN.md` §Responsive layout,
 * Touch targets), so one height cannot hold its place at both widths.
 * `Skeleton` takes one height, inline, so this draws one block per width and
 * hides each at the other. A hidden block takes no box, so a list's gap
 * counts only the one shown.
 */
export function ResponsiveSkeleton(props: {
  standsFor?: SkeletonStandIn;
  /** Spacing steps from `md` up. */
  height: number;
  /** Spacing steps below `md`. */
  phoneHeight: number;
}) {
  return (
    <>
      <Skeleton standsFor={props.standsFor} height={props.phoneHeight} class="md:hidden" />
      <Skeleton standsFor={props.standsFor} height={props.height} class="max-md:hidden" />
    </>
  );
}
