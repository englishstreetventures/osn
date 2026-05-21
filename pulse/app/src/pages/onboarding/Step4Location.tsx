import { Show } from "solid-js";

import locationPin from "../../assets/onboarding/location-pin.svg?raw";
import type { PermOutcome } from "../../lib/onboarding";
import { StepShell } from "./StepShell";

export interface Step4LocationProps {
  totalSteps: number;
  perm: PermOutcome;
  onRequest: () => void;
  onPrimary: () => void;
  onBack: () => void;
  onSkip: () => void;
}

const STATUS_COPY: Record<PermOutcome, { className: string; text: string }> = {
  prompt: { className: "", text: "We'll show you what's happening near you." },
  granted: { className: "is-granted", text: "Location enabled — events nearby ready." },
  denied: {
    className: "is-denied",
    text: "Location declined. You can still browse — enable later in settings.",
  },
  unsupported: {
    className: "is-denied",
    text: "Location isn't available on this device. You can still browse all events.",
  },
};

export function Step4Location(props: Step4LocationProps) {
  const status = () => STATUS_COPY[props.perm];
  const isResolved = () => props.perm !== "prompt";
  return (
    <StepShell
      stepIndex={3}
      totalSteps={props.totalSteps}
      eyebrow="Step 04"
      illustration={<div innerHTML={locationPin} style={{ width: "100%", height: "100%" }} />}
      headline={
        <>
          See what's <em>nearby</em>
        </>
      }
      body="Allow location and Pulse will sort events by proximity. We don't store your location — it's only used at query time."
      primaryLabel={isResolved() ? "Continue" : "Allow location"}
      onPrimary={isResolved() ? props.onPrimary : props.onRequest}
      onBack={props.onBack}
      onSkip={props.onSkip}
      skipLabel="Skip"
    >
      <div class={`onb-perm-banner ${status().className}`}>
        <span>{status().text}</span>
      </div>
      <Show when={isResolved() && props.perm !== "granted"}>
        <div style={{ "text-align": "center", "margin-top": "10px" }}>
          <button
            type="button"
            onClick={props.onRequest}
            class="text-muted-foreground hover:text-foreground cursor-pointer border-0 bg-transparent p-0 text-xs underline"
          >
            Try again
          </button>
        </div>
      </Show>
    </StepShell>
  );
}
