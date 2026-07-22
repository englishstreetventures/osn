import {
  DEFAULT_PRESET,
  derivePalette,
  PALETTE_PRESET_KEYS,
  PALETTE_PRESETS,
  type PalettePresetKey,
  type PaletteSeeds,
  paletteAdjustments,
  resolveSeeds,
} from "@cire/theme";
import { createMemo, For, Show } from "solid-js";

import ColorPicker from "./ColorPicker";

/** The organiser's scheme: a preset they started from, plus any seeds they changed. */
export interface PaletteState {
  preset: PalettePresetKey | null;
  seeds: Partial<Record<keyof PaletteSeeds, string | null>>;
}

/**
 * The five seed roles, in the order they read on the page — page, then paper,
 * then what's written on it, then the two accents. Each is shown under its seed
 * name, so the builder, the wiki and the code all say "gilt" for the same
 * colour. The names carry no meaning on their own, so each keeps the plain
 * description of where it lands.
 */
const ROLES: { key: keyof PaletteSeeds; label: string; hint: string }[] = [
  { key: "ground", label: "Ground", hint: "The background behind everything." },
  { key: "card", label: "Card", hint: "Event cards, panels and pop-ups." },
  { key: "ink", label: "Ink", hint: "Headings and body text." },
  { key: "gilt", label: "Gilt", hint: "Buttons, links and fine rules." },
  { key: "bloom", label: "Bloom", hint: "Small flourishes and markers." },
];

/** Human names for the curated schemes. */
const PRESET_LABELS: Record<PalettePresetKey, string> = {
  evergreen: "Evergreen",
  jewel: "Jewel",
  fog: "Fog",
  chapel: "Chapel",
  garden: "Garden",
};

/**
 * The seeds a scheme currently resolves to — the organiser's picks over their
 * preset. Delegates to `@cire/theme` so the builder and the guest site cannot
 * disagree about what a half-filled scheme means.
 */
export function resolvedSeeds(state: PaletteState): PaletteSeeds {
  return resolveSeeds(state.seeds, state.preset);
}

/**
 * The colour scheme editor — five colours for the whole invite.
 *
 * This replaced eight per-section pickers (an accent and a background for each
 * of hero / story / welcome / events). Eight independent colours asked the
 * organiser to hand-build cohesion and still left most of the page — the
 * background, borders, text, the hero gradient — beyond their reach. Here they
 * pick a scheme, optionally nudge a colour or two, and `derivePalette` produces
 * the rest, contrast included.
 */
