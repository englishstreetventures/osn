/**
 * A block pressed to choose — a code-style or re-mint radio card, a design
 * card — marked as `Button`'s `choice` marks a chosen answer, at the block's
 * own corner (DESIGN.md §4, One pill language): a gold edge and a 2px ring at
 * 60%, no wash; the block keeps its own ground. Under the pointer an unchosen
 * block goes halfway, a gold edge
 * at half and a 1px ring at 30%, so a hover never reads as a choice made.
 *
 * The one motion rule: the element names `color`, `background-color`,
 * `border-color` and `box-shadow` in its transition; at rest they move on
 * `--dur-fast` with `--ease-out`, and a block being chosen on `--dur-base`
 * with `--ease-in-out`. No outline is named, so the focus ring lands at once.
 */
export const BLOCK_IDLE =
  "border-border duration-(--dur-fast) ease-(--ease-out) hover:border-gold/50 hover:ring-1 hover:ring-gold/30";

export const BLOCK_CHOSEN =
  "border-gold ring-2 ring-gold/60 duration-(--dur-base) ease-(--ease-in-out)";
