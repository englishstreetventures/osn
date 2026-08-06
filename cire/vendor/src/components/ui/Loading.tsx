/**
 * "This is on its way."
 *
 * Five surfaces were each rendering their own copy of the same `<p role="status"
 * class="… animate-pulse …">`, which is five chances for one of them to forget
 * the role — and a spinner nobody announces is a blank screen to anyone not
 * looking at it.
 *
 * `role="status"` rather than `role="alert"`: a live region that waits for a
 * gap rather than interrupting. Something starting to load is not urgent, and a
 * portal that cuts across a screen reader mid-sentence to say "Loading…" is
 * worse than one that waits its turn.
 *
 * The pulse is a Tailwind animation, so the reduced-motion kill switch in
 * `global.css` stops it without this component knowing.
 */
export default function Loading(props: { label: string }) {
  // oxlint-disable jsx-a11y/prefer-tag-over-role -- `<output>` is the tag that
  // carries this implicit role, and it is the wrong element: it is
  // form-associated and means "the result of a calculation", which is what its
  // `form` and `for` attributes are for. This is a paragraph saying a fetch is
  // in flight. A block rather than the next-line form because the attribute is
  // not on the line the element opens on, and oxfmt is what decides that.
  return (
    <p
      role="status"
      class="font-body text-text-muted animate-pulse text-[0.88rem] tracking-[0.1em] uppercase"
    >
      {props.label}
    </p>
  );
  // oxlint-enable jsx-a11y/prefer-tag-over-role
}
