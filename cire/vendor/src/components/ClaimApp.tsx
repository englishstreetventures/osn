import { AuthProvider, useAuth } from "@shared/rp-auth/solid";
import { createResource, createSignal, onMount, Show } from "solid-js";

import { CIRE_API_URL } from "../lib/osn";
import { consumeClaim, fetchClaimPreview } from "../lib/vendor-store";
import type { OrgSummary } from "../lib/vendor-store";
import OrgPicker from "./OrgPicker";

/** Where the invite token waits while the vendor is away signing in. */
const CLAIM_TOKEN_KEY = "cire.vendor.claim-token";

function ClaimContent() {
  const { session, authFetch, signIn } = useAuth();

  // Step 1: Read token from URL and immediately strip it from the visible URL.
  // Guard typeof window — this component is only used client:only but be safe.
  const [token, setToken] = createSignal<string>("");
  const [invalidLink, setInvalidLink] = createSignal(false);

  onMount(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("token") ?? "";
    if (fromUrl) {
      // Sign-in is a redirect to musubi and back, so the page unloads and an
      // in-memory token would not survive it. Park it in sessionStorage:
      // same-origin, tab-scoped, and dropped as soon as the claim lands.
      sessionStorage.setItem(CLAIM_TOKEN_KEY, fromUrl);
      // Immediately strip the token from the URL to prevent it appearing in
      // browser history, referrer headers, or server logs.
      history.replaceState(null, "", "/claim");
    }
    setToken(fromUrl || (sessionStorage.getItem(CLAIM_TOKEN_KEY) ?? ""));
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
      sessionStorage.removeItem(CLAIM_TOKEN_KEY);
      window.location.href = "/#/orgs/" + org.id;
    } catch {
      // Spent or rejected either way — do not leave it parked for a reload.
      sessionStorage.removeItem(CLAIM_TOKEN_KEY);
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
              <p class="text-text-muted text-[0.85rem]">
                Sign in with your musubi account to continue. We'll bring you straight back here.
              </p>
              <button
                type="button"
                onClick={() => signIn(new URL("/claim", window.location.origin).toString())}
                class="border-gold font-body text-gold hover:bg-gold hover:text-bg self-start rounded-sm border px-5 py-2.5 text-[0.82rem] tracking-[0.1em] uppercase transition-colors duration-200"
              >
                Continue with musubi
              </button>
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
    <AuthProvider config={{ apiBase: CIRE_API_URL }}>
      <ClaimContent />
    </AuthProvider>
  );
}
