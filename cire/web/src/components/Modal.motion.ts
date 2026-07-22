import { animate } from "motion";

export function modalEnter(backdrop: HTMLElement, panel: HTMLElement) {
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
