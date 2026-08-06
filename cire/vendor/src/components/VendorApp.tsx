import { AuthProvider, useAuth } from "@shared/rp-auth/solid";
import { createEffect, createSignal, onCleanup, onMount, type ParentProps, Show } from "solid-js";
import { Toaster } from "solid-toast";

import { redirectToLogin } from "../lib/api";
import { createAutoSize } from "../lib/auto-size";
import { CIRE_API_URL } from "../lib/osn";
import { initTheme } from "../lib/theme";
import type { OrgSummary } from "../lib/vendor-store";
import ListingEditor from "./ListingEditor";
import OrgPicker from "./OrgPicker";
import TopBar from "./TopBar";
import Button from "./ui/Button";
import Loading from "./ui/Loading";
import VendorEnquiryInbox from "./VendorEnquiryInbox";
import VendorEnquiryThread from "./VendorEnquiryThread";
import type { VendorView } from "./ViewTabs";

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
    <Show
      when={session()}
      fallback={
        <div class="page-frame py-16">
          <Loading label="Checking session…" />
        </div>
      }
    >
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
function initialView(): VendorView {
  if (typeof window === "undefined") return "listings";
  return window.location.hash === "#/enquiries" ? "enquiries" : "listings";
}

function Dashboard() {
  const { logout, activeProfileId, session } = useAuth();

  // ── View toggle (account-level: "listings" | "enquiries") ────────────────
  const [view, setView] = createSignal<VendorView>(initialView());

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

  function goView(next: VendorView) {
    if (next === "enquiries") goEnquiries();
    else goListings();
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

  // The design law: the panel keeps its box and animates to the new content's
  // height, so nothing in the chrome above it moves when a view is swapped.
  // The frame holds no height at rest — see `lib/auto-size.ts`.
  const panel = createAutoSize();

  // What the panel is currently showing, as one value. The key on the inner
  // `panel-in` box: change it and the fade replays, leave it and it does not.
  // Selecting an org or opening an enquiry is a content swap like any other, so
  // both are in the key.
  const panelKey = () =>
    view() === "enquiries"
      ? `enquiries:${selectedEnquiryId() ?? "inbox"}`
      : `listings:${selectedOrg()?.id ?? "picker"}`;

  return (
    <>
      <TopBar
        session={session()}
        view={view()}
        onView={goView}
        onHome={goListings}
        onSignOut={() => void signOut()}
      />

      <main class="page-frame py-8 @2xl/frame:py-10">
        <div ref={panel.frame}>
          {/* `flow-root` so a child's top margin cannot escape the measured box
              and change the height depending on whether the frame was clipped
              at the time. */}
          <div ref={panel.content} class="flow-root">
            <Show when={panelKey()} keyed>
              {(key: string) => (
                <div class="panel-in" data-panel={key}>
                  {/* ── Listings view ── */}
                  <Show when={view() === "listings"}>
                    <Show
                      when={selectedOrg()}
                      fallback={<OrgPicker onPick={(o) => selectAndHash(o)} />}
                    >
                      {(o) => (
                        <div class="flex flex-col gap-4">
                          <Button
                            variant="quiet"
                            size="sm"
                            onClick={() => clearSelection()}
                            class="self-start"
                          >
                            ← All organisations
                          </Button>
                          <ListingEditor orgId={o().id} orgName={o().name} />
                        </div>
                      )}
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
              )}
            </Show>
          </div>
        </div>
      </main>
    </>
  );
}

/**
 * Single root island for the vendor dashboard page. AuthProvider wraps
 * everything so all nested components share the same auth context.
 *
 * The island owns the chrome and `<main>`, rather than being dropped into a
 * masthead the `.astro` page built. One row of chrome, and the island is what
 * knows which view is open — so the bar and the panel cannot disagree.
 */
export default function VendorApp() {
  // Keep following the OS after the boot script's one-shot resolution: a vendor
  // on "system" whose machine flips at sunset sees the portal flip with it.
  onMount(() => onCleanup(initTheme()));

  return (
    <AuthProvider config={{ apiBase: CIRE_API_URL }}>
      <RequireAuth>
        <Dashboard />
      </RequireAuth>
      <Toaster position="bottom-right" />
    </AuthProvider>
  );
}
