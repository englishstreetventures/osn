// A clock preload that moves `Date.now()` and nothing else: what `clock.mjs`
// would be with its `construct` and `apply` traps broken. `launcher.test.ts`
// loads it to prove the clock probe sees each trap on its own.
const t0 = Number(process.env["E2E_CLOCK_T0"]);
const r0 = Number(process.env["E2E_CLOCK_R0"]);
const nativeNow = Date.now.bind(Date);
Date.now = () => t0 + (nativeNow() - r0);
