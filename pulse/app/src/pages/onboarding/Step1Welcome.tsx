import welcomePulse from "../../assets/onboarding/welcome-pulse.svg?raw";
import { StepShell } from "./StepShell";

export interface Step1WelcomeProps {
  displayName: string | null;
  totalSteps: number;
  onPrimary: () => void;
  onSkip: () => void;
}

export function Step1Welcome(props: Step1WelcomeProps) {
  // Welcome is institutional ("Welcome to Pulse") with a softer
  // personalised accent in the body. If we have no usable name we drop
  // the personalised line entirely rather than print a literal "Hi there"
  // — the institutional headline already carries the moment.
  return (
    <StepShell
      stepIndex={0}
      totalSteps={props.totalSteps}
      eyebrow="Step 01"
      illustration={<div innerHTML={welcomePulse} style={{ width: "100%", height: "100%" }} />}
      illustrationVariant="square"
      headline={
        <>
          Welcome to <em>Pulse</em>
        </>
      }
      body={
        props.displayName
          ? `Glad you're here, ${props.displayName}. Let's set up what you want to see.`
          : "Let's set up what you want to see."
      }
      primaryLabel="Get started"
      onPrimary={props.onPrimary}
      onSkip={props.onSkip}
      skipLabel="Skip for now"
    />
  );
}
