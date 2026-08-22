// Geometry for pen input: stroke measurement, hit testing, and the math that
// decides where an edge attaches to a node.
//
// Everything here works in *world* coordinates (canvas space), never screen
// space. The editor converts once, at the pointer event, and never again.

import type { Side } from "./jsoncanvas";

export type Pt = { x: number; y: number; p: number; t: number };
export type Rect = { x: number; y: number; width: number; height: number };

export function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pathLength(pts: Pt[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  return total;
}

export function bbox(pts: Pt[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Signed area via the shoelace formula. Magnitude tells us how much a stroke
 * encloses — a scribble has a large path length but near-zero enclosed area,
 * which is exactly what separates it from a loop.
 */
export function signedArea(pts: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * Moving-average smoothing. Apple Pencil faithfully records hand tremor, and
 * tremor at the sample level reads as dozens of sharp direction changes — which
 * is indistinguishable from a scribble unless it is filtered out first. Endpoints
 * are preserved exactly, because closure detection depends on them.
 */
export function smooth(pts: Pt[], window = 2): Pt[] {
  if (pts.length < 5) return pts.slice();
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0 || i === pts.length - 1) {
      out.push(pts[i]);
      continue;
    }
    const lo = Math.max(0, i - window);
    const hi = Math.min(pts.length - 1, i + window);
    let x = 0;
    let y = 0;
    for (let j = lo; j <= hi; j++) {
      x += pts[j].x;
      y += pts[j].y;
    }
    const n = hi - lo + 1;
    out.push({ x: x / n, y: y / n, p: pts[i].p, t: pts[i].t });
  }
  return out;
}

/** Ramer–Douglas–Peucker. Turn 400 raw samples into the ~10 that carry shape. */
export function simplify(pts: Pt[], tolerance: number): Pt[] {
  if (pts.length < 3) return pts.slice();

  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = true;
  keep[pts.length - 1] = true;

  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let maxDist = 0;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(pts[i], pts[start], pts[end]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > tolerance) {
      keep[index] = true;
      stack.push([start, index], [index, end]);
    }
  }

  return pts.filter((_, i) => keep[i]);
}

function perpendicularDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Total absolute turning, in radians, across a simplified stroke. A straight
 * line is ~0; a circle is ~2π; a back-and-forth scribble runs far past that.
 */
export function totalTurning(pts: Pt[]): number {
  if (pts.length < 3) return 0;
  let total = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
    const b = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
    let delta = b - a;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    total += Math.abs(delta);
  }
  return total;
}

export function pointInRect(p: { x: number; y: number }, r: Rect, pad = 0): boolean {
  return (
    p.x >= r.x - pad && p.x <= r.x + r.width + pad && p.y >= r.y - pad && p.y <= r.y + r.height + pad
  );
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

export function rectCenter(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Does any segment of the stroke pass through this rect? */
export function strokeCrossesRect(pts: Pt[], r: Rect): boolean {
  for (const p of pts) if (pointInRect(p, r)) return true;
  for (let i = 1; i < pts.length; i++) {
    if (segmentIntersectsRect(pts[i - 1], pts[i], r)) return true;
  }
  return false;
}

export function segmentIntersectsRect(a: Pt, b: Pt, r: Rect): boolean {
  if (pointInRect(a, r) || pointInRect(b, r)) return true;
  const x2 = r.x + r.width;
  const y2 = r.y + r.height;
  return (
    segmentsIntersect(a, b, { x: r.x, y: r.y }, { x: x2, y: r.y }) ||
    segmentsIntersect(a, b, { x: x2, y: r.y }, { x: x2, y: y2 }) ||
    segmentsIntersect(a, b, { x: x2, y: y2 }, { x: r.x, y: y2 }) ||
    segmentsIntersect(a, b, { x: r.x, y: y2 }, { x: r.x, y: r.y })
  );
}

type P2 = { x: number; y: number };

export function segmentsIntersect(a: P2, b: P2, c: P2, d: P2): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

function cross(a: P2, b: P2, c: P2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Shortest distance from a point to a polyline — used for edge hit testing. */
export function distanceToPolyline(p: P2, pts: P2[]): number {
  let min = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = perpendicularDistance(
      { ...p, p: 0, t: 0 } as Pt,
      { ...pts[i - 1], p: 0, t: 0 } as Pt,
      { ...pts[i], p: 0, t: 0 } as Pt,
    );
    if (d < min) min = d;
  }
  return min;
}

/**
 * Which side of a rect a point is nearest, measured by how far outside each
 * edge it sits. This decides an edge's fromSide/toSide, so a stroke leaving a
 * node's right edge produces a connector that visibly leaves from the right.
 */
export function nearestSide(r: Rect, p: P2): Side {
  const left = r.x - p.x;
  const right = p.x - (r.x + r.width);
  const top = r.y - p.y;
  const bottom = p.y - (r.y + r.height);
  const max = Math.max(left, right, top, bottom);
  if (max === right) return "right";
  if (max === left) return "left";
  if (max === bottom) return "bottom";
  return "top";
}

/** The point on a rect where an edge attached to `side` should start or end. */
export function anchorPoint(r: Rect, side: Side): P2 {
  switch (side) {
    case "top":
      return { x: r.x + r.width / 2, y: r.y };
    case "bottom":
      return { x: r.x + r.width / 2, y: r.y + r.height };
    case "left":
      return { x: r.x, y: r.y + r.height / 2 };
    case "right":
      return { x: r.x + r.width, y: r.y + r.height / 2 };
  }
}

/** Outward unit normal for a side — the direction a bezier control point goes. */
export function sideNormal(side: Side): P2 {
  switch (side) {
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
  }
}

export function snap(value: number, grid: number): number {
  return Math.round(value / grid) * grid;
}

/**
 * Isoperimetric quotient: 4·π·area / length². A perfect circle scores 1, a
 * hand-drawn one still scores high, and a scribble — which covers distance
 * without enclosing anything — scores near zero. This separates "went around
 * something" from "crossed it out" far more reliably than counting corners,
 * because tremor adds corners but does not add enclosed area.
 */
export function compactness(enclosedArea: number, length: number): number {
  if (length <= 0) return 0;
  return (4 * Math.PI * enclosedArea) / (length * length);
}
