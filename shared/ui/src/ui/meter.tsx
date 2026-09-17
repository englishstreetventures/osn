/**
 * A thin bar: how much of a budget is spent, how many guests have replied, how
 * much of a checklist is done.
 *
 * Not `<progress>`. That element takes its bar and its track from the platform
 * and resists restyling to a different degree in every engine, and the one thing
 * this has to do is be the app's accent on the app's surface.
 *
 * ## Why the fill is scaled rather than resized
 *
 * The fill is full width and squashed by a transform. Animating `width` puts
 * layout, paint and composite on the main thread for every frame of the move,
 * and a budget screen draws one of these per category — a dozen bars all
 * relaying out together, on the frame a figure was edited. A transform is none
 * of those things.
 *
 * The rounding then has to belong to the track, not to the fill: a transform
 * squashes a radius along with everything else, and a scaled `rounded-full`
 * gives an ellipse that changes shape as the bar moves. So the track clips, and
 * the fill inside it is a plain rectangle.
 *
 * ## `over` is a state, not a clamp
 *
 * A value past its maximum is still drawn full, but in the danger tone, so
 * "spent everything" and "spent more than everything" are not the same picture.
 * The caller decides which it is — this component cannot know whether a maximum
 * is a budget or a capacity.
 */

/** Where the fill ends, as a percentage. Clamped, and safe for a zero maximum. */
export function meterPct(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

export type MeterTone = "accent" | "over";

const TONE = {
  accent: "base:bg-ui-accent",
  over: "base:bg-ui-danger/80",
} satisfies Readonly<Record<MeterTone, string>>;

export interface MeterProps {
  value: number;
  max: number;
  tone?: MeterTone;
  /**
   * What the bar is measuring. Required, and read in place of the bare number:
   * a `progressbar` with no name announces as "42 percent" of nothing.
   */
  label: string;
  class?: string;
}

export function Meter(props: MeterProps) {
  const pct = () => meterPct(props.value, props.max);
  // oxlint-disable jsx-a11y/prefer-tag-over-role -- `<progress>` is the tag the
  // rule names, and it is the one thing this component cannot be: it takes its
  // bar and its track from the platform and resists restyling to a different
  // degree in every engine. The role carries the same semantics to assistive
  // technology, which is what the rule is protecting. A block rather than the
  // next-line form because the diagnostic lands on the attribute, several lines
  // below the element it opens on.
  return (
    <div
      class={`base:bg-ui-surface-sunk base:h-1.5 base:w-full base:overflow-hidden base:rounded-ui-pill${props.class ? ` ${props.class}` : ""}`}
      role="progressbar"
      aria-valuenow={Math.round(pct())}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={props.label}
    >
      <div
        class={`base:h-full base:w-full base:origin-left base:transition-transform ${TONE[props.tone ?? "accent"]}`}
        style={{ transform: `scaleX(${pct() / 100})` }}
      />
    </div>
  );
  // oxlint-enable jsx-a11y/prefer-tag-over-role
}
