/**
 * A minimum gap between calls, so a bulk run stays under GitHub's rate limits.
 *
 * `backfill-project.ts` is the last caller. The rest of the migration tool
 * went with the checklists it read.
 */
export class Throttle {
  #last = 0;
  constructor(private readonly minIntervalMs: number) {}
  async wait(): Promise<void> {
    const elapsed = Date.now() - this.#last;
    if (this.#last > 0 && elapsed < this.minIntervalMs) {
      await Bun.sleep(this.minIntervalMs - elapsed);
    }
    this.#last = Date.now();
  }
}
