import { Skeleton } from "@shared/ui/ui/skeleton";

/**
 * One list row's place while a settings panel's first read is out: as tall as
 * the row that replaces it, at every width, so nothing below the list moves
 * when it lands. A row is its name and two meta lines, 16px inside its card;
 * from `md` its actions sit beside the words, and below `md` under them, 40px
 * tall, so the row, and this block, are taller below `md`. `Skeleton` takes
 * its height inline, so each width gets its own block. A row whose words
 * wrap is taller still. Internal to this package.
 */
export function RowPlaceholder() {
  return (
    <>
      <div class="md:hidden">
        <Skeleton standsFor="row" height={ROW_HEIGHT_BELOW_MD} />
      </div>
      <div class="max-md:hidden">
        <Skeleton standsFor="row" height={ROW_HEIGHT} />
      </div>
    </>
  );
}

/** A row's height in spacing steps from `md`: three 18px lines, 2px apart, 16px inside, a 1px edge. */
const ROW_HEIGHT = 23;
/** A row's height in spacing steps below `md`: the same, then 12px and the 40px actions. */
const ROW_HEIGHT_BELOW_MD = 36;
