// Stroke → intent.
//
// This is the core of the pen model: the user never picks a tool, so the shape
// of the stroke has to say what they wanted. Five outcomes:
//
//   tap        a short dab              → select, or open the text editor
//   scribble   back-and-forth crossing  → delete what it crossed
//   connect    node A ➜ node B          → draw an edge
//   branch     node A ➜ empty space     → new node there, joined to A
//   loop       a closed shape           → new node at its bounds
//
// Order matters and is not arbitrary. Scribble is tested before loop because a
// vigorous scribble often closes on itself by accident. Connect and branch are
// tested before loop because a stroke that starts and ends inside two
// *different* nodes is never a loop, while one that starts and ends in the same
// node falls through to loop on purpose — that's how you nest an idea.
//
// Thresholds are expressed in world units and tuned for Apple Pencil at 1:1
// zoom. They are exported so they can be tuned from one place.

import {
  bbox,
  dist,
  pathLength,
  pointInRect,
  reversalCount,
  signedArea,
  simplify,
  strokeCrossesRect,
  type Pt,
  type Rect,
} from "./geometry";
import { nearestSide } from "./geometry";
import type { CanvasNode, Side } from "./jsoncanvas";

export const RECOGNIZER = {
  /** Below this path length a stroke is a dab, not a mark. */
  tapMaxLength: 12,
  /** How close to a node counts as "on" it, for starting/ending a stroke. */
  nodeHitPadding: 8,
  /** A loop's endpoints must land this close, relative to its own size. */
  loopClosureRatio: 0.28,
  /** Enclosed area below this is a squiggle, not a shape. */
  loopMinArea: 900,
  /** Doubling back this many times reads as a scribble-out. */
  scribbleMinReversals: 4,
  /** Scribbles cover far more distance than their bounding box diagonal. */
  scribbleMinLengthRatio: 2.2,
  /** A branch flick must travel mostly in one direction, not curl back. */
  branchMinDirectness: 0.55,
  /** New nodes never come out smaller than this. */
  minNodeSize: { width: 120, height: 60 },
  /** Simplification tolerance before shape analysis. */
  simplifyTolerance: 2.5,
} as const;

export type Gesture =
  | { kind: "tap"; at: { x: number; y: number }; nodeId: string | null }
  | { kind: "scribble"; nodeIds: string[]; strokePoints: Pt[] }
  | { kind: "connect"; fromId: string; toId: string; fromSide: Side; toSide: Side }
  | { kind: "branch"; fromId: string; fromSide: Side; rect: Rect }
  | { kind: "loop"; rect: Rect }
  | { kind: "unknown" };

export function nodeRect(node: CanvasNode): Rect {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

/** Topmost node containing the point — later nodes render above earlier ones. */
export function nodeAt(nodes: CanvasNode[], p: { x: number; y: number }, pad = 0): CanvasNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (pointInRect(p, nodeRect(nodes[i]), pad)) return nodes[i];
  }
  return null;
}

/**
 * Grow a raw bounding box into a node rect: enforce a minimum size and keep it
 * centered on what was actually drawn, so a small circle still yields a node
 * big enough to hold text without jumping away from the ink.
 */
export function rectFromBounds(b: Rect): Rect {
  const width = Math.max(b.width, RECOGNIZER.minNodeSize.width);
  const height = Math.max(b.height, RECOGNIZER.minNodeSize.height);
  return {
    x: b.x + b.width / 2 - width / 2,
    y: b.y + b.height / 2 - height / 2,
    width,
    height,
  };
}

export function recognize(raw: Pt[], nodes: CanvasNode[]): Gesture {
  if (raw.length === 0) return { kind: "unknown" };

  const first = raw[0];
  const last = raw[raw.length - 1];
  const length = pathLength(raw);

  // 1. Tap — too little travel to be a shape.
  if (length < RECOGNIZER.tapMaxLength) {
    const hit = nodeAt(nodes, first, RECOGNIZER.nodeHitPadding);
    return { kind: "tap", at: { x: first.x, y: first.y }, nodeId: hit?.id ?? null };
  }

  const pts = simplify(raw, RECOGNIZER.simplifyTolerance);
  const bounds = bbox(raw);
  const diagonal = Math.hypot(bounds.width, bounds.height) || 1;

  // 2. Scribble — lots of doubling back over a small area.
  const reversals = reversalCount(pts);
  if (reversals >= RECOGNIZER.scribbleMinReversals && length / diagonal >= RECOGNIZER.scribbleMinLengthRatio) {
    const hitIds = nodes.filter((n) => strokeCrossesRect(raw, nodeRect(n))).map((n) => n.id);
    return { kind: "scribble", nodeIds: hitIds, strokePoints: raw };
  }

  const startNode = nodeAt(nodes, first, RECOGNIZER.nodeHitPadding);
  const endNode = nodeAt(nodes, last, RECOGNIZER.nodeHitPadding);

  // 3. Connect — from one node to a different one.
  if (startNode && endNode && startNode.id !== endNode.id) {
    return {
      kind: "connect",
      fromId: startNode.id,
      toId: endNode.id,
      fromSide: exitSide(raw, startNode),
      toSide: entrySide(raw, endNode),
    };
  }

  // 4. Branch — out of a node into open space, in a committed direction.
  if (startNode && !endNode) {
    const directness = dist(first, last) / length;
    if (directness >= RECOGNIZER.branchMinDirectness) {
      const rect = rectFromBounds({ x: last.x, y: last.y, width: 0, height: 0 });
      return { kind: "branch", fromId: startNode.id, fromSide: exitSide(raw, startNode), rect };
    }
  }

  // 5. Loop — ends near where it started, and encloses real area.
  const closure = dist(first, last) / diagonal;
  const area = Math.abs(signedArea(pts));
  if (closure <= RECOGNIZER.loopClosureRatio && area >= RECOGNIZER.loopMinArea) {
    return { kind: "loop", rect: rectFromBounds(bounds) };
  }

  return { kind: "unknown" };
}

/** Where the stroke last sat inside the node before leaving it. */
function exitSide(pts: Pt[], node: CanvasNode): Side {
  const r = nodeRect(node);
  let lastInside = 0;
  for (let i = 0; i < pts.length; i++) {
    if (pointInRect(pts[i], r, RECOGNIZER.nodeHitPadding)) lastInside = i;
    else break;
  }
  const after = pts[Math.min(lastInside + 1, pts.length - 1)];
  return nearestSide(r, after);
}

/** Where the stroke first arrived inside the node. */
function entrySide(pts: Pt[], node: CanvasNode): Side {
  const r = nodeRect(node);
  let firstInside = pts.length - 1;
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pointInRect(pts[i], r, RECOGNIZER.nodeHitPadding)) firstInside = i;
    else break;
  }
  const before = pts[Math.max(firstInside - 1, 0)];
  return nearestSide(r, before);
}
