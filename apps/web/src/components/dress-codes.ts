import type { DressCodeInfo } from "./types"

/**
 * Per-event dress code data. Hardcoded for now — will move to the
 * backend once the events API returns dress code info.
 */
export const EVENT_DRESS_CODES: Record<string, DressCodeInfo> = {
  mehndi: {
    description:
      "Bright, festive colours encouraged. Traditional or semi-formal Indian attire warmly welcomed.",
    palette: [
      { name: "Marigold", hex: "#EAA221" },
      { name: "Fuchsia", hex: "#C4197D" },
      { name: "Emerald", hex: "#046A38" },
      { name: "Turquoise", hex: "#30B5AA" },
    ],
  },
  sangeet: {
    description:
      "Glamorous and bold — think sequins, rich fabrics, and jewel tones. This is the party night!",
    palette: [
      { name: "Royal Blue", hex: "#1E3A8A" },
      { name: "Gold", hex: "#C9A96E" },
      { name: "Plum", hex: "#6B2157" },
      { name: "Champagne", hex: "#F5E6CC" },
    ],
  },
  wedding: {
    description:
      "Elegant and formal. Please avoid wearing white or black. Traditional attire from any culture is welcome.",
    palette: [
      { name: "Sage", hex: "#9CAF88" },
      { name: "Dusty Rose", hex: "#DCAE96" },
      { name: "Ivory", hex: "#FFFFF0" },
      { name: "Gold", hex: "#C9A96E" },
      { name: "Burgundy", hex: "#722F37" },
    ],
  },
}
