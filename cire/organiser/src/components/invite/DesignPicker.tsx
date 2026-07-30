/**
 * The design catalog radiogroup: one card per design pack with an abstract
 * thumbnail, roving tabindex, and instant save on selection (one PUT per
 * click — design choice is deliberately outside the save bar).
 *
 * Locked (premium, unentitled) cards use `aria-disabled` — NOT `disabled` — so
 * they stay perceivable: keyboard arrows can land on them (announcing the
 * "Locked" state), Tab order and selection skip them, and activation no-ops.
 * A `disabled` button would erase premium designs from the accessibility tree
 * for keyboard users entirely — a screen-reader user could never discover
 * they exist. The server enforces the entitlement regardless.
 */

import { DESIGNS } from "@cire/invite-designs";
import { createSignal, For, Show } from "solid-js";

import { isDesignLocked } from "./model";

export default function DesignPicker(props: {
  entitlements: string[];
  /** The server-acknowledged current design id. */
  currentId: string;
  saving: boolean;
  onSelect: (designId: string) => void;
  /** The guest invite URL previewing a design (`?design=<id>`). */
  previewHref: (designId: string) => string;
}) {
  // Roving tabindex over the design radiogroup. `activeDesignId` tracks which
  // card is currently tabbable — it starts in sync with the server-selected
  // design and moves independently of the in-flight save, so keyboard focus
  // never stalls waiting on the network. Falls back to the server value
  // whenever nothing has moved focus yet.
  const [activeDesignId, setActiveDesignId] = createSignal<string | null>(null);
  const activeDesignIdOrDefault = () => activeDesignId() ?? props.currentId;

  // Imperative refs so keyboard navigation can move DOM focus onto the next
  // card — Solid has no built-in roving-tabindex primitive.
  const radioRefs = new Map<string, HTMLButtonElement>();

  const locked = (id: string): boolean => {
    const design = DESIGNS.find((d) => d.id === id);
    return design ? isDesignLocked(design.tier, props.entitlements) : false;
  };

  /** The design one step (±1) from `fromId`, wrapping around. Locked cards ARE
   *  stops — focus lands on them so their locked state is perceivable — but
   *  only unlocked stops select. */
  function stepDesign(fromId: string, delta: 1 | -1): string | undefined {
    const ids = DESIGNS.map((d): string => d.id);
    if (ids.length === 0) return undefined;
    const from = ids.indexOf(fromId);
    const fromIndex = from === -1 ? 0 : from;
    return ids[(fromIndex + delta + ids.length) % ids.length];
  }

  /** Move focus to a card and — when it's selectable — select it. */
  function focusDesign(id: string) {
    setActiveDesignId(id);
    radioRefs.get(id)?.focus();
    if (!locked(id)) props.onSelect(id);
  }

  /** Roving-tabindex keyboard handler: arrows/Home/End move focus; selection
   *  follows focus except onto locked cards (radio semantics, aria-disabled). */
  function onDesignKeyDown(e: KeyboardEvent, currentId: string) {
    const ids = DESIGNS.map((d): string => d.id);
    if (ids.length === 0) return;
    let nextId: string | undefined;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextId = stepDesign(currentId, 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextId = stepDesign(currentId, -1);
        break;
      case "Home":
        nextId = ids[0];
        break;
      case "End":
        nextId = ids[ids.length - 1];
        break;
      default:
        return;
    }
    if (!nextId) return;
    e.preventDefault();
    focusDesign(nextId);
  }

  return (
    <>
      <div class="flex flex-wrap gap-3" role="radiogroup" aria-label="Invite design">
        <For each={[...DESIGNS]}>
          {(design) => {
            const isLocked = () => isDesignLocked(design.tier, props.entitlements);
            const checked = () => props.currentId === design.id;
            return (
              <div
                class="border-border flex flex-col items-start gap-2 rounded-sm border px-4 py-3"
                classList={{ "border-gold": checked() }}
              >
                <button
                  type="button"
                  role="radio"
                  ref={(el) => radioRefs.set(design.id, el)}
                  aria-checked={checked()}
                  aria-disabled={isLocked() || props.saving ? "true" : undefined}
                  tabIndex={activeDesignIdOrDefault() === design.id ? 0 : -1}
                  onClick={() => {
                    if (isLocked()) return;
                    setActiveDesignId(design.id);
                    props.onSelect(design.id);
                  }}
                  onKeyDown={(e) => onDesignKeyDown(e, design.id)}
                  class="flex min-w-[8rem] flex-col items-start gap-1 text-left aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                >
                  <DesignThumbnail id={design.id} />
                  <span class="font-body text-[0.85rem]">{design.name}</span>
                  <Show when={isLocked()}>
                    <span class="text-gold-dim text-[0.7rem] tracking-[0.08em] uppercase">
                      Locked
                    </span>
                  </Show>
                  <Show when={checked()}>
                    <span class="text-gold text-[0.7rem] tracking-[0.08em] uppercase">Current</span>
                  </Show>
                </button>
                <Show when={!isLocked()}>
                  <a
                    href={props.previewHref(design.id)}
                    target="_blank"
                    rel="noopener"
                    class="font-body text-gold-dim text-[0.7rem] tracking-[0.08em] uppercase underline-offset-4 hover:underline"
                  >
                    Preview live
                  </a>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
      <p class="text-gold-dim text-[0.78rem]">
        Saved instantly — open your invite link to preview it live.
      </p>
    </>
  );
}

/**
 * Abstract per-design thumbnail — a small sketch of the pack's structure, not
 * a screenshot. Purely decorative (`aria-hidden`), so it never competes with
 * the card's own accessible name. `currentColor` only (no raw colours): it
 * inherits the card's `text-text-muted` token, same as the rest of the
 * builder's muted chrome.
 */
function ClassicThumbnail() {
  return (
    <svg viewBox="0 0 120 84" width="120" height="84" aria-hidden="true" class="text-text-muted">
      <line x1="30" y1="14" x2="90" y2="14" stroke="currentColor" stroke-width="2" />
      <line x1="36" y1="22" x2="84" y2="22" stroke="currentColor" stroke-width="2" />
      <line x1="42" y1="30" x2="78" y2="30" stroke="currentColor" stroke-width="2" />
      <rect
        x="35"
        y="40"
        width="50"
        height="34"
        fill="currentColor"
        fill-opacity="0.15"
        stroke="currentColor"
        stroke-width="2"
      />
    </svg>
  );
}

/** Gala's thumbnail: left-anchored lines + an offset image block — the
 *  asymmetric layout that distinguishes it from Classic's centered stack. */
function GalaThumbnail() {
  return (
    <svg viewBox="0 0 120 84" width="120" height="84" aria-hidden="true" class="text-text-muted">
      <line x1="10" y1="14" x2="70" y2="14" stroke="currentColor" stroke-width="2" />
      <line x1="10" y1="22" x2="60" y2="22" stroke="currentColor" stroke-width="2" />
      <line x1="10" y1="30" x2="50" y2="30" stroke="currentColor" stroke-width="2" />
      <rect
        x="55"
        y="38"
        width="55"
        height="36"
        fill="currentColor"
        fill-opacity="0.15"
        stroke="currentColor"
        stroke-width="2"
      />
    </svg>
  );
}

/** Dispatches to the design's thumbnail by id; unrecognised ids (a newer
 *  catalog entry, or a test-only fixture) fall back to the centered-stack
 *  sketch rather than rendering nothing. */
function DesignThumbnail(props: { id: string }) {
  return props.id === "gala" ? <GalaThumbnail /> : <ClassicThumbnail />;
}
