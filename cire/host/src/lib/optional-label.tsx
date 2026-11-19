import type { JSX } from "solid-js";

/**
 * A field's label with "(optional)" after it, in lower case at the body's
 * tracking rather than in the label's spaced small caps.
 *
 * Written into the caps as "(OPTIONAL)", the word doubled a short label's
 * width, so in an add form's narrow column ("PRICE (OPTIONAL)") it wrapped to
 * a second line and set that field's label above its neighbours'. As a quiet
 * lower-case tail it keeps to one line, and the field's name stays the loud
 * part.
 */
export function optionalLabel(name: string): JSX.Element {
  return (
    <>
      {name} <span class="tracking-ui-normal normal-case">(optional)</span>
    </>
  );
}
