import { Skeleton, type SkeletonStandIn } from "@shared/ui/ui/skeleton";

/**
 * The placeholder for a row, card or button whose height changes at `md`: its
 * buttons grow to the 40px touch height below it (`DESIGN.md` §Responsive
 * layout, Touch targets), so one height cannot hold its place at both widths.
 * `Skeleton` takes one height, inline, so this draws one block per width and
 * hides each at the other. A hidden block takes no box, so a list's gap
 * counts only the one shown.
 */
export function ResponsiveSkeleton(props: {
  standsFor?: SkeletonStandIn;
  /** Spacing steps, as `Skeleton`'s `width`. Left out: the container's width. */
  width?: number;
  /** Spacing steps from `md` up. */
  height: number;
  /** Spacing steps below `md`. */
  phoneHeight: number;
  /** Both blocks' place only, as `Skeleton`'s `class`: a margin, a flex placement. */
  class?: string;
}) {
  const place = (shown: string) => (props.class ? `${props.class} ${shown}` : shown);
  return (
    <>
      <Skeleton
        standsFor={props.standsFor}
        width={props.width}
        height={props.phoneHeight}
        class={place("md:hidden")}
      />
      <Skeleton
        standsFor={props.standsFor}
        width={props.width}
        height={props.height}
        class={place("max-md:hidden")}
      />
    </>
  );
}
