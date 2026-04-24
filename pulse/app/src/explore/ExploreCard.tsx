import { Avatar, AvatarFallback, AvatarImage } from "@osn/ui/ui/avatar";
import { A } from "@solidjs/router";
import { Show } from "solid-js";

import type { EventItem } from "../lib/types";
import { Icon } from "./icons";

/** Gradient class for events without an image — keyed by category. */
const CATEGORY_PH: Record<string, string> = {
  music: "ph-1",
  art: "ph-2",
  outdoor: "ph-7",
  food: "ph-5",
  talks: "ph-8",
  sports: "ph-3",
  late: "ph-6",
};

const CATEGORY_GLYPH: Record<string, string> = {
  music: "\u263C",
  art: "\u25A3",
  outdoor: "\u25B3",
  food: "\u2318",
  talks: "\u275D",
  sports: "\u25C7",
  late: "\u263E",
};

function initials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function fmtDate(d: Date) {
  return {
    mo: d.toLocaleString("en-US", { month: "short" }).toUpperCase(),
    day: d.getDate(),
    dow: d.toLocaleString("en-US", { weekday: "short" }).toUpperCase(),
  };
}

function fmtTime(d: Date) {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function fmtDay(d: Date) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff > 0 && diff < 7) return d.toLocaleString("en-US", { weekday: "long" });
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function ExploreCard(props: {
  event: EventItem;
  featured?: boolean;
  hovered?: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const e = () => props.event;
  const date = () => new Date(e().startTime);
  const dateParts = () => fmtDate(date());
  const time = () => fmtTime(date());
  const dayLabel = () => fmtDay(date());
  const ph = () => CATEGORY_PH[e().category ?? ""] ?? "ph-4";
  const glyph = () => CATEGORY_GLYPH[e().category ?? ""] ?? "\u25C9";

  return (
    <A
      href={`/events/${e().id}`}
      class="group border-border bg-card hover:border-foreground/20 relative grid cursor-pointer overflow-hidden rounded-2xl border transition-all hover:-translate-y-px hover:shadow-md"
      classList={{
        "grid-cols-[180px_1fr]": !props.featured,
        "grid-cols-1": !!props.featured,
      }}
      style={
        props.hovered
          ? { "border-color": "var(--foreground)", "box-shadow": "var(--shadow-md)" }
          : undefined
      }
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
    >
      {/* Media */}
      <div
        class={`relative overflow-hidden ${ph()}`}
        classList={{
          "h-full min-h-[140px]": !props.featured,
          "h-[220px] w-full": !!props.featured,
        }}
      >
        <Show
          when={e().imageUrl}
          fallback={
            <>
              <div class="ph-pattern" />
              <div
                class="absolute right-2.5 bottom-2 text-[42px] leading-none italic"
                style={{
                  "font-family": "var(--font-serif)",
                  color: "oklch(1 0 0 / 0.85)",
                  "letter-spacing": "-0.03em",
                }}
              >
                {glyph()}
              </div>
            </>
          }
        >
          <img
            src={e().imageUrl!}
            alt={e().title}
            class="absolute inset-0 h-full w-full object-cover"
          />
        </Show>

        {/* Date stamp */}
        <div class="date-stamp bg-card absolute top-3 left-3 w-[46px] rounded-[10px] border border-white/50 py-1 text-center shadow-sm">
          <div
            class="text-[9px] font-semibold tracking-widest uppercase"
            style={{ color: "var(--pulse-accent-strong)" }}
          >
            {dateParts().mo}
          </div>
          <div class="mt-0.5 text-lg leading-none font-semibold">{dateParts().day}</div>
          <div class="text-muted-foreground mt-0.5 text-[9px] tracking-wider uppercase">
            {dateParts().dow}
          </div>
        </div>

        {/* Status tags */}
        <Show when={e().status === "ongoing"}>
          <div
            class="absolute bottom-2.5 left-2.5 inline-flex items-center gap-[5px] rounded-full px-2 py-[3px] text-[10px] font-medium text-white"
            style={{ background: "oklch(0.15 0 0 / 0.7)", "backdrop-filter": "blur(8px)" }}
          >
            <span
              class="live-dot inline-block h-[5px] w-[5px] rounded-full"
              style={{
                background: "var(--badge-live)",
                "box-shadow": "0 0 0 3px oklch(0.72 0.17 22 / 0.4)",
              }}
            />
            Happening now
          </div>
        </Show>
      </div>

      {/* Body */}
      <div class="relative flex min-w-0 flex-col gap-1.5 px-4 py-3.5">
        {/* Meta line */}
        <div
          class="flex items-center gap-1.5 text-[11.5px] tracking-wider uppercase"
          style={{ "font-family": "var(--font-mono)", color: "var(--pulse-accent-strong)" }}
        >
          <Icon name="clock" size={11} />
          {dayLabel()} · {time()}
        </div>

        {/* Title */}
        <h3 class="m-0 line-clamp-2 text-[16.5px] leading-tight font-semibold tracking-tight">
          {e().title}
        </h3>

        {/* Location */}
        <div class="text-muted-foreground flex items-center gap-2 text-[12.5px]">
          <Icon name="map-pin" size={12} />
          <Show when={e().venue}>
            <span>{e().venue}</span>
          </Show>
          <Show when={e().venue && e().location}>
            <span class="bg-foreground/20 inline-block h-[3px] w-[3px] rounded-full" />
          </Show>
          <Show when={e().location}>
            <span>{e().location}</span>
          </Show>
        </div>

        {/* Host */}
        <Show when={e().createdByName}>
          {(name) => (
            <div class="text-muted-foreground flex items-center gap-1.5 text-[11.5px]">
              <Avatar class="h-[18px] w-[18px]">
                <Show when={e().createdByAvatar}>
                  {(avatar) => <AvatarImage src={avatar()} alt={name()} />}
                </Show>
                <AvatarFallback class="text-[8px]">{initials(name())}</AvatarFallback>
              </Avatar>
              Hosted by <b class="text-foreground font-semibold">{name()}</b>
            </div>
          )}
        </Show>

        {/* Footer */}
        <div class="border-border mt-1.5 flex items-center justify-between gap-2.5 border-t border-dashed pt-2.5">
          <Show when={e().category}>
            <span class="text-muted-foreground text-[12px] font-medium tracking-wider uppercase">
              {e().category}
            </span>
          </Show>
          <span
            class="text-muted-foreground text-[11.5px]"
            style={{ "font-family": "var(--font-mono)" }}
          >
            {e().status === "ongoing"
              ? "Live"
              : e().status === "maybe_finished"
                ? "Maybe finished"
                : e().status}
          </span>
        </div>
      </div>
    </A>
  );
}
