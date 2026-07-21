import { AuthProvider, useAuth } from "@osn/client/solid";
import { createEffect, createSignal, onCleanup, onMount, type ParentProps, Show } from "solid-js";
import { Toaster } from "solid-toast";

import { redirectToLogin } from "../lib/api";
import { OSN_ISSUER_URL } from "../lib/osn";
import type { OrgSummary } from "../lib/vendor-store";
import ListingEditor from "./ListingEditor";
import OrgPicker from "./OrgPicker";
import VendorEnquiryInbox from "./VendorEnquiryInbox";
import VendorEnquiryThread from "./VendorEnquiryThread";

function Loading(props: { label: string }) {
  return (
    <p
      role="status"
      class="font-body text-text-muted animate-pulse text-[0.88rem] tracking-[0.1em] uppercase"
    >
      {props.label}
    </p>
  );
}

/**
 * Gate: session() is undefined while the SDK restores the session, null
 * when signed out, a Session when signed in.
 */
function RequireAuth(props: ParentProps) {
  const { session } = useAuth();

  createEffect(() => {
    if (session() === null) redirectToLogin();
  });

  return (
    <Show when={session()} fallback={<Loading label="Checking session…" />}>
      {props.children}
    </Show>
  );
}

/** Parse the org id out of the URL hash (#/orgs/:id). */
function hashOrgId(): string | null {
  if (typeof window === "undefined") return null;
  const m = window.location.hash.match(/^#\/orgs\/(.+)$/);
  return m ? decodeURIComponent(m[1]!) : null;
}

function setOrgHash(id: string) {
  if (typeof window === "undefined") return;
  const next = `#/orgs/${encodeURIComponent(id)}`;
  if (window.location.hash !== next)
    history.pushState(null, "", `${window.location.pathname}${window.location.search}${next}`);
}

function clearOrgHash() {
  if (typeof window === "undefined") return;
  if (window.location.hash !== "")
    history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
}

/** Derive the initial view from the hash on first paint. */
function initialView(): "listings" | "enquiries" {
  if (typeof window === "undefined") return "listings";
  return window.location.hash === "#/enquiries" ? "enquiries" : "listings";
}

function Dashboard() {
  const { logout, activeProfileId } = useAuth();

  // ── View toggle (account-level: "listings" | "enquiries") ────────────────
  const [view, setView] = createSignal<"listings" | "enquiries">(initialView());

  // Selected enquiry id — null when the inbox is shown; set to render the thread.
  const [selectedEnquiryId, setSelectedEnquiryId] = createSignal<string | null>(null);

  function goEnquiries() {
    setView("enquiries");
    if (typeof window !== "undefined") {
      const next = "#/enquiries";
      if (window.location.hash !== next)
        history.pushState(null, "", `${window.location.pathname}${window.location.search}${next}`);
    }
  }

  function goListings() {
    setView("listings");
    setSelectedEnquiryId(null);
    clearOrgHash();
  }

  // ── Org selection (listings view) ─────────────────────────────────────────
  // Restore from hash on first paint. We only have the id on a bare hash
  // restore — the full OrgSummary arrives once OrgPicker loads. Store name
  // alongside so ListingEditor always has it; if we only have a hash-restored
  // id with no name yet, we fall back to showing OrgPicker (see below).
  const [selectedOrg, setSelectedOrg] = createSignal<OrgSummary | null>(null);

  function selectAndHash(org: OrgSummary) {
    setSelectedOrg(org);
    setOrgHash(org.id);
  }

  function clearSelection() {
    setSelectedOrg(null);
    clearOrgHash();
  }

  // Re-sync from the hash on browser Back/Forward and manual edits.
  function onHashChange() {
    const hash = typeof window !== "undefined" ? window.location.hash : "";

    if (hash === "#/enquiries") {
      setView("enquiries");
      return;
    }

    // Any other hash → listings view. Clear stale thread selection so a Back/
    // Forward navigation doesn't reopen the thread when the user navigates away.
    setView("listings");
    setSelectedEnquiryId(null);

    const id = hashOrgId();
    if (!id) {
      setSelectedOrg(null);
    } else {
      // If the hash references an org we already have selected, keep it.
      // If it's a different id (e.g. user edited the hash), we don't have
      // the full OrgSummary — clear and let OrgPicker reload so the user
      // can re-pick (safe fallback, no over-engineering).
      const current = selectedOrg();
      if (!current || current.id !== id) setSelectedOrg(null);
    }
  }

  onMount(() => {
    window.addEventListener("hashchange", onHashChange);
    // If there's a hash on load but no org selected yet, leave selectedOrg null
    // and let OrgPicker render. OrgPicker's onPick will fill it in.
  });

  onCleanup(() => {
    if (typeof window !== "undefined") window.removeEventListener("hashchange", onHashChange);
  });

  async function signOut() {
    await logout();
    redirectToLogin();
  }

  // Shared top-bar button base classes
  const navBtnBase =
    "font-body text-[0.82rem] tracking-[0.1em] uppercase underline-offset-4 transition hover:underline";

  return (
    <div class="flex flex-col gap-8">
      {/* Top bar */}
      <div class="flex flex-wrap items-center justify-between gap-4">
        {/* Back to all orgs — only visible in listings view when an org is selected */}
        <Show when={view() === "listings" && selectedOrg()}>
          {() => (
            <button
              type="button"
              onClick={() => clearSelection()}
              class={`${navBtnBase} text-text-muted hover:text-gold self-start`}
            >
              ← All organisations
            </button>
          )}
        </Show>

        {/* Right-side controls: view toggle + sign out */}
        <div class="ml-auto flex items-center gap-4">
          {/* Listings / Enquiries toggle */}
          <button
            type="button"
            onClick={() => goListings()}
            class={`${navBtnBase} ${view() === "listings" ? "text-gold" : "text-text-muted hover:text-gold"}`}
          >
            Listings
          </button>
          <button
            type="button"
            onClick={() => goEnquiries()}
            class={`${navBtnBase} ${view() === "enquiries" ? "text-gold" : "text-text-muted hover:text-gold"}`}
          >
            Enquiries
          </button>

          <button
            type="button"
            onClick={() => void signOut()}
            class={`${navBtnBase} text-text-muted hover:text-gold`}
          >
            Sign out
          </button>
        </div>
      </div>

      {/* ── Listings view ── */}
      <Show when={view() === "listings"}>
        <Show when={selectedOrg()} fallback={<OrgPicker onPick={(o) => selectAndHash(o)} />}>
          {(o) => <ListingEditor orgId={o().id} orgName={o().name} />}
        </Show>
      </Show>

      {/* ── Enquiries view ── */}
      <Show when={view() === "enquiries"}>
        <Show
          when={selectedEnquiryId()}
          fallback={<VendorEnquiryInbox onOpen={setSelectedEnquiryId} />}
        >
          {(id) => (
            <VendorEnquiryThread
              enquiryId={id()}
              ownProfileId={activeProfileId() ?? ""}
              onBack={() => setSelectedEnquiryId(null)}
            />
          )}
        </Show>
      </Show>
    </div>
  );
}

/**
 * Single root island for the vendor dashboard page. AuthProvider wraps
 * everything so all nested components share the same auth context.
 */
export default function VendorApp() {
  return (
    <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL }}>
      <RequireAuth>
        <Dashboard />
      </RequireAuth>
      <Toaster position="bottom-right" />
    </AuthProvider>
  );
}
