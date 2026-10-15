/** Public AUD offer. Check the configured Stripe prices before publishing changes. */
export const PLANS = [
  {
    id: "ivory",
    name: "Ivory",
    price: 0,
    guestCap: 100,
    description: "A beautiful first impression.",
    inclusions: [
      "Classic and Gala invitations",
      "Events, guest list and RSVPs",
      "Guest import and household codes",
      "Co-hosts to share the planning",
    ],
  },
  {
    id: "gold",
    name: "Gold",
    price: 79,
    guestCap: 500,
    description: "A home for the bigger picture.",
    inclusions: [
      "Everything in Ivory",
      "Budget and payment tracking",
      "Your wedding checklist",
      "Gift registry and gift log",
    ],
  },
  {
    id: "crimson",
    name: "Crimson",
    price: 149,
    guestCap: 1000,
    description: "Bring your wedding team together.",
    inclusions: [
      "Everything in Gold",
      "Vendor contacts and pipeline",
      "Directory and vendor enquiries",
      "Quotes and conversations",
    ],
  },
] as const;

export const GOLD_TO_CRIMSON_PRICE = PLANS[2].price - PLANS[1].price;
