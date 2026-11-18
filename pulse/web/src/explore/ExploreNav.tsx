import { useAuth } from "@shared/rp-auth/solid";
import { Avatar, AvatarFallback, AvatarImage } from "@shared/ui/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@shared/ui/ui/dropdown-menu";
import { useLocation, useNavigate } from "@solidjs/router";
import { createMemo, For, Show } from "solid-js";

import { Icon } from "../components/Icon";
import { setShowCreateForm } from "../lib/createEventSignal";
import { TABS } from "../lib/tabs";
import { displayNameOf, initialOf, safeAvatarUrl } from "../lib/utils";
import { NavPill } from "./NavPill";

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
      class="border-border z-30 border-b md:sticky md:top-0"
      style={{
        background: "color-mix(in oklab, var(--background) 88%, transparent)",
        "backdrop-filter": "blur(16px) saturate(140%)",
      }}
    >
      {/* Top row: brand + tabs + search + actions on one line from md up. Below
          md it wraps to three: brand and actions, the search, the tabs — the
          tabs last, so the active tab's underline still lands on this row's
          bottom border. */}
      <div class="border-border flex flex-wrap items-center gap-x-2.5 gap-y-3 border-b px-4 py-3.5 md:flex-nowrap md:gap-x-6 md:px-8">
        {/* Brand */}
        <div
          class="flex shrink-0 items-center gap-2.5"
          style={{ "font-family": "var(--font-serif)" }}
        >
          <span
            class="grid h-6.5 w-6.5 place-items-center rounded-full"
            style={{
              background: "var(--pulse-accent)",
              "box-shadow": "0 0 0 4px color-mix(in oklab, var(--pulse-accent) 22%, transparent)",
            }}
            aria-hidden="true"
          >
            <span class="brand-pulse h-2 w-2 rounded-full" style={{ background: "var(--card)" }} />
          </span>
          <span class="text-ui-xl pb-0.5 tracking-tight">Pulse</span>
        </div>

        <nav class="flex gap-0.5 max-md:order-last max-md:basis-full">
          <For each={TABS}>
            {(tab) => (
              <Show when={tab.id === "home" || session()}>
                <button
                  type="button"
                  class={`text-ui-sm relative rounded-lg px-3.5 py-2 font-medium transition-[color,background-color] duration-(--ui-dur-fast) ease-(--ui-ease-out) ${
                    tab.disabled
                      ? "text-muted-foreground/40 cursor-default"
                      : isActiveTab(tab.path)
                        ? "explore-tab-active bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                  }`}
                  onClick={() => {
                    if (tab.path) navigate(tab.path);
                  }}
                  aria-current={!tab.disabled && isActiveTab(tab.path) ? "page" : undefined}
                  aria-disabled={tab.disabled ? true : undefined}
                  tabindex={tab.disabled ? -1 : undefined}
                >
                  {tab.label}
                </button>
              </Show>
            )}
          </For>
        </nav>

        {/* Right side: takes the row's spare width, so the search grows to its
            cap and shrinks first. Below md its two parts join the row's lines. */}
        <div class="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2.5 max-md:contents">
          {/* Search */}
          <div class="border-border bg-background focus-within:border-foreground/20 focus-within:outline-ui-focus flex max-w-90 min-w-0 flex-1 items-center gap-2 rounded-full border px-3.5 py-2 transition-[border-color] duration-(--ui-dur-fast) ease-(--ui-ease-out) focus-within:outline-2 focus-within:outline-offset-2 max-md:order-1 max-md:max-w-none max-md:basis-full">
            <Icon name="search" size={14} />
            <input
              type="text"
              name="q"
              autocomplete="off"
              aria-label="Search events, people, venues"
              value={props.query}
              onInput={(e) => props.onQueryChange(e.currentTarget.value)}
              placeholder="Search events, people, venues…"
              class="text-foreground placeholder:text-muted-foreground text-ui-sm min-w-0 flex-1 border-0 bg-transparent text-ellipsis outline-none"
            />
          </div>

          <div class="flex shrink-0 items-center gap-2.5 max-md:ml-auto">
            <Show
              when={session()}
              fallback={
                <NavPill tone="accent" onClick={() => signIn()}>
                  Continue with musubi
                </NavPill>
              }
            >
              {/* Notifications */}
              <NavPill tone="outline" title="Notifications" aria-label="Notifications">
                <Icon name="bell" size={14} />
              </NavPill>

              {/* Host CTA */}
              <NavPill tone="accent" onClick={() => setShowCreateForm((v) => !v)}>
                <Icon name="plus" size={14} />
                Host
              </NavPill>

              {/* Avatar dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger treatment="pill">
                  <Avatar class="h-8.5 w-8.5">
                    <Show when={avatar()}>
                      {(url) => <AvatarImage src={url()} alt={name() ?? "You"} />}
                    </Show>
                    <AvatarFallback>{initialOf(name())}</AvatarFallback>
                  </Avatar>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel tone="identity">{name() ?? "…"}</DropdownMenuLabel>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
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
      </div>

      {/* Hero row: stats beside the headline from md up, under it below */}
      <div class="grid items-end gap-5 px-4 pt-8 pb-6 md:grid-cols-[minmax(0,1fr)_auto] md:gap-10 md:px-8">
        <div>
          <div
            class="text-muted-foreground mb-2.5 inline-flex flex-wrap items-center gap-1.75 text-xs tracking-wider"
            style={{ "font-family": "var(--font-mono)" }}
          >
            <span
              class="live-dot inline-block h-1.75 w-1.75 rounded-full"
              aria-hidden="true"
              style={{
                background: "var(--badge-live)",
                "box-shadow": "0 0 0 3px color-mix(in oklab, var(--badge-live) 30%, transparent)",
              }}
            />
            <Show when={greetingName()} fallback={<>{greeting}</>}>
              {greeting}, {greetingName()}
            </Show>
            {/* The separator travels with the date, so a wrap moves both */}
            <span class="inline-flex items-center gap-1.75">
              <span aria-hidden="true">·</span>
              <b class="text-foreground font-semibold">
                {new Date().toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "short",
                  day: "numeric",
                })}
              </b>
            </span>
          </div>
          <h1
            class="max-w-hero m-0 font-normal"
            style={{
              "font-family": "var(--font-serif)",
              "font-size": "clamp(32px, 4.4vw, 56px)",
              "line-height": "1.02",
              "letter-spacing": "-0.025em",
              "text-wrap": "pretty",
            }}
          >
            <span class="mr-accent-word">Here's what's</span>{" "}
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
                class="text-ui-2xl leading-none"
                style={{ "font-family": "var(--font-serif)", "letter-spacing": "-0.02em" }}
              >
                {props.eventCount}
              </div>
              <div
                class="text-muted-foreground text-ui-xs mt-1 tracking-wider uppercase"
                style={{ "font-family": "var(--font-mono)" }}
              >
                events nearby
              </div>
            </div>
          </Show>
          <Show when={typeof props.liveCount === "number" && props.liveCount! > 0}>
            <div class="text-left">
              <div
                class="text-ui-2xl leading-none"
                style={{ "font-family": "var(--font-serif)", "letter-spacing": "-0.02em" }}
              >
                {props.liveCount}
              </div>
              <div
                class="text-muted-foreground text-ui-xs mt-1 tracking-wider uppercase"
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
