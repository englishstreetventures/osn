import { Avatar, AvatarFallback, AvatarImage } from "@osn/ui/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@osn/ui/ui/dropdown-menu";
import { useAuth } from "@shared/rp-auth/solid";
import { useLocation, useNavigate } from "@solidjs/router";
import { createMemo, For, Show } from "solid-js";

import { Icon } from "../components/Icon";
import { setShowCreateForm } from "../lib/createEventSignal";
import { TABS } from "../lib/tabs";
import { displayNameOf, initialOf, safeAvatarUrl } from "../lib/utils";

export function ExploreNav(props: {
  query: string;
  onQueryChange: (q: string) => void;
  eventCount?: number;
  liveCount?: number;
}) {
  // Sign-in is a redirect to `musubi.social` and back through Pulse's own
  // API — there is no ceremony to host here, so no dialog either.
  const { session, signIn, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isActiveTab = (path: string | undefined) => path != null && location.pathname === path;

  const name = createMemo(() => displayNameOf(session() ?? null));
  const avatar = createMemo(() => safeAvatarUrl(session()?.avatarUrl));

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
  /** First name only — the greeting reads as a greeting, not a record. */
  const greetingName = () => name()?.split(" ")[0] ?? "";

  return (
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
            <span class="brand-pulse h-2 w-2 rounded-full" style={{ background: "var(--card)" }} />
          </span>
          <span class="pb-0.5 text-[26px] tracking-tight">Pulse</span>
        </div>

        <nav class="flex gap-0.5">
          <For each={TABS}>
            {(tab) => (
              <Show when={tab.id === "home" || session()}>
                <button
                  type="button"
                  class={`relative rounded-lg px-3.5 py-2 text-[13.5px] font-medium transition-colors ${
                    tab.disabled
                      ? "text-muted-foreground/40 cursor-default"
                      : isActiveTab(tab.path)
                        ? "explore-tab-active bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                  }`}
                  onClick={() => {
                    if (tab.path) navigate(tab.path);
                  }}
                  aria-disabled={tab.disabled ? true : undefined}
                  tabindex={tab.disabled ? -1 : undefined}
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
                onClick={() => signIn()}
              >
                Continue with musubi
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
                  <Show when={avatar()}>
                    {(url) => <AvatarImage src={url()} alt={name() ?? "You"} />}
                  </Show>
                  <AvatarFallback class="text-xs">{initialOf(name())}</AvatarFallback>
                </Avatar>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuGroup>
                  <DropdownMenuLabel class="text-muted-foreground font-normal">
                    {name() ?? "…"}
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => navigate("/settings")}>Settings</DropdownMenuItem>
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
            <Show when={greetingName()} fallback={<>{greeting}</>}>
              {greeting}, {greetingName()}
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
  );
}
