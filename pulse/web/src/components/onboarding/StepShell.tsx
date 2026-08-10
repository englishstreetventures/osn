import { Button } from "@osn/ui/ui/button";
import { Show, type JSX } from "solid-js";

/**
 * Common chrome for every onboarding step — eyebrow + illustration slot
 * + headline + body slot + sticky action row. Step components focus on
 * content and copy; layout, motion, and progress are owned here.
 */
export interface StepShellProps {
  stepIndex: number;
  totalSteps: number;
  eyebrow?: string;
  illustration: JSX.Element;
  illustrationVariant?: "square" | "wide";
  headline: JSX.Element;
  body?: JSX.Element;
  /** Slot for content between the headline/body and the action buttons (e.g. chip grid). */
  children?: JSX.Element;
  primaryLabel: string;
  primaryDisabled?: boolean;
  onPrimary: () => void;
  /** Hide back when this is the first step. */
  onBack?: () => void;
  /** Optional secondary affordance (e.g. "Skip for now"). */
  onSkip?: () => void;
  skipLabel?: string;
}

export function StepShell(props: StepShellProps) {
  return (
    <div class="onb-root">
      <div
        class="onb-progress"
        role="progressbar"
        aria-valuemin="1"
        aria-valuemax={props.totalSteps}
        aria-valuenow={props.stepIndex + 1}
      >
        {Array.from({ length: props.totalSteps }).map((_, i) => (
          <div
            class={`onb-progress-segment ${
              i < props.stepIndex ? "is-complete" : i === props.stepIndex ? "is-active" : ""
            }`}
          >
            <span />
          </div>
        ))}
      </div>

      <div class="onb-shell onb-step-enter" data-step={props.stepIndex}>
        <Show when={props.eyebrow}>
          <div class="onb-eyebrow">{props.eyebrow}</div>
        </Show>

        <div
          class={`onb-illustration ${
            props.illustrationVariant === "square" ? "onb-illustration--square" : ""
          }`}
        >
          {props.illustration}
        </div>

        <h1 class="onb-headline">{props.headline}</h1>

        <Show when={props.body}>
          <p class="onb-subhead">{props.body}</p>
        </Show>

        <Show when={props.children}>
          <div style={{ "margin-top": "20px", width: "100%" }}>{props.children}</div>
        </Show>
      </div>

      <div class="onb-actions">
        <Button size="lg" onClick={props.onPrimary} disabled={props.primaryDisabled} class="w-full">
          {props.primaryLabel}
        </Button>
        <div class="onb-back-skip">
          <Show when={props.onBack} fallback={<span />}>
            <button
              type="button"
              onClick={() => props.onBack?.()}
              class="text-muted-foreground hover:text-foreground cursor-pointer border-0 bg-transparent p-0"
            >
              ← Back
            </button>
          </Show>
          <Show when={props.onSkip}>
            <button
              type="button"
              onClick={() => props.onSkip?.()}
              class="text-muted-foreground hover:text-foreground cursor-pointer border-0 bg-transparent p-0"
            >
              {props.skipLabel ?? "Skip"}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
