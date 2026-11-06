// A clock preload whose dates do not name the global `Date` as their
// constructor: `clock.mjs` without the line that points the prototype's
// `constructor` at its proxy. A serialiser that matches a value's class by
// `value.constructor` (seroval, which renders Pulse web's server data into its
// pages) then refuses every date. `launcher.test.ts` loads it to prove the
// clock probe sees that.
const t0 = Number(process.env["E2E_CLOCK_T0"]);
const r0 = Number(process.env["E2E_CLOCK_R0"]);
const NativeDate = globalThis.Date;
const nativeNow = NativeDate.now.bind(NativeDate);
const now = () => t0 + (nativeNow() - r0);
globalThis.Date = new Proxy(NativeDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget);
  },
  apply() {
    return new NativeDate(now()).toString();
  },
  get(target, prop) {
    return prop === "now" ? now : target[prop];
  },
});
