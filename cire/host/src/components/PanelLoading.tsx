/** What a panel shows while its chunk is in flight. Shared by every `lazy()`
 *  panel in the portal — `ModuleShell`'s `warmPanel` map and `EditWorkspace`'s
 *  import panel — which is why it lives here rather than in either of them:
 *  `ModuleShell` imports `EditWorkspace`, so the other direction is a cycle.
 *
 *  Deliberately a line of text rather than a skeleton: a skeleton that flashes
 *  reads as a fault, and both consumers warm their chunk on intent, so this is
 *  usually not painted at all.
 *
 *  The min-height is not decoration. This sits inside the auto-sized frame, so a
 *  fallback of its natural height (one line) would collapse the panel to ~40px,
 *  animate down, then snap back up when the chunk lands — two layout passes and
 *  two visible jumps where an eager panel had none. Holding roughly a panel's
 *  worth of height keeps the swap reading as one movement.
 *
 *  `aria-busy` is what tells a screen reader the panel is still coming. */
export default function PanelLoading() {
  return (
    <p
      class="font-body text-text-muted flex min-h-[20rem] items-start py-8 text-[0.85rem]"
      aria-busy="true"
    >
      Loading…
    </p>
  );
}
