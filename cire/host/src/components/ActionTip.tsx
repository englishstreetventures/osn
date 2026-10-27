import Button, { type ButtonProps } from "@cire/ui/button";
import { Tooltip as KobalteTooltip } from "@kobalte/core/tooltip";
import type { SafeProps } from "@shared/ui/ui/props";
import { type JSX, splitProps } from "solid-js";

/**
 * The tooltip on a control that shows an icon instead of its words.
 *
 * `@shared/ui`'s `Tooltip` is for a passive badge: its trigger is a span that
 * takes no focus and carries its words as hidden text. A control is the other
 * case. Its name is already its `aria-label`, so the panel repeats it for the
 * eye only (`aria-hidden`), and the trigger is the control itself, so the
 * panel opens on keyboard focus as well as on hover. Kobalte points the
 * trigger's `aria-describedby` at the open panel, which Chrome would read as a
 * second copy of the name; the trigger declines it.
 *
 * `disabled` keeps the control and drops the tooltip, for a control whose
 * words are on screen at the moment.
 */

const PANEL =
  "bg-surface-raised text-text border-border z-50 max-w-xs rounded-md border px-2 py-1 text-ui-xs leading-snug shadow-md";

function Tip(props: { label: string; disabled?: boolean; children: JSX.Element }) {
  return (
    <KobalteTooltip placement="top" gutter={4} openDelay={300} disabled={props.disabled}>
      {props.children}
      <KobalteTooltip.Portal>
        <KobalteTooltip.Content aria-hidden="true" class={PANEL}>
          {props.label}
        </KobalteTooltip.Content>
      </KobalteTooltip.Portal>
    </KobalteTooltip>
  );
}

/** `Button` without the description Kobalte would point at the panel. */
function TipButton(props: ButtonProps) {
  const [, rest] = splitProps(props, ["aria-describedby"]);
  return <Button {...rest} />;
}

/** A plain `<button>`, likewise — for a tab, which brings its own look. A
 *  description of the caller's own arrives as `describedBy` and is kept. */
function TipPlain(props: SafeProps<"button"> & { describedBy?: string }) {
  const [own, rest] = splitProps(props, ["aria-describedby", "describedBy"]);
  return <button type="button" {...rest} aria-describedby={own.describedBy} />;
}

/** An icon-only `Button`, named by `label`, with the label as its tooltip. */
export function IconButton(
  props: Omit<ButtonProps, "aria-label" | "type"> & { label: string; tipDisabled?: boolean },
) {
  const [own, rest] = splitProps(props, ["label", "tipDisabled"]);
  return (
    <Tip label={own.label} disabled={own.tipDisabled}>
      <KobalteTooltip.Trigger as={TipButton} aria-label={own.label} {...rest} />
    </Tip>
  );
}

/**
 * A plain button with the same tooltip, for a control whose look is its own —
 * a sub-tab. Its name comes from its contents or its own `aria-label`; `label`
 * is what the panel shows. `describedBy` is the control's own description, if
 * it has one; `aria-describedby` is not taken, since that is Kobalte's.
 */
export function TipTrigger(
  props: Omit<SafeProps<"button">, "type" | "aria-describedby"> & {
    label: string;
    tipDisabled?: boolean;
    describedBy?: string;
  },
) {
  const [own, rest] = splitProps(props, ["label", "tipDisabled"]);
  return (
    <Tip label={own.label} disabled={own.tipDisabled}>
      <KobalteTooltip.Trigger as={TipPlain} {...rest} />
    </Tip>
  );
}
