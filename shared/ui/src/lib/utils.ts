/**
 * `clsx` joins class strings and drops falsy values. It does no Tailwind
 * conflict resolution: when two utilities set the same property, both stay
 * in the string and the stylesheet decides.
 *
 * Components never need it to. A component writes its defaults with the
 * `base:` variant, literally in the source string so Tailwind's scanner sees
 * them; `base:` compiles to a zero-specificity `:where()` selector, so any
 * unprefixed utility a caller passes wins through the cascade.
 */
import { type ClassValue, clsx } from "clsx";

export { clsx };
export type { ClassValue };
