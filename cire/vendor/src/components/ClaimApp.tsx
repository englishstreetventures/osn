import { AuthProvider, useAuth } from "@shared/rp-auth/solid";
import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js";

import { haptic } from "../lib/haptics";
import { CIRE_API_URL } from "../lib/osn";
import { initTheme } from "../lib/theme";
import { consumeClaim, fetchClaimPreview } from "../lib/vendor-store";
import type { OrgSummary } from "../lib/vendor-store";
import OrgPicker from "./OrgPicker";
import Button from "./ui/Button";
import Card, { CardEyebrow } from "./ui/Card";
import Loading from "./ui/Loading";
import Notice from "./ui/Notice";

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
      haptic("commit");
      sessionStorage.removeItem(CLAIM_TOKEN_KEY);
      window.location.href = "/#/orgs/" + org.id;
    } catch {
      // Spent or rejected either way — do not leave it parked for a reload.
      haptic("reject");
      sessionStorage.removeItem(CLAIM_TOKEN_KEY);
      setInvalidLink(true);
    }
  };

  const isDead = () => invalidLink() || (preview.state === "ready" && preview() === null);

  return (
    <div class="flex flex-col gap-8">
      {/* Invalid / expired / consumed token. It was a bare grey line of text
          before, which is the same treatment the page gives its body copy — the
          one message on this page that means "stop" read as prose. `alert` only
          on the branch reached by *doing* something (a claim that came back
          rejected), not on the one that was already true when the page loaded. */}
      <Show when={isDead()}>
        <Notice tone="error" alert={invalidLink()}>
          This invite link is no longer valid. Ask whoever sent it for a new one.
        </Notice>
      </Show>

      <Show when={preview.loading}>
        <Loading label="Checking invite…" />
      </Show>

      {/* Valid preview — show invite banner */}
      <Show when={preview.state === "ready" && preview() !== null && !invalidLink()}>
        <Card tone="accent">
          <CardEyebrow>You've been invited to claim</CardEyebrow>
          <p class="font-display text-text text-[1.6rem] leading-tight font-light">
            {preview()?.name}
          </p>
        </Card>

        {/* Auth gate */}
        <Show
          when={session() !== null && session() !== undefined}
          fallback={
            <div class="flex flex-col gap-4">
              <p class="font-body text-text-muted text-[0.88rem] leading-relaxed">
                Sign in with your musubi account to continue. We'll bring you straight back here.
              </p>
              <Button
                variant="primary"
                onClick={() => signIn(new URL("/claim", window.location.origin).toString())}
                class="self-start"
              >
                Continue with musubi
              </Button>
            </div>
          }
        >
          <div class="flex flex-col gap-4">
            <h2 class="font-body text-gold text-[0.7rem] tracking-[0.18em] uppercase">
              Choose the organisation that owns this listing
            </h2>
            <OrgPicker onPick={(org) => void handleClaim(org)} />
          </div>
        </Show>
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
  // This page is its own document, so it needs its own subscription to the OS
  // theme — `VendorApp` is not mounted here to do it.
  onMount(() => onCleanup(initTheme()));

  return (
    <AuthProvider config={{ apiBase: CIRE_API_URL }}>
      <ClaimContent />
    </AuthProvider>
  );
}
