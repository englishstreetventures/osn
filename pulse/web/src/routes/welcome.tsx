import { useAuth } from "@shared/rp-auth/solid";
import { useNavigate } from "@solidjs/router";
import { createMemo, Show } from "solid-js";

import { OnboardingStepper } from "../components/onboarding/OnboardingStepper";
import { markOnboardingResolvedThisSession } from "../lib/onboarding";
import { displayNameOf } from "../lib/utils";

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
  // The name comes from the session the Pulse API hands back, not from a
  // token this page decodes — the browser never sees an OSN token.
  const displayName = createMemo(() => displayNameOf(session() ?? null));

  const handleCompleted = () => {
    // Suppress the gate's cached pre-complete status for the rest of this
    // session — the createResource in OnboardingGate is keyed on the signed-in
    // profile and won't refetch without a reload. Server-side state is
    // authoritative; next session boot will fetch and see completedAt set.
    markOnboardingResolvedThisSession();
    navigate("/", { replace: true });
  };

  return (
    <Show
      when={session()}
      fallback={
        <div class="onb-root">
          <div class="onb-shell">
            <h1 class="onb-headline">Sign in to continue</h1>
            <p class="onb-subhead">You need an OSN account to set up Pulse.</p>
          </div>
        </div>
      }
    >
      <OnboardingStepper displayName={displayName()} onCompleted={handleCompleted} />
    </Show>
  );
}

export default WelcomePage;
