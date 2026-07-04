import { ColorArea } from "@kobalte/core/color-area";
import { ColorField } from "@kobalte/core/color-field";
import { ColorSlider } from "@kobalte/core/color-slider";
import { ColorSwatch } from "@kobalte/core/color-swatch";
import { type Color, parseColor } from "@kobalte/core/colors";
import { Popover } from "@kobalte/core/popover";
import { createEffect, createSignal, Show } from "solid-js";

/**
 * The colour a picker falls back to when the section is on its default (the
 * organiser hasn't picked one). Matches the gold the rest of the builder seeds
 * — see InviteBuilder's preview gold + the old native input default.
 */
const DEFAULT_HEX = "#d4af37";

/**
 * A COMPLETE typed hex colour — exactly 6 digits, with or without the "#".
 * `parseColor` also accepts 3/4-digit shorthand, but committing those on a
 * keystroke hijacks the field mid-typing: en route to "#d4af37" the partial
 * "#d4a" already parses, expands to "#DD44AA", and yanks the swatch, preview
 * and trigger to the wrong colour. Shorthand still works — on blur Kobalte's
 * ColorField normalises it to the full 6-digit hex, which re-enters
 * `onHexInput` and commits then.
 */
const COMPLETE_HEX = /^#?[0-9a-fA-F]{6}$/;

/**
 * Parse an incoming CSS colour string into a Kobalte `Color`, tolerating the
 * non-hex formats the API allow-list accepts (rgb / hsl / oklch) and partial /
 * invalid input. Returns `null` when it can't be parsed so callers fall back to
 * the default instead of throwing — `parseColor` throws on anything it can't read.
 */
function tryParse(value: string): Color | null {
  try {
    return parseColor(value);
  } catch {
    return null;
  }
}

/** A Kobalte `Color` as a `#rrggbb` hex string (the format we persist + emit). */
function toHex(color: Color): string {
  return color.toString("hex");
}

/**
 * Resolve the colour to display: the parsed incoming value, or the default gold
 * when the section is on its default (null) or holds something unparseable.
 */
function resolveColor(value: string | null): Color {
  const parsed = value ? tryParse(value) : null;
  return parsed ?? parseColor(DEFAULT_HEX);
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
 * `ColorSlider` for visual picking, and a clearly-labelled "Hex" `ColorField`
 * front-and-centre so typing/pasting a hex code is obvious. All three share one
 * HSB `Color` signal, so visual picking and the hex field stay in sync. We only
 * emit upstream once we hold a full, valid colour — partial hex never escapes.
 */
export default function ColorPicker(props: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  // The live working colour in HSB space (x = saturation, y = brightness for the
  // ColorArea; the hue slider drives the H channel). Seeded from the resolved
  // incoming value and kept in sync with external changes via the effect below.
  const [color, setColor] = createSignal<Color>(resolveColor(props.value).toFormat("hsb"));

  // The hex field is a controlled string so a partial value ("#d4") survives a
  // keystroke without being clobbered; it re-derives from `color` on visual picks.
  const [hexText, setHexText] = createSignal(toHex(color()));

  // Re-seed when the parent value changes externally (theme load, "Use default",
  // a sibling reset). Compare hex so an internal commit that already matches
  // doesn't thrash the working colour while the popover is open.
  createEffect(() => {
    const incoming = toHex(resolveColor(props.value));
    if (incoming !== toHex(color())) {
      setColor(resolveColor(props.value).toFormat("hsb"));
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
  const onHexInput = (raw: string) => {
    setHexText(raw);
    if (!COMPLETE_HEX.test(raw)) return;
    const parsed = tryParse(raw.startsWith("#") ? raw : `#${raw}`);
    if (parsed) {
      setColor(parsed.toFormat("hsb"));
      props.onChange(toHex(parsed));
    }
  };

  // The swatch/trigger always reflect the persisted value (default gold if null).
  const display = () => resolveColor(props.value);

  return (
    <div class="flex flex-col items-start gap-1.5">
      <span class="font-body text-text-muted text-[0.68rem] tracking-[0.08em] uppercase">
        {props.label}
      </span>
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

              <ColorField value={hexText()} onChange={onHexInput} class="flex flex-col gap-1">
                <ColorField.Label class="font-body text-text-muted text-[0.66rem] tracking-[0.1em] uppercase">
                  Hex
                </ColorField.Label>
                <ColorField.Input
                  spellcheck={false}
                  placeholder="#RRGGBB"
                  class="border-border bg-bg font-body text-text focus:border-gold rounded-sm border px-2.5 py-1.5 text-[0.82rem] tabular-nums outline-none"
                />
              </ColorField>

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
