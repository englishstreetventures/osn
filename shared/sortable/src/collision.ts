import type { DragTarget } from "./types";

interface Centre {
  target: DragTarget;
  x: number;
  y: number;
}

function centres(targets: DragTarget[]): Centre[] {
  return targets.map((target) => {
    const r = target.node.getBoundingClientRect();
    return { target, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

/**
 * The droppable whose centre is nearest the dragged item's current centre.
 *
 * The right detector for a single-column list: a row is "over" the neighbour it
 * has travelled at least half-way into, which is what makes a drag feel like it
 * displaces rows one at a time.
 *
 * Ties resolve to the FIRST candidate, which keeps the result stable when two
 * rows have identical geometry — the usual case under a test DOM that reports
 * every rect as zeroes.
 */
export function closestCenter(
  draggable: DragTarget,
  droppables: DragTarget[],
  pointer: { x: number; y: number },
): DragTarget | null {
  const candidates = centres(droppables.filter((d) => d.id !== draggable.id));
  if (candidates.length === 0) return null;

  // Measure from the POINTER, not the dragged node's original box: the node is
  // painted with a transform but its layout rect never moves, so measuring the
  // node would report the same collision for the whole gesture.
  let best: Centre | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const dx = candidate.x - pointer.x;
    const dy = candidate.y - pointer.y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best?.target ?? null;
}
