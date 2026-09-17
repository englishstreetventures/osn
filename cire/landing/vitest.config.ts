import solidPlugin from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    // happy-dom, not jsdom, and it is not a preference: jsdom implements no
    // part of `<dialog>` — `showModal` is `undefined` there — so the demo
    // sheet, which is `@shared/ui`'s `Modal`, cannot open at all. happy-dom has
    // it, and it is what every other component-testing package here uses.
    environment: "happy-dom",
    transformMode: { web: [/\.[jt]sx?$/] },
    passWithNoTests: true,
    setupFiles: ["../../shared/test-config/no-jest-dom.ts"],
  },
});
