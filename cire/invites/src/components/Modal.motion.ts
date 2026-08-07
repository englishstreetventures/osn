import { animate } from "motion";

/**
 * True when the guest's device asks for reduced motion.
 *
 * The global `prefers-reduced-motion` block in `global.css` cannot help here:
 * `motion`'s `animate()` drives the Web Animations API, which ignores the CSS
 * `animation-duration` / `transition-duration` overrides entirely. For WAAPI the
 * check has to happen in JavaScript, at the call site.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function modalEnter(backdrop: HTMLElement, panel: HTMLElement) {
  if (prefersReducedMotion()) {
    // Same end state, no travel: the dialog is simply there.
    backdrop.style.opacity = "1";
    panel.style.opacity = "1";
    panel.style.transform = "none";
    return;
  }
  animate(backdrop, { opacity: [0, 1] }, { duration: 0.25, ease: "easeOut" });
  animate(
    panel,
    {
      opacity: [0, 1],
      transform: ["translateY(40px) scale(0.97)", "translateY(0) scale(1)"],
    },
    { duration: 0.35, ease: [0.22, 1, 0.36, 1] },
  );
}

export async function modalExit(backdrop: HTMLElement, panel: HTMLElement) {
  if (prefersReducedMotion()) {
    // Resolve at once — the caller awaits this before unmounting, so returning
    // early is what makes the close instant rather than a 200ms slide.
    backdrop.style.opacity = "0";
    panel.style.opacity = "0";
    return;
  }
  animate(backdrop, { opacity: [1, 0] }, { duration: 0.2, ease: "easeIn" });
  const panelAnim = animate(
    panel,
    {
      opacity: [1, 0],
      transform: ["translateY(0) scale(1)", "translateY(24px) scale(0.97)"],
    },
    { duration: 0.2, ease: [0.4, 0, 1, 1] },
  );
  await panelAnim.finished;
}
