import { oklchToRgb, parseColor as parseAnyColor } from "@cire/theme";
import { ColorArea } from "@kobalte/core/color-area";
import { ColorSlider } from "@kobalte/core/color-slider";
import { ColorSwatch } from "@kobalte/core/color-swatch";
import { type Color, parseColor } from "@kobalte/core/colors";
import { Popover } from "@kobalte/core/popover";
import { createEffect, createSignal, createUniqueId, Show } from "solid-js";

/**
 * The colour a picker shows when nothing is set and the caller names no
 * fallback. Callers that know the real default — the scheme editor, which knows
 * each seed's value in the chosen preset — should pass `fallback`, so the
 * swatch shows the colour the invite ACTUALLY renders rather than a stand-in.
 */
const DEFAULT_HEX = "#d4af37";

/**
 * A COMPLETE typed hex colour — exactly 6 digits, with or without the "#".
 * `parseColor` also accepts 3/4-digit shorthand, but committing those hijacks
 * the field mid-typing: en route to "#d4af37" the partial "#d4a" already
 * parses, expands to "#DD44AA", and yanks the swatch, preview and trigger to a
 * colour nobody chose. Nothing shorter than six digits is ever a decision here.
 */
const COMPLETE_HEX = /^#?[0-9a-fA-F]{6}$/;

/**
 * What the hex field will hold while it is being typed: a hash and up to six
 * hex digits, or empty. Anything else — a stray letter, a seventh digit, a
 * pasted `rgb(...)` — is refused at the keystroke and the field is put back.
 */
const PARTIAL_HEX = /^#?[0-9a-fA-F]{0,6}$/;

