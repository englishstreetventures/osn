import { cardClass } from "@cire/ui/card";

import { BLOCK_CHOSEN, BLOCK_REST } from "../../lib/chosen-block";

/**
 * One card of the invite builder's pickers — a design, an envelope: the card
 * at its small step with no ground of its own, its contents stacked from the
 * start, marked as a block pressed to choose is (DESIGN.md §4, One pill
 * language): chosen, a gold edge and a 2px ring; unchosen, half of that under
 * the pointer. Both pickers draw their cards from here, so they match.
 */
const PICKER_CARD = `${cardClass({ padding: "sm", fill: "none" })} items-start gap-2 transition-[color,background-color,border-color,box-shadow]`;

/**
 * The card is not the control: it holds a radio, and a design's card a
 * "Preview live" link beside it. So an unchosen card goes halfway only while
 * the pointer is on a radio a press would choose — never over the card's
 * padding or its link, and never on a locked choice or during a save, both
 * `aria-disabled` (DESIGN.md §7, Card: a hover promises a click).
 */
const PICKER_IDLE = `${BLOCK_REST} has-[[role=radio]:not([aria-disabled]):hover]:border-gold/50 has-[[role=radio]:not([aria-disabled]):hover]:ring-1 has-[[role=radio]:not([aria-disabled]):hover]:ring-gold/30`;

export function pickerCardClass(chosen: boolean): string {
  return `${PICKER_CARD} ${chosen ? BLOCK_CHOSEN : PICKER_IDLE}`;
}
