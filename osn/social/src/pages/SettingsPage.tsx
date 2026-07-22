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

type Section = "profile" | "account" | "security" | "apps";

const SECTIONS: { value: Section; label: string }[] = [
  { value: "profile", label: "Profile" },
  { value: "account", label: "Account" },
  { value: "security", label: "Security" },
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
        <h1 class="text-foreground text-display font-medium">Settings</h1>
        <p class="text-muted-foreground text-body mt-1">Manage your OSN identity and account.</p>
      </div>

      <Show
        when={session()}
        fallback={
          <div class="text-muted-foreground border-border rounded-card text-body border border-dashed py-16 text-center">
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
                  "border-b-2 px-3 pb-2.5 text-body font-medium transition-colors",
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
          <Card class="rounded-card flex flex-col gap-5 p-5">
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
                <AvatarFallback class="text-display">
                  {profileInitials(activeProfile())}
                </AvatarFallback>
              </Avatar>
              <div>
                <p class="text-foreground font-medium">
                  {activeProfile()?.displayName || `@${claims().handle}`}
                </p>
                <p class="text-muted-foreground text-body">@{claims().handle}</p>
              </div>
            </div>

            <div class="flex flex-col gap-1.5">
              <Label class="text-subtle text-meta">Handle</Label>
              <Input value={`@${claims().handle ?? ""}`} disabled class="bg-muted/50 text-body" />
              <p class="text-subtle text-meta">Handles cannot be changed.</p>
            </div>

            <div class="flex flex-col gap-1.5">
              <Label class="text-subtle text-meta">Display name</Label>
              <Input
                value={activeProfile()?.displayName ?? ""}
                disabled
                placeholder="No display name set"
                class="text-body"
              />
              <p class="text-subtle text-meta">Profile editing coming soon.</p>
            </div>
          </Card>
        </Show>

        {/* Account section */}
        <Show when={section() === "account"}>
          <Card class="rounded-card flex flex-col gap-5 p-5">
            <div class="flex flex-col gap-1.5">
              <Label class="text-subtle text-meta">Email</Label>
              <Input value={claims().email ?? ""} disabled class="bg-muted/50 text-body" />
            </div>

            <div class="flex flex-col gap-1.5">
              <Label class="text-subtle text-meta">Profile ID</Label>
              <Input
                value={claims().profileId ?? ""}
                disabled
                class="bg-muted/50 text-meta font-mono"
              />
            </div>

            <div class="border-border border-t pt-4">
              <h3 class="text-foreground text-title font-medium">Danger zone</h3>
              <p class="text-subtle text-meta mt-1 mb-3">
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
          <Card class="rounded-card flex flex-col gap-3 p-5">
            <Show
              when={accessToken() && claims().profileId}
              fallback={
                <p class="text-muted-foreground text-body">Sign in to manage your passkeys.</p>
              }
            >
              <Suspense fallback={<p class="text-muted-foreground text-body">Loading…</p>}>
                <SecuritySection accessToken={accessToken()!} profileId={claims().profileId!} />
              </Suspense>
            </Show>
          </Card>
        </Show>

        {/* Connected apps section */}
        <Show when={section() === "apps"}>
          <Card class="rounded-card flex flex-col gap-4 p-5">
            <p class="text-muted-foreground text-body">
              Apps connected to your OSN account can access parts of your identity and social graph.
            </p>

            {/* Static list of known apps for now */}
            <div class="flex flex-col gap-2">
              <div class="border-border rounded-card flex items-center justify-between border px-4 py-3">
                <div>
                  <p class="text-foreground text-title font-medium">Pulse</p>
                  <p class="text-subtle text-meta">
                    Events platform — reads your profile and connections
                  </p>
                </div>
                <Button variant="secondary" size="sm" class="text-body rounded-pill h-7" disabled>
                  Connected
                </Button>
              </div>
              <div class="border-border rounded-card flex items-center justify-between border px-4 py-3">
                <div>
                  <p class="text-foreground text-title font-medium">Zap</p>
                  <p class="text-subtle text-meta">
                    Messaging — reads your profile and connections
                  </p>
                </div>
                <Button variant="secondary" size="sm" class="text-body rounded-pill h-7" disabled>
                  Connected
                </Button>
              </div>
            </div>

            <p class="text-subtle text-meta">
              App authorization management and scope controls coming soon.
            </p>
          </Card>
        </Show>
      </Show>
    </main>
  );
}
