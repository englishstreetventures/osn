import { useNavigate } from "@solidjs/router";
import { createSignal, Match, Switch } from "solid-js";
import { toast } from "solid-toast";

import {
  completeOnboarding,
  type CompleteOnboardingPayload,
  type InterestCategory,
  markOnboardingResolvedThisSession,
  type PermOutcome,
  requestLocationPermission,
  requestNotificationPermission,
} from "../../lib/onboarding";
import { Step1Welcome } from "./Step1Welcome";
import { Step2Value } from "./Step2Value";
import { Step3Interests } from "./Step3Interests";
import { Step4Location } from "./Step4Location";
import { Step5Notifications } from "./Step5Notifications";
import { Step6Finish } from "./Step6Finish";

import "./onboarding.css";

const TOTAL_STEPS = 6;

export interface OnboardingStepperProps {
  accessToken: string;
  displayName: string | null;
  /** Called after a successful POST /me/onboarding/complete. Caller invalidates the resource and navigates home. */
  onCompleted: () => void;
}

export function OnboardingStepper(props: OnboardingStepperProps) {
  const navigate = useNavigate();
  const [step, setStep] = createSignal(0);
  const [interests, setInterests] = createSignal<ReadonlySet<InterestCategory>>(new Set());
  const [locationPerm, setLocationPerm] = createSignal<PermOutcome>("prompt");
  const [notificationsPerm, setNotificationsPerm] = createSignal<PermOutcome>("prompt");
  const [eventRemindersOptIn, setEventRemindersOptIn] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const next = () => setStep((s) => Math.min(s + 1, TOTAL_STEPS - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const toggleInterest = (category: InterestCategory) => {
    setInterests((prev) => {
      const nextSet = new Set(prev);
      if (nextSet.has(category)) nextSet.delete(category);
      else nextSet.add(category);
      return nextSet;
    });
  };

  const skipAll = () => {
    // Server-side state stays "not completed" — onboarding will re-prompt
    // next session. The session-level hint stops the same tab from
    // looping the redirect after the user lands on the home feed.
    markOnboardingResolvedThisSession();
    navigate("/", { replace: true });
  };

  const handleRequestLocation = async () => {
    const result = await requestLocationPermission();
    setLocationPerm(result);
  };

  const handleRequestNotifications = async () => {
    const result = await requestNotificationPermission();
    setNotificationsPerm(result);
    // Reasonable default: if the user just granted notifications, opt
    // them into reminders too. They can untick before continuing.
    if (result === "granted") setEventRemindersOptIn(true);
  };

  const finish = async () => {
    if (busy()) return;
    setBusy(true);
    const notifGranted = notificationsPerm() === "granted";
    const payload: CompleteOnboardingPayload = {
      interests: [...interests()],
      notificationsOptIn: notifGranted,
      eventRemindersOptIn: notifGranted && eventRemindersOptIn(),
      notificationsPerm: notificationsPerm(),
      locationPerm: locationPerm(),
    };
    try {
      await completeOnboarding(props.accessToken, payload);
      props.onCompleted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't finish setup");
      setBusy(false);
    }
  };

  return (
    <Switch>
      <Match when={step() === 0}>
        <Step1Welcome
          displayName={props.displayName}
          totalSteps={TOTAL_STEPS}
          onPrimary={next}
          onSkip={skipAll}
        />
      </Match>
      <Match when={step() === 1}>
        <Step2Value totalSteps={TOTAL_STEPS} onPrimary={next} onBack={back} onSkip={skipAll} />
      </Match>
      <Match when={step() === 2}>
        <Step3Interests
          totalSteps={TOTAL_STEPS}
          selected={interests()}
          onToggle={toggleInterest}
          onPrimary={next}
          onBack={back}
          onSkip={next}
        />
      </Match>
      <Match when={step() === 3}>
        <Step4Location
          totalSteps={TOTAL_STEPS}
          perm={locationPerm()}
          onRequest={handleRequestLocation}
          onPrimary={next}
          onBack={back}
          onSkip={next}
        />
      </Match>
      <Match when={step() === 4}>
        <Step5Notifications
          totalSteps={TOTAL_STEPS}
          perm={notificationsPerm()}
          remindersOptIn={eventRemindersOptIn()}
          onToggleReminders={setEventRemindersOptIn}
          onRequest={handleRequestNotifications}
          onPrimary={next}
          onBack={back}
          onSkip={next}
        />
      </Match>
      <Match when={step() === 5}>
        <Step6Finish
          displayName={props.displayName}
          totalSteps={TOTAL_STEPS}
          busy={busy()}
          onPrimary={finish}
          onBack={back}
        />
      </Match>
    </Switch>
  );
}
