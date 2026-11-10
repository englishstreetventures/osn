// Repo-authored, not upstream. Upstream's `src/types.ts` also declares the
// React component's props and imports from `react` and `./gravity`, none of
// which this tree carries. `engine/index.ts` and `presets.ts` import only the
// two aliases below from it, so this file holds those two, copied verbatim
// from upstream's `src/types.ts` at the commit `README.md` pins. It changes
// only when upstream's declarations change, which is a re-vendor that moves
// the pin.

/**
 * The nine shipped states — each a hand-tuned animation:
 * - `working`    — particles on tilted orbits
 * - `searching`  — a scan meridian sweeps a dotted globe
 * - `solving`    — bands scramble in quarter turns, then click back
 * - `listening`  — a waveform rolls through latitude rings
 * - `connecting` — a constellation wires itself, packets running the edges
 * - `weaving`    — three strands plait around the sphere
 * - `composing`  — an undulating multi-band sash
 * - `breathing`  — a face-on ring slowly morphing
 * - `shaping`    — a dotted outline morphs circle → triangle → square
 */
export type OrbState =
  | 'working'
  | 'searching'
  | 'solving'
  | 'listening'
  | 'connecting'
  | 'weaving'
  | 'composing'
  | 'breathing'
  | 'shaping';

/**
 * Rendered size in CSS pixels. 64 (chat-avatar scale) and 20 (inline-text
 * scale) are hand-tuned designs, not a scale factor — each carries its own
 * dot count, dot size and speed. 32 (compact avatar scale) sits between
 * them and is interpolated from the two, in log space because those knobs
 * are ratios; it reads correctly but has not had a tuning pass of its own.
 */
export type OrbSize = 64 | 32 | 20;
