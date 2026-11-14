import { ProfileOnboarding } from "@osn/auth-ui/ProfileOnboarding";
import { useAuth } from "@osn/client/solid";
import { Avatar, AvatarFallback, AvatarImage } from "@shared/ui/ui/avatar";
import { Button } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { Input } from "@shared/ui/ui/input";
import { Label } from "@shared/ui/ui/label";
import { useLocation, useNavigate } from "@solidjs/router";
import { createMemo, lazy, Show, Suspense } from "solid-js";

import { AppRowsLoading } from "../components/AppRowsLoading";
import { ResponsiveSkeleton } from "../components/ResponsiveSkeleton";
import { SectionTabs } from "../components/SectionTabs";
import { SignedOutNote } from "../components/SignedOutNote";
import { PRODUCT_NAME } from "../lib/auth";
import { registrationClient } from "../lib/authClients";
import { placeholderRows } from "../lib/page-cache";
import { usePageTitle } from "../lib/page-title";
import { getTokenClaims, profileInitials, safeAvatarUrl } from "../lib/utils";

// Code-split the Security section so `@simplewebauthn/browser` is only
// fetched when the user opens that tab.
const SecuritySection = lazy(() => import("../components/SecuritySection"));
const ConnectedAppsSection = lazy(() =>
  import("../components/ConnectedAppsSection").then((m) => ({ default: m.ConnectedAppsSection })),
);

type Section = "profile" | "account" | "security" | "apps";

const SECTIONS: { value: Section; label: string }[] = [
  { value: "profile", label: "Profile" },
  { value: "account", label: "Account" },
  { value: "security", label: "Security" },
  { value: "apps", label: "Connected apps" },
];

/**
 * The tab named by the URL fragment (`/settings#security`), falling back to
 * Profile for a missing or unknown one. Other apps deep-link in: the cire
 * organiser portal sends people to `#security`, because passkeys are bound to
 * this origin's RP ID and can only be managed here.
 */
