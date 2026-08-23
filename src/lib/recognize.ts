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
  compactness,
  dist,
  pathLength,
  pointInRect,
  signedArea,
  simplify,
  smooth,
  strokeCrossesRect,
  totalTurning,
  type Pt,
  type Rect,
} from "./geometry";
import { nearestSide } from "./geometry";
import { edgeCurve, nearestSide as sideFacing, sampleCurve } from "./geometry";
import type { CanvasEdge, CanvasNode, Side } from "./jsoncanvas";

export const RECOGNIZER = {
  /** Below this path length a stroke is a dab, not a mark. */
  tapMaxLength: 12,
  /** How close to a node counts as "on" it, for starting/ending a stroke. */
  nodeHitPadding: 8,
  /** A loop's endpoints must land this close, relative to its own size. */
  loopClosureRatio: 0.5,
  /** ...or it may stay open, if it swept most of the way around. */
  loopMinTurning: 1.3 * Math.PI,
  /** Enclosed area below this is a squiggle, not a shape. */
  loopMinArea: 900,
  /** Scribbles cover far more distance than their bounding box diagonal. */
  scribbleMinLengthRatio: 2.2,
  /**
   * ...but they also enclose almost nothing. Hand tremor adds corners without
   * adding enclosed area, so this is what keeps a shaky circle out of the
   * scribble branch. A hand-drawn circle sits near 0.8; a scribble near 0.02.
   */
  scribbleMaxCompactness: 0.2,
  /** A loop has to actually enclose its area, not merely double back. */
  loopMinCompactness: 0.15,
  /** A branch flick must travel mostly in one direction, not curl back. */
  branchMinDirectness: 0.55,
  /** How close a stroke must pass to a connector to count as crossing it. */
  edgeHitDistance: 14,
  /** New nodes never come out smaller than this. */
  minNodeSize: { width: 120, height: 60 },
  /** Simplification tolerance before shape analysis. */
  simplifyTolerance: 3.5,
} as const;

export type Gesture =
  | { kind: "tap"; at: { x: number; y: number }; nodeId: string | null }
  | { kind: "scribble"; nodeIds: string[]; edgeIds: string[] }
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

/** Every connector the stroke passes close to. */
function edgesCrossedBy(raw: Pt[], nodes: CanvasNode[], edges: CanvasEdge[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hit: string[] = [];

  for (const edge of edges) {
    const from = byId.get(edge.fromNode);
    const to = byId.get(edge.toNode);
    if (!from || !to) continue;

    const fromRect = nodeRect(from);
    const toRect = nodeRect(to);
    const curve = edgeCurve(
      fromRect,
      edge.fromSide ?? sideFacing(fromRect, rectMiddle(toRect)),
      toRect,
      edge.toSide ?? sideFacing(toRect, rectMiddle(fromRect)),
    );
    const along = sampleCurve(curve);

    const near = raw.some((p) =>
      along.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < RECOGNIZER.edgeHitDistance),
    );
    if (near) hit.push(edge.id);
  }
  return hit;
}

function rectMiddle(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function recognize(raw: Pt[], nodes: CanvasNode[], edges: CanvasEdge[] = []): Gesture {
  if (raw.length === 0) return { kind: "unknown" };

  const first = raw[0];
  const last = raw[raw.length - 1];
  const length = pathLength(raw);

  // 1. Tap — too little travel to be a shape.
  if (length < RECOGNIZER.tapMaxLength) {
    const hit = nodeAt(nodes, first, RECOGNIZER.nodeHitPadding);
    return { kind: "tap", at: { x: first.x, y: first.y }, nodeId: hit?.id ?? null };
  }

  // Smooth before analysing shape. The Pencil records hand tremor faithfully,
  // and unsmoothed tremor produced a dozen-plus fake direction reversals on an
  // ordinary hand-drawn circle — which read as a scribble and silently did
  // nothing. Ink still comes from the raw points; only recognition sees these.
  const pts = simplify(smooth(raw), RECOGNIZER.simplifyTolerance);
  const bounds = bbox(raw);
  const diagonal = Math.hypot(bounds.width, bounds.height) || 1;
  const area = Math.abs(signedArea(pts));
  const shapeCompactness = compactness(area, length);

  // 2. Scribble — covers a lot of ground while enclosing almost nothing.
  //
  // This used to count sharp corners, which was wrong twice over: hand tremor
  // adds corners to a circle, and smoothing removes them from a genuine
  // zigzag, so the same scribble registered 6 corners at one size and 0 at
  // another. Compactness has neither problem — it is scale-invariant, and it
  // measures the thing that actually distinguishes the two gestures. A
  // hand-drawn circle scores around 0.8; a scribble scores 0.00.
  //
  // The length ratio is what protects connectors: a stroke between two cards
  // also encloses nothing, but it travels in one direction rather than
  // doubling back over its own bounding box.
  if (
    length / diagonal >= RECOGNIZER.scribbleMinLengthRatio &&
    shapeCompactness < RECOGNIZER.scribbleMaxCompactness
  ) {
    const hitIds = nodes.filter((n) => strokeCrossesRect(raw, nodeRect(n))).map((n) => n.id);
    // Connectors count too. Requiring a card here meant scribbling out a link
    // on its own did nothing at all, leaving no way to remove one without
    // deleting a card.
    const hitEdges = edgesCrossedBy(raw, nodes, edges);
    // A scribble over genuinely empty canvas still falls through, so it is
    // judged on its shape like any other stroke rather than vanishing.
    if (hitIds.length > 0 || hitEdges.length > 0) {
      return { kind: "scribble", nodeIds: hitIds, edgeIds: hitEdges };
    }
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

  // 5. Loop — encloses real area, and either closes up or sweeps most of the
  // way around. The turning test is what lets a circle with an open gap still
  // count, which is how people actually draw them in a hurry.
  const closure = dist(first, last) / diagonal;
  const turning = totalTurning(pts);
  const wentAround = closure <= RECOGNIZER.loopClosureRatio || turning >= RECOGNIZER.loopMinTurning;
  if (wentAround && area >= RECOGNIZER.loopMinArea && shapeCompactness >= RECOGNIZER.loopMinCompactness) {
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
