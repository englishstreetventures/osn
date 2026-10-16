/**
 * Bun preload that moves every `Date` in the process onto the suite's clock.
 *
 * The clock starts at `E2E_CLOCK_T0` (epoch ms) at the real instant
 * `E2E_CLOCK_R0` (epoch ms, the launcher's own start) and ticks in real time
 * from there. Every server and the browser share the same pair, so they agree
 * on "now" to within a second, and that "now" sits at the same calendar date on
 * every run — seed deadlines and "must be in the future" checks resolve the
 * same way whenever the suite runs.
 *
 * A `Proxy` over the native constructor, not a subclass: dates created anywhere
 * keep the native prototype, so `instanceof Date` holds for all of them.
 * Plain JavaScript because it loads into both runtimes: `BUN_OPTIONS="--preload …"`
 * for the APIs, and `NODE_OPTIONS="--import …"` for Vite and Astro, whose SSR
 * renders the cire invite's open-or-closed state from this clock. A process
 * without both variables is left untouched.
 */

const t0 = Number(process.env["E2E_CLOCK_T0"]);
const r0 = Number(process.env["E2E_CLOCK_R0"]);

if (Number.isFinite(t0) && Number.isFinite(r0)) {
  const NativeDate = globalThis.Date;
  const nativeNow = NativeDate.now.bind(NativeDate);
  const now = () => t0 + (nativeNow() - r0);

  globalThis.Date = new Proxy(NativeDate, {
    construct(target, args, newTarget) {
      const resolved = args.length === 0 ? [now()] : args;
      return Reflect.construct(target, resolved, newTarget);
    },
    apply() {
      return new NativeDate(now()).toString();
    },
    get(target, prop) {
      return prop === "now" ? now : target[prop];
    },
  });
}
