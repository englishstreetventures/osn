import type { ArgValue, ControlSpec } from "./types.ts";

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Picks a control from the initial value, so a story that just writes
 * `args: { label: "Hi", rounded: true }` gets a text box and a checkbox for
 * free. An explicit `controls` entry always wins.
 *
 * Kept out of `controls.tsx` so it can be tested without a JSX transform:
 * `vite-plugin-solid` adds a `@testing-library/jest-dom` setup file to any
 * vitest run, and the lab has no reason to carry a DOM matcher library.
 */
export function inferControl(value: ArgValue): ControlSpec {
  if (typeof value === "boolean") return { kind: "boolean" };
  if (typeof value === "number") return { kind: "number" };
  if (HEX.test(value)) return { kind: "color" };
  return value.length > 40 ? { kind: "textarea" } : { kind: "text" };
}