/** A colour as `#rrggbb`, via the shared parser (the only one that reads oklch). */
function toHexString(value: string): string | null {
  const parsed = parseAnyColor(value);
  if (!parsed) return null;
  const { r, g, b } = oklchToRgb(parsed);
  const byte = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/**
 * Parse an incoming CSS colour string into a Kobalte `Color`, tolerating the
 * non-hex formats the API allow-list accepts and partial / invalid input.
 * Returns `null` when it can't be parsed so callers fall back to the default
 * instead of throwing (Kobalte's `parseColor` throws on anything it can't read).
 *
 * Kobalte does NOT understand `oklch()`, which is the format every derived
 * token and every curated preset seed uses — handing it one straight through
 * made each picker silently show the stand-in gold instead of the colour the
 * invite actually renders. So convert through the shared parser FIRST and give
 * Kobalte plain hex.
 */
function tryParse(value: string): Color | null {
  const hex = toHexString(value);
  try {
    return parseColor(hex ?? value);
  } catch {
    return null;
  }
}

/** A Kobalte `Color` as a `#rrggbb` hex string (the format we persist + emit). */
function toHex(color: Color): string {
  return color.toString("hex");
}

/**
 * Resolve the colour to display: the parsed incoming value, else the caller's
 * fallback (the colour the invite actually renders when this field is unset),
 * else the stand-in gold.
 */
function resolveColor(value: string | null, fallback?: string): Color {
  const parsed = value ? tryParse(value) : null;
  if (parsed) return parsed;
  const fromFallback = fallback ? tryParse(fallback) : null;
  return fromFallback ?? parseColor(DEFAULT_HEX);
}

/**
 * An accessible popover colour picker that round-trips to a nullable hex value.
 *
 * `null` ⇒ the built-in default (the trigger reads "Default" and a "Use default"
 * action clears it). The contract is identical to the old native `<input
 * type="color">`: `onChange` emits a `#rrggbb` string (or `null`), so the live
 * `ThemePreview` and the server-side colour allow-list keep working unchanged.
 *
 * Inside the popover: a 2D saturation/brightness `ColorArea` + a `hue`
 * `ColorSlider` for visual picking, and a clearly-labelled "Hex" field
 * front-and-centre so typing/pasting a hex code is obvious. All three share one
 * HSB `Color` signal, so visual picking and the hex field stay in sync. We only
 * emit upstream once we hold a full, valid colour — partial hex never escapes.
 *
 * The hex field is a plain `<input>`, deliberately NOT Kobalte's `ColorField`.
 * `ColorField` runs its own blur handler — composed with `composeEventHandlers`,
 * which calls every handler unconditionally, so it cannot be pre-empted or
 * prevented — that parses whatever is in the field and writes the expansion
 * back. Three digits into "#d4af37" that turns the organiser's half-typed entry
 * into "#DD44AA" and commits it the moment focus leaves the field (clicking the
 * area, the next picker, or anywhere outside the popover), which reads exactly
 * as the picker completing a colour by itself. Owning the input means owning
 * that rule: see `onHexBlur`.
 */
export default function ColorPicker(props: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  /**
   * What this field resolves to when it is null — shown in the swatch so
   * "Default" is a colour the organiser can see, not a guess. The scheme editor
   * passes the seed's value in the chosen preset.
   */
  fallback?: string;
  /** Optional one-line description of the role, under the label. */
  hint?: string;
}) {
  // The live working colour in HSB space (x = saturation, y = brightness for the
  // ColorArea; the hue slider drives the H channel). Seeded from the resolved
  // incoming value and kept in sync with external changes via the effect below.
  const [color, setColor] = createSignal<Color>(
    resolveColor(props.value, props.fallback).toFormat("hsb"),
  );

  // The hex field is a controlled string so a partial value ("#d4") survives a
  // keystroke without being clobbered; it re-derives from `color` on visual picks.
  const [hexText, setHexText] = createSignal(toHex(color()));
  // Ties the "Hex" label to its input — the job `ColorField` used to do.
  const hexId = createUniqueId();
  const hexNoteId = createUniqueId();
  // The colour kept when an incomplete entry was discarded on blur, else null.
  const [discarded, setDiscarded] = createSignal<string | null>(null);

  // Re-seed when the parent value changes externally (theme load, "Use default",
  // a sibling reset). Compare hex so an internal commit that already matches
  // doesn't thrash the working colour while the popover is open.
  createEffect(() => {
    const incoming = toHex(resolveColor(props.value, props.fallback));
    if (incoming !== toHex(color())) {
      setColor(resolveColor(props.value, props.fallback).toFormat("hsb"));
      setHexText(incoming);
    }
  });

  /** Commit a visual pick (area / hue slider): sync hex text + emit hex upstream. */
  const commitColor = (next: Color) => {
    const hsb = next.toFormat("hsb");
    setColor(hsb);
    setHexText(toHex(hsb));
    props.onChange(toHex(hsb));
  };

  /** Handle raw hex-field input. Emit only once the full 6-digit hex is typed. */
  const onHexInput = (el: HTMLInputElement) => {
    const raw = el.value;
    // Refuse a keystroke that can't be part of a hex code. The input is
    // controlled by `hexText`, and an unchanged signal re-renders nothing, so
    // the DOM would otherwise keep the character we just rejected — push the
    // accepted text back by hand.
    if (!PARTIAL_HEX.test(raw)) {
      el.value = hexText();
      return;
    }
    setHexText(raw);
    // Typing again clears a previous discard notice — it describes an edit the
    // organiser has now moved on from.
    setDiscarded(null);
    if (!COMPLETE_HEX.test(raw)) return;
    const parsed = tryParse(raw.startsWith("#") ? raw : `#${raw}`);
    if (parsed) {
      setColor(parsed.toFormat("hsb"));
      props.onChange(toHex(parsed));
    }
  };

  /**
   * Leaving the field never invents a colour. A complete entry has already been
   * committed on its last keystroke, so this only re-prints it in the canonical
   * `#RRGGBB` casing; an incomplete one ("#d4a", "#", "") is an abandoned edit
   * and the field goes back to the colour the invite is actually painted with.
   *
   * The cost is that 3-digit shorthand no longer expands — typing "#fff" and
   * tabbing away restores the previous colour instead of committing white. That
   * is the deliberate trade: shorthand is a convenience, whereas every full hex
   * passes through its own three-digit prefix on the way in, so expanding on
   * blur silently rewrites the far more common case.
   *
   * A discard SAYS SO (C-L3). Snapping the field back is visible to anyone
   * watching it and invisible to everyone else, so a discarded entry also sets
   * `aria-invalid` and posts a line naming what was kept — otherwise a screen
   * reader user leaves the field believing the colour they typed was applied.
   */
  const onHexBlur = () => {
    const kept = toHex(color());
    setDiscarded(COMPLETE_HEX.test(hexText()) ? null : kept);
    setHexText(kept);
  };

  // The swatch/trigger always reflect the persisted value (default gold if null).
  const display = () => resolveColor(props.value, props.fallback);

  return (
    <div class="flex flex-col items-start gap-1.5">
      <span class="font-body text-text-muted text-[0.68rem] tracking-[0.08em] uppercase">
        {props.label}
      </span>
      <Show when={props.hint}>
        <span class="font-body text-text-muted -mt-1 text-[0.68rem] italic">{props.hint}</span>
      </Show>
      <div class="flex items-center gap-2">
        <Popover gutter={8} placement="bottom-start">
          <Popover.Trigger
            aria-label={`${props.label} colour`}
            class="border-border bg-bg hover:border-gold focus-visible:border-gold focus-visible:ring-gold/40 flex items-center gap-2 rounded-sm border px-2 py-1.5 transition outline-none focus-visible:ring-2"
          >
            <ColorSwatch
              value={display()}
              class="border-border h-5 w-5 shrink-0 rounded-[3px] border"
            />
            <Show
              when={props.value}
              fallback={
                <span class="font-body text-text-muted text-[0.78rem] italic">Default</span>
              }
            >
              <span class="font-body text-text text-[0.78rem] tracking-[0.04em] uppercase tabular-nums">
                {toHex(display())}
              </span>
            </Show>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content class="border-border bg-surface-raised z-50 flex w-56 flex-col gap-3 rounded-sm border p-3 shadow-lg outline-none">
              <ColorArea
                colorSpace="hsb"
                xChannel="saturation"
                yChannel="brightness"
                value={color()}
                onChange={commitColor}
                class="relative"
              >
                <ColorArea.Background class="relative h-32 w-full rounded-sm">
                  <ColorArea.Thumb class="h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)] outline-none">
                    <ColorArea.HiddenInputX aria-label={`${props.label} saturation`} />
                    <ColorArea.HiddenInputY aria-label={`${props.label} brightness`} />
                  </ColorArea.Thumb>
                </ColorArea.Background>
              </ColorArea>

              <ColorSlider
                channel="hue"
                colorSpace="hsb"
                value={color()}
                onChange={commitColor}
                class="flex flex-col"
              >
                <ColorSlider.Track class="relative h-3 w-full rounded-full">
                  <ColorSlider.Thumb class="top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)] outline-none">
                    <ColorSlider.Input aria-label={`${props.label} hue`} />
                  </ColorSlider.Thumb>
                </ColorSlider.Track>
              </ColorSlider>

              <div class="flex flex-col gap-1">
                <label
                  for={hexId}
                  class="font-body text-text-muted text-[0.66rem] tracking-[0.1em] uppercase"
                >
                  Hex
                </label>
                <input
                  id={hexId}
                  type="text"
                  value={hexText()}
                  onInput={(e) => onHexInput(e.currentTarget)}
                  onBlur={onHexBlur}
                  aria-invalid={discarded() ? true : undefined}
                  aria-describedby={discarded() ? hexNoteId : undefined}
                  autocomplete="off"
                  autocorrect="off"
                  spellcheck={false}
                  placeholder="#RRGGBB"
                  class="border-border bg-bg font-body text-text focus:border-gold rounded-sm border px-2.5 py-1.5 text-[0.82rem] tabular-nums outline-none"
                />
                <Show when={discarded()}>
                  {(kept) => (
                    <span
                      id={hexNoteId}
                      role="status"
                      class="font-body text-text-muted text-[0.7rem]"
                    >
                      Needs 6 digits — kept {kept()}
                    </span>
                  )}
                </Show>
              </div>

              <Show when={props.value}>
                <button
                  type="button"
                  onClick={() => props.onChange(null)}
                  class="font-body text-text-muted hover:text-text self-start text-[0.72rem] underline-offset-4 hover:underline"
                >
                  Use default
                </button>
              </Show>
            </Popover.Content>
          </Popover.Portal>
        </Popover>

        <Show when={props.value}>
          <button
            type="button"
            onClick={() => props.onChange(null)}
            class="font-body text-text-muted text-[0.72rem] underline-offset-4 hover:underline"
          >
            Use default
          </button>
        </Show>
      </div>
    </div>
  );
}
