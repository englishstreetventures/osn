export const claimBoxEntrance = { opacity: [0, 1], y: [32, 0] }
export const inviteEntrance = { opacity: [0, 1], y: [16, 0] }
export const transitionBase = { duration: 0.55, easing: "ease-out" as const }
export const transitionStagger = (index: number) => ({
  duration: 0.45,
  easing: "ease-out" as const,
  delay: 0.1 + index * 0.12,
})