export default function PaletteField(props: {
  value: PaletteState;
  onChange: (next: PaletteState) => void;
}) {
  const base = () => PALETTE_PRESETS[props.value.preset ?? DEFAULT_PRESET];
  // Memoised for the same reason as the builder's previewTokens: the trigger is
  // a pointer-rate drag, and `tokens` + `adjusted` would each re-parse the same
  // five seeds independently on every frame.
  const seeds = createMemo(() => resolvedSeeds(props.value));
  const tokens = createMemo(() => derivePalette(seeds()));
  // Which of the organiser's colours had to move to stay legible. Empty is the
  // normal case, and its emptiness is the signal that nothing needs explaining.
  const adjusted = createMemo(() => paletteAdjustments(seeds()));

  /** Pick a preset: adopt its five colours wholesale, dropping earlier nudges. */
  const choosePreset = (key: PalettePresetKey) => props.onChange({ preset: key, seeds: {} });

  const setSeed = (key: keyof PaletteSeeds, value: string | null) =>
    props.onChange({ ...props.value, seeds: { ...props.value.seeds, [key]: value } });

  return (
    <div class="flex flex-col gap-5">
      <div class="flex flex-col gap-2">
        <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
          Scheme
        </span>
        <div class="flex flex-wrap gap-2" role="group" aria-label="Colour scheme">
          <For each={PALETTE_PRESET_KEYS}>
            {(key) => {
              const preset = PALETTE_PRESETS[key];
              const selected = () => (props.value.preset ?? DEFAULT_PRESET) === key;
              return (
                <button
                  type="button"
                  aria-pressed={selected()}
                  onClick={() => choosePreset(key)}
                  class="border-border hover:border-gold focus-visible:border-gold focus-visible:ring-gold/40 aria-pressed:border-gold flex items-center gap-2 rounded-sm border px-2.5 py-2 transition outline-none focus-visible:ring-2"
                >
                  {/* The five colours themselves are the label — a scheme is
                      easier to recognise than to read. */}
                  <span class="flex" aria-hidden="true">
                    <For each={[preset.ground, preset.card, preset.ink, preset.gilt, preset.bloom]}>
                      {(colour) => (
                        <span
                          class="border-border h-5 w-3 border-y first:rounded-l-[3px] first:border-l last:rounded-r-[3px] last:border-r"
                          style={{ "background-color": colour }}
                        />
                      )}
                    </For>
                  </span>
                  <span class="font-body text-text text-[0.78rem]">{PRESET_LABELS[key]}</span>
                </button>
              );
            }}
          </For>
        </div>
      </div>

      <div class="flex flex-col gap-2">
        <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
          Colours
        </span>
        <p class="font-body text-text-muted text-[0.82rem]">
          Five colours build the whole invite — every border, button and pop-up follows them. Change
          one and the rest adjust around it.
        </p>
        <div class="flex flex-wrap gap-5">
          <For each={ROLES}>
            {(role) => (
              <ColorPicker
                label={role.label}
                hint={role.hint}
                value={props.value.seeds[role.key] ?? null}
                fallback={base()[role.key]}
                onChange={(v) => setSeed(role.key, v)}
              />
            )}
          </For>
        </div>
      </div>

      {/* What the five seeds actually produce. Shows the derived surfaces and
          text side by side, which is the part an organiser cannot picture from
          five swatches alone. */}
      <div class="flex flex-col gap-2">
        <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
          Live preview
        </span>
        <figure
          aria-label="Colour scheme preview"
          class="border-border overflow-hidden rounded-sm border"
          style={{ ...tokens(), "background-color": "var(--color-bg)" }}
        >
          <div class="flex flex-col gap-3 p-4">
            <span
              class="text-[0.6rem] tracking-[0.18em] uppercase"
              style={{ color: "var(--color-gold)" }}
            >
              Celebrate with us
            </span>
            <span
              class="text-[1.5rem] leading-none font-light italic"
              style={{ color: "var(--color-text)", "font-family": "var(--font-display)" }}
            >
              Your Events
            </span>
            <div
              class="flex flex-col gap-2 rounded-sm border p-3"
              style={{
                "background-color": "var(--color-surface)",
                "border-color": "var(--color-border)",
              }}
            >
              <span class="text-[0.8rem]" style={{ color: "var(--color-text)" }}>
                Ceremony
              </span>
              <span class="text-[0.7rem]" style={{ color: "var(--color-text-muted)" }}>
                Saturday, 4pm · St Mary's
              </span>
              <div class="flex gap-2">
                <span
                  class="rounded-sm px-2 py-1 text-[0.65rem]"
                  style={{ "background-color": "var(--color-gold)", color: "var(--color-bg)" }}
                >
                  Respond
                </span>
                <span
                  class="rounded-sm border px-2 py-1 text-[0.65rem]"
                  style={{ "border-color": "var(--color-gold)", color: "var(--color-gold)" }}
                >
                  View event
                </span>
                <span
                  class="h-2 w-2 self-center rounded-full"
                  style={{ "background-color": "var(--color-bloom)" }}
                  aria-hidden="true"
                />
              </div>
            </div>
          </div>
        </figure>
      </div>

      {/* Contrast is enforced in the derivation, not merely warned about — so
          this reports what was changed rather than asking the organiser to fix
          it themselves. */}
      <Show when={adjusted().length > 0}>
        <p
          role="status"
          class="border-gold-dim bg-gold/5 text-text rounded-sm border px-3 py-2 text-[0.78rem] leading-relaxed"
        >
          Adjusted to stay readable:{" "}
          {adjusted()
            .map((a) => ROLES.find((r) => r.key === a.token)?.label.toLowerCase() ?? a.token)
            .join(", ")}
          . Your invite keeps the colours you picked; these were shifted just enough for the text to
          stay legible.
        </p>
      </Show>
    </div>
  );
}
