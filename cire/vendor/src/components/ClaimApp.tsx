import { createLoginClient, createRecoveryClient } from "@osn/client";
import { AuthProvider, useAuth } from "@osn/client/solid";
import { SignIn } from "@osn/ui/auth";
import { createResource, createSignal, onMount, Show } from "solid-js";

import { OSN_ISSUER_URL } from "../lib/osn";
import { consumeClaim, fetchClaimPreview } from "../lib/vendor-store";
import type { OrgSummary } from "../lib/vendor-store";
import OrgPicker from "./OrgPicker";

const loginClient = createLoginClient({ issuerUrl: OSN_ISSUER_URL });
const recoveryClient = createRecoveryClient({ issuerUrl: OSN_ISSUER_URL });

function ClaimContent() {
  const { session, authFetch } = useAuth();

  // Step 1: Read token from URL and immediately strip it from the visible URL.
  // Guard typeof window — this component is only used client:only but be safe.
  const [token, setToken] = createSignal<string>("");
  const [invalidLink, setInvalidLink] = createSignal(false);

  onMount(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token") ?? "";
    setToken(t);
    // Immediately strip the token from the URL to prevent it appearing in
    // browser history, referrer headers, or server logs.
    history.replaceState(null, "", "/claim");
  });

  // Step 2: Fetch invite preview (unauthenticated).
  const [preview] = createResource(token, async (t) => {
    if (!t) return null;
    return await fetchClaimPreview(t);
  });

  // Step 4: Consume the claim on org pick.
  const handleClaim = async (org: OrgSummary) => {
    try {
      await consumeClaim(authFetch, token(), org.id);
      window.location.href = "/#/orgs/" + org.id;
    } catch {
      setInvalidLink(true);
    }
  };

  return (
    <div class="font-body flex flex-col gap-8">
      {/* Invalid / expired / consumed token */}
      <Show when={invalidLink() || (preview.state === "ready" && preview() === null)}>
        <p class="text-text text-[0.95rem]">This invite link is no longer valid.</p>
      </Show>

      {/* Valid preview — show invite banner */}
      <Show when={preview.state === "ready" && preview() !== null && !invalidLink()}>
        <div class="flex flex-col gap-2">
          <p class="text-text-muted text-[0.82rem] tracking-[0.1em] uppercase">
            You've been invited to claim
          </p>
          <p class="text-text text-[1.1rem] font-medium">
            <strong>{preview()?.name}</strong>
          </p>
        </div>

        {/* Auth gate */}
        <Show
          when={session() !== null && session() !== undefined}
          fallback={
            <div class="flex flex-col gap-4">
              <p class="text-text-muted text-[0.85rem]">Sign in to your OSN account to continue.</p>
              <SignIn client={loginClient} recoveryClient={recoveryClient} onSuccess={() => {}} />
            </div>
          }
        >
          <div class="flex flex-col gap-4">
            <h2 class="text-gold font-body text-[0.72rem] tracking-[0.2em] uppercase">
              Choose the organisation that owns this listing
            </h2>
            <OrgPicker onPick={(org) => void handleClaim(org)} />
          </div>
        </Show>
      </Show>

      {/* Loading state */}
      <Show when={preview.loading}>
        <p
          role="status"
          class="font-body text-text-muted animate-pulse text-[0.88rem] tracking-[0.1em] uppercase"
        >
          Checking invite…
        </p>
      </Show>
    </div>
  );
}

/**
 * Root island for the /claim page. Reads the invite token from the URL,
 * immediately strips it from the visible URL (security), fetches the preview,
 * and walks the user through sign-in → org pick → consume claim.
 */
export default function ClaimApp() {
  return (
    <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL }}>
      <ClaimContent />
    </AuthProvider>
  );
}
