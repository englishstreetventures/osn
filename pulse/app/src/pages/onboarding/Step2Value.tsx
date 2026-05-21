import valueMap from "../../assets/onboarding/value-map.svg?raw";
import { StepShell } from "./StepShell";

export interface Step2ValueProps {
  totalSteps: number;
  onPrimary: () => void;
  onBack: () => void;
  onSkip: () => void;
}

export function Step2Value(props: Step2ValueProps) {
  return (
    <StepShell
      stepIndex={1}
      totalSteps={props.totalSteps}
      eyebrow="Step 02"
      illustration={<div innerHTML={valueMap} style={{ width: "100%", height: "100%" }} />}
      headline={
        <>
          <em>Discover</em> what's happening
        </>
      }
      body="Pulse surfaces events from your friends and the wider community — what's on tonight, what's filling fast, and what looks like your kind of thing."
      primaryLabel="Continue"
      onPrimary={props.onPrimary}
      onBack={props.onBack}
      onSkip={props.onSkip}
      skipLabel="Skip for now"
    />
  );
}
