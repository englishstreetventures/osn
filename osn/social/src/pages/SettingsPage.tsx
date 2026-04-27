import { useAuth } from "@osn/client/solid";
import { ProfileOnboarding } from "@osn/ui/auth/ProfileOnboarding";
import { clsx } from "@osn/ui/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@osn/ui/ui/avatar";
import { Button } from "@osn/ui/ui/button";
import { Card } from "@osn/ui/ui/card";
import { Input } from "@osn/ui/ui/input";
import { Label } from "@osn/ui/ui/label";
import { createMemo, createSignal, For, lazy, Show, Suspense } from "solid-js";

import { registrationClient } from "../lib/authClients";
import { getTokenClaims, profileInitials, safeAvatarUrl } from "../lib/utils";

// Code-split the Security section so `@simplewebauthn/browser` is only
// fetched when the user opens that tab (P-I1).
const SecuritySection = lazy(() => import("../components/SecuritySection"));
// Privacy section is also WebAuthn-dependent (step-up uses passkeys when
// available); same code-split treatment so it doesn't bloat the initial
// Settings bundle.
const PrivacySection = lazy(() => import("../components/PrivacySection"));

type Section = "profile" | "account" | "security" | "privacy" | "apps";

const SECTIONS: { value: Section; label: string }[] = [
  { value: "profile", label: "Profile" },
  { value: "account", label: "Account" },
  { value: "security", label: "Security" },
  { value: "privacy", label: "Privacy & data" },
  { value: "apps", label: "Connected apps" },
];

