/**
 * A thin bar: how much of a budget is spent, how many guests have replied, how
 * much of a checklist is done.
 *
 * Not `<progress>`. That element takes its bar and its track from the platform
 * and resists both to a different degree in every engine, and the one thing this
 * has to do is be the portal's gold on the portal's surface.
 *
 * `over` is the case the Budget module needs: a value past its maximum is still
 * drawn full, but in the error tone, so "spent everything" and "spent more than
 * everything" are not the same picture.
 *
 * ## Why the fill is scaled rather than resized
 *
 * The fill is full width and squashed by a transform. Animating `width` puts
 * layout, paint and composite on the main thread for every frame of the move,
 * and the Budget module draws one of these per category — a dozen bars all
 * relaying out together, on the frame a figure was edited. A transform is none
 * of those things.
 *
 * The rounding then has to belong to the track, not to the fill: a transform
 * squashes a radius along with everything else, and a scaled `rounded-full`
 * gives an ellipse that changes shape as the bar moves. So the track clips, and
 * the fill inside it is a plain rectangle.
 */

/** Where the fill ends, as a percentage. Clamped, and safe for a zero maximum. */
export function meterPct(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

export default function Meter(props: {
  value: number;
  max: number;
  tone?: "gold" | "over";
  /** What the bar is measuring. Read instead of the bare number. */
  label: string;
}) {
  const pct = () => meterPct(props.value, props.max);
  return (
    <div
      class="bg-surface/60 h-1.5 w-full overflow-hidden rounded-full"
      role="progressbar"
      aria-valuenow={Math.round(pct())}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={props.label}
    >
      <div
        class={`h-full w-full origin-left transition-transform duration-(--dur-slow) ease-(--ease-out) ${
          props.tone === "over" ? "bg-error/80" : "bg-gold"
        }`}
        style={{ transform: `scaleX(${pct() / 100})` }}
      />
    </div>
  );
}
