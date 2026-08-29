// Turning a pen stroke into ink that belongs to a card.
//
// Pure, and deliberately small: the editor decides *when* a stroke is ink, and
// this decides what the ink is. Two conversions live here — a captured stroke
// becomes card-local points, and those points become something an SVG can draw.

import { simplify, type Pt, type Rect } from "./geometry";
import type { InkStroke } from "./jsoncanvas";

/**
 * How far a point may be dropped from the line it sits on, in card pixels.
 *
 * Deliberately smaller than the recognizer's tolerance. The recognizer is
 * asking what a stroke *meant* and wants the tremor gone; this is the stroke
 * itself, and flattening handwriting would change what it says.
 */
export const INK_TOLERANCE = 0.9;

/** Nib width at no pressure, and how much a hard press adds. */
export const INK_WIDTH_MIN = 1.4;
export const INK_WIDTH_RANGE = 2.4;

/** Below this many points a stroke is a slip of the hand, not a mark. */
const MIN_POINTS = 2;

/**
 * A captured stroke, as ink on the card it was drawn in.
 *
 * Points arrive in world space and are stored relative to the card's top-left,
 * clamped to its bounds — the card clips what it draws, so ink that wandered
 * outside would be kept but never seen again.
 *
 * One width for the whole stroke, from its mean pressure. Per-segment widths
 * would need a filled outline rather than a stroked path, which is a great deal
 * of machinery for a nib that varies by a pixel across a handwritten word.
 */
export function inkFromStroke(points: Pt[], card: Rect): InkStroke | null {
  if (points.length < MIN_POINTS) return null;

  const local = points.map((p) => ({
    x: clamp(p.x - card.x, 0, card.width),
    y: clamp(p.y - card.y, 0, card.height),
    p: p.p,
    t: p.t,
  }));

  const kept = simplify(local, INK_TOLERANCE);
  if (kept.length < MIN_POINTS) return null;

  const flat: number[] = [];
  for (const point of kept) {
    // Rounded, for the same reason the spec rounds geometry: a card of
    // handwriting is a lot of numbers, and none of them need a decimal.
    flat.push(Math.round(point.x), Math.round(point.y));
  }

  const pressure = points.reduce((sum, point) => sum + (point.p || 0.5), 0) / points.length;
  return {
    points: flat,
    width: Math.round((INK_WIDTH_MIN + pressure * INK_WIDTH_RANGE) * 10) / 10,
  };
}

/**
 * An SVG path for a stroke.
 *
 * Each segment is a quadratic through the midpoints of the simplified points,
 * which is what turns a run of straight hops back into something that reads as
 * handwriting. A polyline of the same points looks like it was drawn with a
 * ruler at every corner.
 */
export function strokePath(stroke: InkStroke): string {
  const xs = stroke.points;
  const at = (i: number) => ({ x: xs[i * 2], y: xs[i * 2 + 1] });
  const count = Math.floor(xs.length / 2);
  if (count < 2) return "";

  const first = at(0);
  if (count === 2) {
    const second = at(1);
    return `M${first.x} ${first.y}L${second.x} ${second.y}`;
  }

  let d = `M${first.x} ${first.y}`;
  for (let i = 1; i < count - 1; i++) {
    const point = at(i);
    const next = at(i + 1);
    const midX = round((point.x + next.x) / 2);
    const midY = round((point.y + next.y) / 2);
    d += `Q${point.x} ${point.y} ${midX} ${midY}`;
  }
  const last = at(count - 1);
  d += `L${last.x} ${last.y}`;
  return d;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
