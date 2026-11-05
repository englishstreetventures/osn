import { cardClass } from "@cire/ui/card";

import { BLOCK_CHOSEN, BLOCK_IDLE } from "../../lib/chosen-block";

/**
 * One card of the invite builder's pickers — a design, an envelope: the card
 * at its small step with no ground of its own, its contents stacked from the
 * start, marked as a block pressed to choose is (DESIGN.md §4, One pill
 * language): chosen, a gold edge and a 2px ring; unchosen, half of that under
 * the pointer. Both pickers draw their cards from here, so they match.
 */
const PICKER_CARD = `${cardClass({ padding: "sm", fill: "none" })} items-start gap-2 transition-[color,background-color,border-color,box-shadow]`;

export function pickerCardClass(chosen: boolean): string {
  return `${PICKER_CARD} ${chosen ? BLOCK_CHOSEN : BLOCK_IDLE}`;
}
