import type { DragTarget, MeasuredTarget } from "./types";

/**
 * The droppable whose centre is nearest the pointer.
 *
 * The right detector for a single-column list: a row is "over" the neighbour it
 * has travelled at least half-way into, which is what makes a drag feel like it
 * displaces rows one at a time.
 *
 * Measures from the POINTER against geometry captured at drag start — not
 * against live rects. A live read would see each row where its transform has
 * currently put it, so a displaced row would be measured in the slot it is
 * moving *to* rather than the one it belongs to, and the detector would chase
 * its own output.
 *
 * Ties resolve to the FIRST candidate, which keeps the result stable when two
 * rows have identical geometry — the usual case under a test DOM.
 */
export function closestCenter(
  draggable: DragTarget,
  droppables: MeasuredTarget[],
  pointer: { x: number; y: number },
): DragTarget | null {
  let best: MeasuredTarget | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of droppables) {
    if (candidate.id === draggable.id) continue;
    const cx = candidate.rect.left + candidate.rect.width / 2;
    const cy = candidate.rect.top + candidate.rect.height / 2;
    const dx = cx - pointer.x;
    const dy = cy - pointer.y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best ? { id: best.id, node: best.node } : null;
}

/**
 * The drop zone whose rectangle holds the pointer, or `null` between zones.
 *
 * The detector for dropping INTO a container — a guest onto a table — where
 * "nearest" would be wrong: a release in the gap between two tables, or over
 * anything that is not a table, must drop nowhere rather than on whichever
 * table happens to be closest. Measured against geometry captured at drag
 * start, as `closestCenter` is. Overlapping zones resolve to the first.
 */
export function pointerWithin(
  _draggable: DragTarget,
  droppables: MeasuredTarget[],
  pointer: { x: number; y: number },
): DragTarget | null {
  for (const candidate of droppables) {
    const { left, right, top, bottom } = candidate.rect;
    if (pointer.x >= left && pointer.x <= right && pointer.y >= top && pointer.y <= bottom) {
      return { id: candidate.id, node: candidate.node };
    }
  }
  return null;
}
