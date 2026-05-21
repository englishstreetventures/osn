import { useAuth } from "@osn/client/solid";
import { useNavigate } from "@solidjs/router";
import { createMemo, Show } from "solid-js";

import { markOnboardingResolvedThisSession } from "../lib/onboarding";
import { getDisplayNameFromToken } from "../lib/utils";
import { OnboardingStepper } from "./onboarding/OnboardingStepper";

/**
 * Route component for `/welcome`. The first-run gate in `App.tsx` is what
 * routes new users here; this page is also reachable directly so users who
 * skipped earlier can resume onboarding.
 *
 * Unauthenticated visitors get redirected home — the gate doesn't apply
 * to anonymous browsing of the public discovery feed.
 */
export function WelcomePage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const accessToken = () => session()?.accessToken ?? null;
  const displayName = createMemo(() => getDisplayNameFromToken(accessToken()));

  const handleCompleted = () => {
    // Suppress the gate's cached pre-complete status for the rest of this
    // session — the createResource in OnboardingGate is keyed on access
    // token and won't refetch without a reload. Server-side state is
    // authoritative; next session boot will fetch and see completedAt set.
    markOnboardingResolvedThisSession();
    navigate("/", { replace: true });
  };

  return (
    <Show
      when={accessToken()}
      fallback={
        <div class="onb-root">
          <div class="onb-shell">
            <h1 class="onb-headline">Sign in to continue</h1>
            <p class="onb-subhead">You need an OSN account to set up Pulse.</p>
          </div>
        </div>
      }
    >
      {(token) => (
        <OnboardingStepper
          accessToken={token()}
          displayName={displayName()}
          onCompleted={handleCompleted}
        />
      )}
    </Show>
  );
}
