import type { PublicProfile } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { Register } from "@osn/ui/auth/Register";
import { SignIn } from "@osn/ui/auth/SignIn";
import { Avatar, AvatarFallback, AvatarImage } from "@osn/ui/ui/avatar";
import { Dialog, DialogContent } from "@osn/ui/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@osn/ui/ui/dropdown-menu";
import { useNavigate } from "@solidjs/router";
import { createMemo, createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import { registrationClient, loginClient, recoveryClient } from "../lib/authClients";
import { setShowCreateForm } from "../lib/createEventSignal";
import { getTokenClaims } from "../lib/utils";
import { Icon } from "./icons";

const TABS = [
  { id: "home", label: "Home" },
  { id: "calendar", label: "Calendar" },
  { id: "hosting", label: "Hosting" },
] as const;

function profileInitials(profile: PublicProfile | null): string {
  if (!profile) return "?";
  const name = profile.displayName || profile.handle;
  return name.slice(0, 2).toUpperCase();
}

export function ExploreNav(props: {
  query: string;
  onQueryChange: (q: string) => void;
  eventCount?: number;
  liveCount?: number;
}) {
  const { session, logout, profiles, activeProfileId, switchProfile } = useAuth();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = createSignal<string>("home");
  const [showRegister, setShowRegister] = createSignal(false);
  const [showSignIn, setShowSignIn] = createSignal(false);
  const [showSwitcher, setShowSwitcher] = createSignal(false);
  const [switching, setSwitching] = createSignal(false);

  const accessToken = () => session()?.accessToken ?? null;
  const claims = createMemo(() => getTokenClaims(accessToken()));
  const activeProfile = createMemo(
    () => profiles()?.find((p) => p.id === activeProfileId()) ?? null,
  );

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const timeOfDay =
    hour < 6
      ? "late"
      : hour < 12
        ? "morning"
        : hour < 17
          ? "afternoon"
          : hour < 21
            ? "evening"
            : "tonight";
  const displayName = () => claims().displayName?.split(" ")[0] ?? claims().handle ?? "";

  async function handleSwitch(profile: PublicProfile) {
    if (switching() || profile.id === activeProfileId()) return;
    setSwitching(true);
    try {
      const result = await switchProfile(profile.id);
      setShowSwitcher(false);
      toast.success(`Switched to @${result.profile.handle}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to switch profile");
    } finally {
      setSwitching(false);
    }
  }

  return (
    <>
      <header
        class="border-border sticky top-0 z-30 border-b"
        style={{
          background: "color-mix(in oklab, var(--background) 88%, transparent)",
          "backdrop-filter": "blur(16px) saturate(140%)",
        }}
      >
        {/* Top row: brand + tabs + search + actions */}
        <div class="border-border flex items-center gap-6 border-b px-8 py-3.5">
          {/* Brand */}
          <div
            class="flex shrink-0 items-center gap-2.5"
            style={{ "font-family": "var(--font-serif)" }}
          >
            <span
              class="grid h-[26px] w-[26px] place-items-center rounded-full"
              style={{
                background: "var(--pulse-accent)",
                "box-shadow": "0 0 0 4px color-mix(in oklab, var(--pulse-accent) 22%, transparent)",
              }}
              aria-hidden="true"
            >
              <span
                class="brand-pulse h-2 w-2 rounded-full"
                style={{ background: "var(--card)" }}
              />
            </span>
            <span class="pb-0.5 text-[26px] tracking-tight">Pulse</span>
          </div>

          {/* Tabs */}
          <nav class="flex gap-0.5">
            <For each={TABS}>
              {(tab) => (
                <Show when={tab.id === "home" || session()}>
                  <button
                    type="button"
                    class={`relative rounded-lg px-3.5 py-2 text-[13.5px] font-medium transition-colors ${
                      activeTab() === tab.id
                        ? "explore-tab-active bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                    }`}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                </Show>
              )}
            </For>
          </nav>

          {/* Right side */}
          <div class="ml-auto flex items-center gap-2.5">
            {/* Search */}
            <div class="border-border bg-background focus-within:border-foreground/20 focus-within:ring-ring/20 flex max-w-[360px] flex-1 items-center gap-2 rounded-full border px-3.5 py-2 transition-shadow focus-within:ring-4">
              <Icon name="search" size={14} />
              <input
                type="text"
                value={props.query}
                onInput={(e) => props.onQueryChange(e.currentTarget.value)}
                placeholder="Search events, people, venues…"
                class="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-[13px] outline-none"
              />
              <kbd
                class="border-border bg-card text-muted-foreground rounded-[5px] border px-1.5 py-0.5 text-[10px]"
                style={{ "font-family": "var(--font-mono)" }}
              >
                ⌘K
              </kbd>
            </div>

            <Show
              when={session()}
              fallback={
                <button
                  type="button"
                  class="inline-flex h-9 items-center gap-2 rounded-full border border-transparent px-3.5 text-[13px] font-medium text-[var(--pulse-accent-fg)]"
                  style={{ background: "var(--pulse-accent)" }}
                  onClick={() => setShowSignIn(true)}
                >
                  Sign in
                </button>
              }
            >
              {/* Notifications */}
              <button
                type="button"
                class="border-border bg-card hover:bg-secondary relative inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-[13px] font-medium"
                title="Notifications"
              >
                <Icon name="bell" size={14} />
              </button>

              {/* Host CTA */}
              <button
                type="button"
                class="inline-flex h-9 items-center gap-2 rounded-full border border-transparent px-3.5 text-[13px] font-medium text-[var(--pulse-accent-fg)] hover:opacity-90"
                style={{ background: "var(--pulse-accent)" }}
                onClick={() => setShowCreateForm((v) => !v)}
              >
                <Icon name="plus" size={14} />
                Host
              </button>

              {/* Avatar dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger class="focus-visible:ring-ring cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-offset-2">
                  <Avatar class="h-[34px] w-[34px]">
                    <Show when={activeProfile()?.avatarUrl}>
                      {(url) => <AvatarImage src={url()} alt={activeProfile()!.handle} />}
                    </Show>
                    <AvatarFallback class="text-xs">
                      {profileInitials(activeProfile())}
                    </AvatarFallback>
                  </Avatar>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel class="text-muted-foreground font-normal">
                      @{claims().handle ?? "..."}
                    </DropdownMenuLabel>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setShowSwitcher(true)}>
                    Switch profile
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => navigate("/settings")}>
                    Settings
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => logout()}>Log out</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </Show>
          </div>
        </div>

        {/* Hero row */}
        <div
          class="grid items-end gap-10 px-8 pt-8 pb-6"
          style={{ "grid-template-columns": "1fr auto" }}
        >
          <div>
            <div
              class="text-muted-foreground mb-2.5 inline-flex items-center gap-[7px] text-xs tracking-wider"
              style={{ "font-family": "var(--font-mono)" }}
            >
              <span
                class="live-dot inline-block h-[7px] w-[7px] rounded-full"
                style={{
                  background: "var(--badge-live)",
                  "box-shadow": "0 0 0 3px color-mix(in oklab, var(--badge-live) 30%, transparent)",
                }}
              />
              <Show when={displayName()} fallback={<>{greeting}</>}>
                {greeting}, {displayName()}
              </Show>
              {" · "}
              <b class="text-foreground font-semibold">
                {new Date().toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "short",
                  day: "numeric",
                })}
              </b>
            </div>
            <h1
              class="m-0 max-w-[16ch] font-normal"
              style={{
                "font-family": "var(--font-serif)",
                "font-size": "clamp(32px, 4.4vw, 56px)",
                "line-height": "1.02",
                "letter-spacing": "-0.025em",
                "text-wrap": "pretty",
              }}
            >
              <span class="mr-[0.2em]">Here's what's</span>{" "}
              <span class="italic" style={{ color: "var(--pulse-accent)" }}>
                pulsing
              </span>{" "}
              <span>nearby this {timeOfDay}.</span>
            </h1>
          </div>

          <div class="flex gap-7 pb-1.5">
            <Show when={typeof props.eventCount === "number"}>
              <div class="text-left">
                <div
                  class="text-[34px] leading-none"
                  style={{ "font-family": "var(--font-serif)", "letter-spacing": "-0.02em" }}
                >
                  {props.eventCount}
                </div>
                <div
                  class="text-muted-foreground mt-1 text-[10.5px] tracking-wider uppercase"
                  style={{ "font-family": "var(--font-mono)" }}
                >
                  events nearby
                </div>
              </div>
            </Show>
            <Show when={typeof props.liveCount === "number" && props.liveCount! > 0}>
              <div class="text-left">
                <div
                  class="text-[34px] leading-none"
                  style={{ "font-family": "var(--font-serif)", "letter-spacing": "-0.02em" }}
                >
                  {props.liveCount}
                </div>
                <div
                  class="text-muted-foreground mt-1 text-[10.5px] tracking-wider uppercase"
                  style={{ "font-family": "var(--font-mono)" }}
                >
                  happening now
                </div>
              </div>
            </Show>
          </div>
        </div>
      </header>

      {/* Auth dialogs */}
      <Dialog open={showSignIn() && !session()} onOpenChange={setShowSignIn}>
        <DialogContent class="max-w-sm p-0">
          <SignIn
            client={loginClient}
            recoveryClient={recoveryClient}
            onCancel={() => setShowSignIn(false)}
            onSuccess={() => setShowSignIn(false)}
          />
          <div class="border-border text-muted-foreground border-t px-6 py-4 text-center text-sm">
            Don't have an account?{" "}
            <button
              type="button"
              class="text-foreground font-medium hover:underline"
              onClick={() => {
                setShowSignIn(false);
                setShowRegister(true);
              }}
            >
              Register here
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={showRegister() && !session()} onOpenChange={setShowRegister}>
        <DialogContent class="max-w-sm p-0">
          <Register client={registrationClient} onCancel={() => setShowRegister(false)} />
          <div class="border-border text-muted-foreground border-t px-6 py-4 text-center text-sm">
            Already have an account?{" "}
            <button
              type="button"
              class="text-foreground font-medium hover:underline"
              onClick={() => {
                setShowRegister(false);
                setShowSignIn(true);
              }}
            >
              Sign in
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Profile switcher */}
      <Dialog open={showSwitcher()} onOpenChange={setShowSwitcher}>
        <DialogContent class="max-w-xs">
          <div class="flex flex-col gap-1 py-2">
            <For each={profiles() ?? []}>
              {(profile) => {
                const isActive = () => profile.id === activeProfileId();
                return (
                  <button
                    type="button"
                    class={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                      isActive()
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-muted"
                    }`}
                    disabled={switching()}
                    onClick={() => handleSwitch(profile)}
                  >
                    <Avatar class="h-7 w-7">
                      <Show when={profile.avatarUrl}>
                        {(url) => <AvatarImage src={url()} alt={profile.handle} />}
                      </Show>
                      <AvatarFallback class="text-[10px]">
                        {profileInitials(profile)}
                      </AvatarFallback>
                    </Avatar>
                    <span class="flex-1 truncate">
                      @{profile.handle}
                      <Show when={profile.displayName}>
                        <span class="text-muted-foreground ml-1 text-xs">
                          ({profile.displayName})
                        </span>
                      </Show>
                    </span>
                    <Show when={isActive()}>
                      <span class="text-primary text-xs">&#10003;</span>
                    </Show>
                  </button>
                );
              }}
            </For>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
