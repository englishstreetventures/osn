import { StepShell } from "./StepShell";

export interface Step6FinishProps {
  displayName: string | null;
  totalSteps: number;
  busy: boolean;
  onPrimary: () => void;
  onBack: () => void;
}

const WEEKDAY_LABEL = (d: Date) =>
  d.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase();
const MONTH_LABEL = (d: Date) => d.toLocaleDateString(undefined, { month: "long" });

/**
 * Inline date stamp — same visual as the asset SVG but rendered as JSX
 * so today's date drives day/month directly without DOM-string surgery.
 */
function FinishDateStamp() {
  const today = new Date();
  return (
    <svg viewBox="0 0 320 280" fill="none" aria-hidden="true">
      <defs>
        <filter id="ds6-shadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow
            dx="0"
            dy="2"
            stdDeviation="4"
            flood-color="oklch(0.2 0.01 60)"
            flood-opacity="0.12"
          />
        </filter>
      </defs>
      <g filter="url(#ds6-shadow)">
        <path
          d="M40 60 L240 60 L240 76 L246 78 L240 80 L240 96 L246 98 L240 100 L240 116 L246 118 L240 120 L240 136 L246 138 L240 140 L240 156 L246 158 L240 160 L240 176 L246 178 L240 180 L240 196 L246 198 L240 200 L240 220 L40 220 Z"
          fill="var(--card)"
          stroke="var(--pulse-accent-strong)"
          stroke-width="1.5"
        />
        <line
          x1="56"
          y1="76"
          x2="224"
          y2="76"
          stroke="var(--pulse-accent-strong)"
          stroke-width="0.75"
          opacity="0.6"
        />
        <line
          x1="56"
          y1="204"
          x2="224"
          y2="204"
          stroke="var(--pulse-accent-strong)"
          stroke-width="0.75"
          opacity="0.6"
        />
      </g>
      <text
        x="140"
        y="98"
        font-family="Geist Mono, ui-monospace, monospace"
        font-size="11"
        letter-spacing="0.18em"
        text-anchor="middle"
        fill="currentColor"
        opacity="0.7"
      >
        {WEEKDAY_LABEL(today)}
      </text>
      <text
        x="140"
        y="166"
        font-family="Instrument Serif, Georgia, serif"
        font-size="76"
        font-style="italic"
        text-anchor="middle"
        fill="var(--pulse-accent-strong)"
      >
        {today.getDate()}
      </text>
      <text
        x="140"
        y="194"
        font-family="Instrument Serif, Georgia, serif"
        font-size="20"
        text-anchor="middle"
        fill="currentColor"
        opacity="0.85"
      >
        {MONTH_LABEL(today)}
      </text>
    </svg>
  );
}

export function Step6Finish(props: Step6FinishProps) {
  return (
    <StepShell
      stepIndex={5}
      totalSteps={props.totalSteps}
      eyebrow="Step 06"
      illustration={<FinishDateStamp />}
      headline={
        props.displayName ? (
          <>
            You're <em>in</em>, {props.displayName}.
          </>
        ) : (
          <>
            You're <em>in</em>.
          </>
        )
      }
      body="Pulse is ready. The home feed shows what's happening — your friends, your interests, nearby."
      primaryLabel={props.busy ? "Saving…" : "Start exploring"}
      primaryDisabled={props.busy}
      onPrimary={props.onPrimary}
      onBack={props.onBack}
    />
  );
}
