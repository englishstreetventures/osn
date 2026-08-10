import { useAuth } from "@shared/rp-auth/solid";
import { useLocation, useNavigate } from "@solidjs/router";
import { createEffect, createResource } from "solid-js";

import { fetchOnboardingStatus, isOnboardingResolvedThisSession } from "../lib/onboarding";

/**
 * First-run gate. While a session exists, fetch onboarding status. If the
 * account hasn't completed onboarding (and the user hasn't already chosen
 * to skip this session), redirect to `/welcome`. Anonymous browsers are
 * unaffected — Pulse's public discovery surface stays open.
 *
 * The gate is keyed on the signed-in profile id, so signing out and back in
 * as someone else re-runs the check while an ordinary re-render does not.
 *
 * Lives in its own module (rather than inline in `App.tsx`) so the
 * redirect logic — the only seam between this feature and every other
 * route — has direct unit-test coverage.
 */
export function OnboardingGate() {
  const { session } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // Only the signed-in profile controls whether we fetch — NOT the pathname.
  // Including pathname in the source signal made `createResource` re-run
  // every time the user navigated `/welcome` ↔ another route (because the
  // source flipped to null and back), defeating the "once per session"
  // guarantee in the docstring (P-W1). The pathname check stays, but it's
  // moved into the redirect effect where it belongs — deciding whether to
  // navigate, not whether to fetch.
  const fetchKey = () => {
    const profileId = session()?.osnProfileId ?? null;
    if (!profileId) return null;
    if (isOnboardingResolvedThisSession()) return null;
    return profileId;
  };

  const [status] = createResource(fetchKey, fetchOnboardingStatus);

  createEffect(() => {
    const s = status();
    // Resource still loading or no token — nothing to do.
    if (!s) return;
    if (s.completedAt === null && location.pathname !== "/welcome") {
      navigate("/welcome", { replace: true });
    }
  });

  return null;
}