export function SettingsPage() {
  const { session, profiles, activeProfileId } = useAuth();
  const [section, setSection] = createSignal<Section>("profile");

  const accessToken = () => session()?.accessToken ?? null;
  const claims = createMemo(() => getTokenClaims(accessToken()));
  const activeProfile = createMemo(
    () => profiles()?.find((p) => p.id === activeProfileId()) ?? null,
  );

  return (
    <main class="mx-auto w-full max-w-2xl px-8 py-8">
      <div class="mb-6">
        <h1 class="text-foreground text-xl font-semibold tracking-tight">Settings</h1>
        <p class="text-muted-foreground mt-1 text-sm">Manage your OSN identity and account.</p>
      </div>

      <Show
        when={session()}
        fallback={
          <div class="text-muted-foreground border-border rounded-lg border border-dashed py-16 text-center text-sm">
            Sign in to manage your settings.
          </div>
        }
      >
        {/* Profile onboarding banner */}
        <div class="mb-4">
          <ProfileOnboarding checkHandle={registrationClient.checkHandle} dismissible />
        </div>

        {/* Section tabs */}
        <div class="border-border mb-6 flex gap-1 border-b">
          <For each={SECTIONS}>
            {(s) => (
              <button
                type="button"
                class={clsx(
                  "border-b-2 px-3 pb-2.5 text-[13px] font-medium transition-colors",
                  section() === s.value
                    ? "border-foreground text-foreground"
                    : "text-muted-foreground hover:text-foreground border-transparent",
                )}
                onClick={() => setSection(s.value)}
              >
                {s.label}
              </button>
            )}
          </For>
        </div>

        {/* Profile section */}
        <Show when={section() === "profile"}>
          <Card class="flex flex-col gap-5 p-5">
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
                <AvatarFallback class="text-lg">{profileInitials(activeProfile())}</AvatarFallback>
              </Avatar>
              <div>
                <p class="text-foreground font-medium">
                  {activeProfile()?.displayName || `@${claims().handle}`}
                </p>
                <p class="text-muted-foreground text-sm">@{claims().handle}</p>
              </div>
            </div>

            <div class="flex flex-col gap-1.5">
              <Label class="text-muted-foreground text-xs">Handle</Label>
              <Input value={`@${claims().handle ?? ""}`} disabled class="bg-muted/50 text-sm" />
              <p class="text-muted-foreground text-[11px]">Handles cannot be changed.</p>
            </div>

            <div class="flex flex-col gap-1.5">
              <Label class="text-muted-foreground text-xs">Display name</Label>
              <Input
                value={activeProfile()?.displayName ?? ""}
                disabled
                placeholder="No display name set"
                class="text-sm"
              />
              <p class="text-muted-foreground text-[11px]">Profile editing coming soon.</p>
            </div>
          </Card>
        </Show>

        {/* Account section */}
        <Show when={section() === "account"}>
          <Card class="flex flex-col gap-5 p-5">
            <div class="flex flex-col gap-1.5">
              <Label class="text-muted-foreground text-xs">Email</Label>
              <Input value={claims().email ?? ""} disabled class="bg-muted/50 text-sm" />
            </div>

            <div class="flex flex-col gap-1.5">
              <Label class="text-muted-foreground text-xs">Profile ID</Label>
              <Input
                value={claims().profileId ?? ""}
                disabled
                class="bg-muted/50 font-mono text-xs"
              />
            </div>

            <div class="border-border border-t pt-4">
              <h3 class="text-foreground text-sm font-semibold">Danger zone</h3>
              <p class="text-muted-foreground mt-1 mb-3 text-xs">
                Account deletion is permanent and cannot be undone.
              </p>
              <Button variant="ghost" size="sm" class="text-destructive" disabled>
                Delete account (coming soon)
              </Button>
            </div>
          </Card>
        </Show>

        {/* Security section — manage passkeys (add / rename / delete). */}
        <Show when={section() === "security"}>
          <Card class="flex flex-col gap-3 p-5">
            <Show
              when={accessToken() && claims().profileId}
              fallback={
                <p class="text-muted-foreground text-sm">Sign in to manage your passkeys.</p>
              }
            >
              <Suspense fallback={<p class="text-muted-foreground text-sm">Loading…</p>}>
                <SecuritySection accessToken={accessToken()!} profileId={claims().profileId!} />
              </Suspense>
            </Show>
          </Card>
        </Show>

        {/* Privacy & data section — GDPR Art. 15/20 + CCPA right-to-know export. */}
        <Show when={section() === "privacy"}>
          <Card class="flex flex-col gap-3 p-5">
            <Show
              when={accessToken()}
              fallback={<p class="text-muted-foreground text-sm">Sign in to manage your data.</p>}
            >
              <Suspense fallback={<p class="text-muted-foreground text-sm">Loading…</p>}>
                <PrivacySection accessToken={accessToken()!} />
              </Suspense>
            </Show>
          </Card>
        </Show>

        {/* Connected apps section */}
        <Show when={section() === "apps"}>
          <Card class="flex flex-col gap-4 p-5">
            <p class="text-muted-foreground text-sm">
              Apps connected to your OSN account can access parts of your identity and social graph.
            </p>

            {/* Static list of known apps for now */}
            <div class="flex flex-col gap-2">
              <div class="border-border flex items-center justify-between rounded-lg border px-4 py-3">
                <div>
                  <p class="text-foreground text-sm font-medium">Pulse</p>
                  <p class="text-muted-foreground text-xs">
                    Events platform — reads your profile and connections
                  </p>
                </div>
                <Button variant="secondary" size="sm" class="h-7 text-xs" disabled>
                  Connected
                </Button>
              </div>
              <div class="border-border flex items-center justify-between rounded-lg border px-4 py-3">
                <div>
                  <p class="text-foreground text-sm font-medium">Zap</p>
                  <p class="text-muted-foreground text-xs">
                    Messaging — reads your profile and connections
                  </p>
                </div>
                <Button variant="secondary" size="sm" class="h-7 text-xs" disabled>
                  Connected
                </Button>
              </div>
            </div>

            <p class="text-muted-foreground text-[11px]">
              App authorization management and scope controls coming soon.
            </p>
          </Card>
        </Show>
      </Show>
    </main>
  );
}
