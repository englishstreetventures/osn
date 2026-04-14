import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class strings with Tailwind conflict resolution. Use this when
 * composing arbitrary runtime class sets where conflicts are possible
 * and unpredictable (e.g. two signals that may or may not produce
 * overlapping utilities).
 *
 * For component defaults vs consumer overrides, prefer the `base:`
 * variant pattern with `bx()` instead — it resolves conflicts via CSS
 * cascade at zero runtime cost.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Prefix every utility in a class string with the `base:` custom
 * variant. Classes wrapped in `base:` compile to `:where()` selectors
 * with zero specificity, so any unprefixed consumer class automatically
 * wins via CSS cascade — no runtime `twMerge` needed.
 *
 * Use this in component files for default styles:
 * ```tsx
 * <div class={clsx(bx("bg-card rounded-xl border"), local.class)} />
 * ```
 *
 * Consumers override naturally:
 * ```tsx
 * <Card class="bg-card/50 rounded-md" />  // wins over base: defaults
 * ```
 */
export function bx(classes: string): string {
  return classes.replace(/\S+/g, (c) => `base:${c}`);
}

export { clsx };
export type { ClassValue };
