import { animate, stagger } from "motion";

/**
 * Plays the unlock reveal sequence:
 * 1. Login form fades out
 * 2. Welcome message fades in with a gold shimmer
 * 3. Events section slides up with staggered card entrance
 */
export async function unlockRevealSequence(
  loginForm: HTMLElement,
  welcomeEl: HTMLElement,
  eventsSection: HTMLElement,
) {
  // 1. Fade out the login form
  const fadeOut = animate(
    loginForm,
    { opacity: [1, 0], transform: ["translateY(0)", "translateY(-12px)"] },
    { duration: 0.35, easing: "ease-in" },
  );
  await fadeOut.finished;
  loginForm.style.display = "none";

  // 2. Reveal welcome message
  welcomeEl.style.display = "";
  animate(
    welcomeEl,
    { opacity: [0, 1], transform: ["translateY(16px)", "translateY(0)"] },
    { duration: 0.5, easing: [0.22, 1, 0.36, 1] },
  );

  // Gold shimmer on the heading
  const heading = welcomeEl.querySelector("h2");
  if (heading) {
    animate(
      heading,
      { opacity: [0.4, 1, 0.85, 1] },
      {
        duration: 1.2,
        easing: "ease-in-out",
      },
    );
  }

  // 3. Reveal events section with staggered cards
  eventsSection.style.display = "";
  await new Promise((r) => setTimeout(r, 200));

  animate(
    eventsSection,
    { opacity: [0, 1], transform: ["translateY(32px)", "translateY(0)"] },
    { duration: 0.5, easing: [0.22, 1, 0.36, 1] },
  );

  const cards = eventsSection.querySelectorAll("[data-event-card]");
  if (cards.length > 0) {
    animate(
      cards as NodeListOf<HTMLElement>,
      { opacity: [0, 1], transform: ["translateY(24px)", "translateY(0)"] },
      {
        duration: 0.45,
        easing: [0.22, 1, 0.36, 1],
        delay: stagger(0.12, { start: 0.15 }),
      },
    );
  }
}