function sectionFromHash(hash: string): Section {
  const value = hash.replace(/^#/, "");
  return SECTIONS.some((s) => s.value === value) ? (value as Section) : "profile";
}

export function SettingsPage() {
  const { session, profiles, activeProfileId } = useAuth();
  usePageTitle(() => "Settings");
  const location = useLocation();
  const navigate = useNavigate();

  // The fragment in the router's location is the only source of truth for
  // which tab is open, so every way of arriving at one behaves the same: a
  // deep link from another origin, Back and Forward, a tab click, and a link
  // from elsewhere in this app to `/settings#security` while Settings is
  // already open. That last one is why this reads the router rather than
  // `window.location` and a `hashchange` listener — neither `pushState` nor
  // `replaceState` fires that event, so a same-route link used to change the
  // address bar and leave the tab where it was.
  const section = () => sectionFromHash(location.hash);

  const selectSection = (value: Section) => {
    // The whole path, never a bare `#value`: the router resolves a bare
    // fragment against its base rather than the current route.
    //
    // `replace` so switching tabs does not pile up history entries between
    // the page you came from and the page you leave to. `scroll: false` so a
    // tab click leaves the reading position alone.
    navigate(`/settings#${value}`, { replace: true, scroll: false });
  };

  // Claims are read for display and the profile id only; no request carries
  // this token — every client sends through the page's auth runtime.
  const claims = createMemo(() => getTokenClaims(session()?.accessToken ?? null));
  const activeProfile = createMemo(
    () => profiles()?.find((p) => p.id === activeProfileId()) ?? null,
  );

  return (
    <main class="mx-auto w-full max-w-2xl px-4 py-6 md:px-8 md:py-8">
      <div class="mb-6">
        <h1 class="text-foreground text-display font-medium">Settings</h1>
        <p class="text-muted-foreground text-body mt-1">
          Manage your {PRODUCT_NAME} identity and account.
        </p>
      </div>

      <Show
        when={session()}
        fallback={<SignedOutNote>Sign in to manage your settings.</SignedOutNote>}
      >
        {/* Profile onboarding banner */}
        <div class="mb-4">
          <ProfileOnboarding checkHandle={registrationClient.checkHandle} dismissible />
        </div>

        <SectionTabs
          label="Settings sections"
          tabs={SECTIONS}
          current={section()}
          onSelect={selectSection}
          class="mb-6"
        />

        {/* Profile section */}
        <Show when={section() === "profile"}>
          <Card padding="md" class="flex flex-col gap-5">
            <div class="flex items-center gap-4">
              <Avatar class="h-16 w-16">
                <Show when={safeAvatarUrl(activeProfile()?.avatarUrl)}>
                  {(url) => (
                    <AvatarImage
                      src={url()}
                      alt={claims().handle ?? ""}
                      referrerpolicy="no-referrer"
                      loading="lazy"
                    />
                  )}
                </Show>
                <AvatarFallback size="lg">{profileInitials(activeProfile())}</AvatarFallback>
              </Avatar>
              <div>
                <p class="text-foreground text-title font-medium">
                  {activeProfile()?.displayName || `@${claims().handle ?? "…"}`}
                </p>
                <p class="text-muted-foreground text-meta">@{claims().handle ?? "…"}</p>
              </div>
            </div>

            <div class="flex flex-col gap-1.5">
              <Label tone="muted" size="sm">
                Handle
              </Label>
              <Input value={`@${claims().handle ?? ""}`} disabled />
              <p class="text-muted-foreground text-meta">Handles cannot be changed.</p>
            </div>

            <div class="flex flex-col gap-1.5">
              <Label tone="muted" size="sm">
                Display name
              </Label>
              <Input
                value={activeProfile()?.displayName ?? ""}
                disabled
                placeholder="No display name set"
              />
              <p class="text-muted-foreground text-meta">Profile editing coming soon.</p>
            </div>
          </Card>
        </Show>

        {/* Account section */}
        <Show when={section() === "account"}>
          <Card padding="md" class="flex flex-col gap-5">
            <div class="flex flex-col gap-1.5">
              <Label tone="muted" size="sm">
                Email
              </Label>
              <Input value={claims().email ?? ""} disabled />
            </div>

            <div class="flex flex-col gap-1.5">
              <Label tone="muted" size="sm">
                Profile ID
              </Label>
              <Input value={claims().profileId ?? ""} disabled face="code" />
            </div>

            <div class="border-border border-t pt-4">
              <h3 class="text-foreground text-title font-medium">Danger zone</h3>
              <p class="text-muted-foreground text-meta mt-1 mb-3">
                Account deletion is permanent and cannot be undone.
              </p>
              <Button variant="ghostDanger" size="sm" disabled>
                Delete account (coming soon)
              </Button>
            </div>
          </Card>
        </Show>

        {/* Security section — manage passkeys (add / rename / delete). */}
        <Show when={section() === "security"}>
          <Card padding="md" class="flex flex-col gap-3">
            <Show
              when={claims().profileId}
              fallback={
                <p class="text-muted-foreground text-body">Sign in to manage your passkeys.</p>
              }
            >
              {(profileId) => (
                <Suspense fallback={<SecurityLoading />}>
                  <SecuritySection profileId={profileId()} />
                </Suspense>
              )}
            </Show>
          </Card>
        </Show>

        {/* Connected apps section */}
        <Show when={section() === "apps"}>
          <Card padding="md" class="flex flex-col gap-4">
            {/* Static words, so they show while the section's code loads. */}
            <p class="text-muted-foreground text-body">
              Apps you have signed in to with your {PRODUCT_NAME} account. Revoking removes an app's
              access; it will ask for your consent again the next time you sign in there.
            </p>
            <Suspense fallback={<ConnectedAppsLoading />}>
              <ConnectedAppsSection />
            </Suspense>
          </Card>
        </Show>
      </Show>
    </main>
  );
}

/*
 * A Suspense fallback goes when the section lands, and nothing holds both, so
 * each fallback's own wrapper carries `aria-busy` and leaves with it.
 */

/**
 * The Security section's place while its code loads: the passkeys' head and
 * one row, each as tall as `@osn/auth-ui`'s at each width. Below `md` the
 * head's "Add a passkey" is 40px tall, and the row's actions sit under its
 * words, 40px tall: 144px, against 92px from `md`. The package keeps its own
 * placeholder internal, so these numbers copy it; `LoadingShapes.browser.test.tsx`
 * fails when the two part.
 */
function SecurityLoading() {
  return (
    <div aria-busy="true" class="flex flex-col gap-3">
      <ResponsiveSkeleton standsFor="line" width={24} height={8} phoneHeight={10} />
      <ResponsiveSkeleton standsFor="row" height={23} phoneHeight={36} />
    </div>
  );
}

/** The connected apps' list's place while their code loads: as many rows as it last landed, one when none. */
function ConnectedAppsLoading() {
  return (
    <div aria-busy="true">
      <AppRowsLoading count={placeholderRows("settings.apps")} />
    </div>
  );
}
