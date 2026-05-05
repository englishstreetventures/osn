import type { DressCodeInfo } from "./types";

/**
 * Per-event dress code data. Hardcoded for now — will move to the
 * backend once the events API returns dress code info.
 */
export const EVENT_DRESS_CODES: Record<string, DressCodeInfo> = {
  mehndi: {
    description:
      "Bright, festive colours encouraged. Traditional or semi-formal Indian attire warmly welcomed.",
    palette: [
      { name: "Marigold", color: "oklch(76.36% 0.1533 75.16)" },
      { name: "Fuchsia", color: "oklch(54.66% 0.2139 352.16)" },
      { name: "Emerald", color: "oklch(46.05% 0.1156 153.58)" },
      { name: "Turquoise", color: "oklch(70.15% 0.1115 186.68)" },
    ],
  },
  sangeet: {
    description:
      "Glamorous and bold — think sequins, rich fabrics, and jewel tones. This is the party night!",
    palette: [
      { name: "Royal Blue", color: "oklch(37.91% 0.1378 265.52)" },
      { name: "Gold", color: "oklch(74.99% 0.0854 82.08)" },
      { name: "Plum", color: "oklch(38.22% 0.1235 340.14)" },
      { name: "Champagne", color: "oklch(93.01% 0.0380 81.51)" },
    ],
  },
  wedding: {
    description:
      "Elegant and formal. Please avoid wearing white or black. Traditional attire from any culture is welcome.",
    palette: [
      { name: "Sage", color: "oklch(72.88% 0.0585 128.92)" },
      { name: "Dusty Rose", color: "oklch(78.63% 0.0634 48.93)" },
      { name: "Ivory", color: "oklch(99.60% 0.0196 106.75)" },
      { name: "Gold", color: "oklch(74.99% 0.0854 82.08)" },
      { name: "Burgundy", color: "oklch(40.08% 0.0948 15.09)" },
    ],
  },
};
