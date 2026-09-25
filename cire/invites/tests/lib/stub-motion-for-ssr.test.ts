import { describe, expect, it } from "vitest";

import { MOTION_SSR_STUB_ID, stubMotionForSsr } from "../../src/lib/stub-motion-for-ssr";

const plugin = stubMotionForSsr();
const resolveSsr = (source: string) => plugin.resolveId(source, undefined, { ssr: true });

describe("stubMotionForSsr", () => {
  // `motion`'s own entry re-exports `framer-motion/dom`, and `motion-dom` and
  // `motion-utils` are what both of them build on. Any of these left to resolve
  // for real puts the library back into the Worker bundle.
  it.each([
    "motion",
    "motion/react",
    "motion/mini",
    "motion-dom",
    "motion-dom/dist/es/index.mjs",
    "motion-utils",
    "framer-motion",
    "framer-motion/dom",
    "framer-motion/dom/mini",
  ])("stubs %s in the SSR build", (source) => {
    expect(resolveSsr(source)).toBe(MOTION_SSR_STUB_ID);
  });

  it.each(["motion?url", "framer-motion/dom?raw"])(
    "stubs %s, ignoring the Vite query suffix",
    (source) => {
      expect(resolveSsr(source)).toBe(MOTION_SSR_STUB_ID);
    },
  );

  it.each([
    "motionless",
    "motion-canvas",
    "framer-motion-3d",
    "framer",
    "@motionone/dom",
    "solid-motionone",
    "emotion",
    "./motion",
    "../designs/gala/UnlockReveal.motion",
  ])("leaves %s alone in the SSR build", (source) => {
    expect(resolveSsr(source)).toBeNull();
  });

  it.each(["motion", "motion-dom", "framer-motion", "framer-motion/dom"])(
    "leaves %s to resolve for real in the client build",
    (source) => {
      expect(plugin.resolveId(source, undefined, { ssr: false })).toBeNull();
      expect(plugin.resolveId(source, undefined, undefined)).toBeNull();
    },
  );

  it("loads a stub whose animate() and stagger() throw rather than do nothing", async () => {
    const code = plugin.load(MOTION_SSR_STUB_ID);
    expect(code).not.toBeNull();
    const stub = (await import(
      /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(code ?? "")}`
    )) as { animate: () => unknown; stagger: () => unknown };
    expect(() => stub.animate()).toThrow(/stubbed out of the cire\/invites SSR build/);
    expect(() => stub.stagger()).toThrow(/stubbed out of the cire\/invites SSR build/);
  });

  it("loads nothing for any other module id", () => {
    expect(plugin.load("motion")).toBeNull();
    expect(plugin.load("/src/components/Modal.motion.ts")).toBeNull();
  });
});
