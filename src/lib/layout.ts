// Where a card goes when the app is the one placing it.
//
// Anything the app puts down by itself — a card drawn from a loop, a branch off
// another card, a pasted link, a photograph — has to land somewhere a person
// can see it. Cards you move by hand are your business; these are the ones
// nobody chose a spot for.
//
// Deliberately free of imports so the checks can run it directly, without a
// browser and without a build step in the way.

export type Box = { x: number; y: number; width: number; height: number };
export type Slide = "right" | "left" | "down" | "up";

/** Whether two boxes are closer than `padding`, touching included. */
export function boxesClash(a: Box, b: Box, padding = 0): boolean {
  return (
    a.x < b.x + b.width + padding &&
    b.x < a.x + a.width + padding &&
    a.y < b.y + b.height + padding &&
    b.y < a.y + a.height + padding
  );
}

/** Whether `inner` sits entirely within `outer`. */
export function boxContains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** Round away from what we are escaping, so a snap never eats the gap. */
function away(value: number, grid: number, forward: boolean): number {
  if (grid <= 0) return Math.round(value);
  return (forward ? Math.ceil(value / grid) : Math.floor(value / grid)) * grid;
}

/** The direction out of a pile that moves the box least. */
function cheapestWay(box: Box, blockers: Box[], padding: number): Slide {
  const right = Math.max(...blockers.map((b) => b.x + b.width)) + padding - box.x;
  const left = box.x - (Math.min(...blockers.map((b) => b.x)) - padding - box.width);
  const down = Math.max(...blockers.map((b) => b.y + b.height)) + padding - box.y;
  const up = box.y - (Math.min(...blockers.map((b) => b.y)) - padding - box.height);

  const options: Array<[Slide, number]> = [
    ["right", right],
    ["left", left],
    ["down", down],
    ["up", up],
  ];
  options.sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]));
  return options[0][0];
}

/**
 * Slide a box until nothing is within `padding` of it.
 *
 * It moves in **one direction only** — the one asked for, or the one that costs
 * the least — and each step clears the far edge of something it is currently
 * touching. Moving one way means a box can never be pushed back into what it
 * just escaped, which is what makes this terminate rather than oscillate
 * between two neighbours forever.
 *
 * `grid` rounds each step away from the obstacle, so a box that has to move
 * stays on the grid and keeps at least the padding it was asked for.
 */
export function slideClear(
  box: Box,
  others: Box[],
  padding: number,
  options: { toward?: Slide; grid?: number } = {},
): Box {
  const grid = options.grid ?? 0;
  const out = { ...box };

  let blockers = others.filter((o) => boxesClash(out, o, padding));
  if (blockers.length === 0) return out;

  const toward = options.toward ?? cheapestWay(out, blockers, padding);

  // Each pass clears everything it is touching now, and cannot meet any of it
  // again, so one pass per obstacle is more than enough.
  for (let guard = others.length + 1; guard > 0 && blockers.length > 0; guard--) {
    switch (toward) {
      case "right":
        out.x = away(Math.max(...blockers.map((b) => b.x + b.width)) + padding, grid, true);
        break;
      case "left":
        out.x = away(Math.min(...blockers.map((b) => b.x)) - padding - out.width, grid, false);
        break;
      case "down":
        out.y = away(Math.max(...blockers.map((b) => b.y + b.height)) + padding, grid, true);
        break;
      default:
        out.y = away(Math.min(...blockers.map((b) => b.y)) - padding - out.height, grid, false);
        break;
    }
    blockers = others.filter((o) => boxesClash(out, o, padding));
  }

  return out;
}
