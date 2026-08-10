import { Show } from "solid-js";

import notificationsEmber from "../../assets/onboarding/notifications-ember.svg?raw";
import type { PermOutcome } from "../../lib/onboarding";
import { StepShell } from "./StepShell";

export interface Step5NotificationsProps {
  totalSteps: number;
  perm: PermOutcome;
  remindersOptIn: boolean;
  onToggleReminders: (value: boolean) => void;
  onRequest: () => void;
  onPrimary: () => void;
  onBack: () => void;
  onSkip: () => void;
}

const STATUS_COPY: Record<PermOutcome, { className: string; text: string }> = {
  prompt: {
    className: "",
    text: "We'll only send you what matters: invites, RSVPs, and reminders you opt into.",
  },
  granted: { className: "is-granted", text: "Notifications enabled." },
  denied: {
    className: "is-denied",
    text: "Notifications declined. You can enable them later in your system settings.",
  },
  unsupported: {
    className: "is-denied",
    text: "Notifications aren't supported on this device.",
  },
};

export function Step5Notifications(props: Step5NotificationsProps) {
  const status = () => STATUS_COPY[props.perm];
  const isResolved = () => props.perm !== "prompt";
  return (
    <StepShell
      stepIndex={4}
      totalSteps={props.totalSteps}
      eyebrow="Step 05"
      illustration={
        <div innerHTML={notificationsEmber} style={{ width: "100%", height: "100%" }} />
      }
      headline={
        <>
          Stay in the <em>loop</em>
        </>
      }
      body="Get a heads-up when friends RSVP to events you're going to, when an event you're hosting fills up, or when something nearby starts soon."
      primaryLabel={isResolved() ? "Continue" : "Allow notifications"}
      onPrimary={isResolved() ? props.onPrimary : props.onRequest}
      onBack={props.onBack}
      onSkip={props.onSkip}
      skipLabel="Skip"
    >
      <div class={`onb-perm-banner ${status().className}`}>
        <span>{status().text}</span>
      </div>

      <Show when={props.perm === "granted"}>
        <label
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "space-between",
            gap: "12px",
            "margin-top": "16px",
            padding: "12px 14px",
            border: "1px solid var(--border)",
            "border-radius": "10px",
            cursor: "pointer",
          }}
        >
          <span style={{ "font-size": "14px", "text-align": "left" }}>
            Remind me before events I'm going to
          </span>
          <input
            type="checkbox"
            checked={props.remindersOptIn}
            onInput={(e) => props.onToggleReminders(e.currentTarget.checked)}
            style={{ width: "18px", height: "18px", "accent-color": "var(--pulse-accent)" }}
          />
        </label>
      </Show>
    </StepShell>
  );
}
