// Folding part of a map into a map of its own, and unfolding it again.
//
// A big map stops being readable long before it stops being useful. Folding a
// branch into its own map leaves a single doorway card behind, so the parent
// keeps its shape while the detail survives intact one level down.
//
// The pieces that make this trustworthy rather than merely clever:
//
//  - Edges that crossed the boundary are rewired to the doorway, so nothing is
//    orphaned and the parent still reads as connected.
//  - Which sub-map card each of those edges came from is recorded on the
//    doorway, so unfolding restores the original wiring rather than guessing.
//  - Unfolding renames incoming ids, because a sub-map's ids are only unique
//    within itself and would otherwise collide on the way back in.

import {
  makeId,
  NESTED_ID_KEY,
  NESTED_PORTS_KEY,
  nestedPorts,
  type Canvas,
  type CanvasEdge,
  type CanvasNode,
} from "./jsoncanvas";

/** The doorway card's size. Wide enough to read a map name at a glance. */
const DOORWAY = { width: 240, height: 110 };

export type FoldResult = { parent: Canvas; sub: Canvas; doorwayId: string };

/**
 * Move `ids` out of `doc` into a map of their own.
 *
 * `subCanvasId` is the library id the new map will be saved under; the caller
 * owns creating that record, because this function stays pure.
 */
export function foldSelection(
  doc: Canvas,
  ids: string[],
  subCanvasId: string,
  name: string,
): FoldResult | null {
  const chosen = new Set(ids);
  const moving = doc.nodes.filter((n) => chosen.has(n.id));
  if (moving.length === 0) return null;
  // Folding everything would leave a map containing only a door into itself.
  if (moving.length === doc.nodes.length && doc.nodes.length > 0) return null;

  const inside = (id: string) => chosen.has(id);
  const internal = doc.edges.filter((e) => inside(e.fromNode) && inside(e.toNode));
  const crossing = doc.edges.filter((e) => inside(e.fromNode) !== inside(e.toNode));
  const untouched = doc.edges.filter((e) => !inside(e.fromNode) && !inside(e.toNode));

  // Put the doorway where the branch used to be, so the map keeps its shape.
  const minX = Math.min(...moving.map((n) => n.x));
  const minY = Math.min(...moving.map((n) => n.y));
  const maxX = Math.max(...moving.map((n) => n.x + n.width));
  const maxY = Math.max(...moving.map((n) => n.y + n.height));

  const doorwayId = makeId();
  const ports: Record<string, string> = {};
  for (const edge of crossing) {
    ports[edge.id] = inside(edge.fromNode) ? edge.fromNode : edge.toNode;
  }

  const doorway = {
    id: doorwayId,
    type: "file" as const,
    file: `${sanitizeName(name)}.canvas`,
    x: Math.round((minX + maxX) / 2 - DOORWAY.width / 2),
    y: Math.round((minY + maxY) / 2 - DOORWAY.height / 2),
    width: DOORWAY.width,
    height: DOORWAY.height,
    [NESTED_ID_KEY]: subCanvasId,
    [NESTED_PORTS_KEY]: ports,
  } as CanvasNode;

  // Rewire what crossed the boundary onto the doorway. Several edges can
  // collapse onto the same pair once their far ends are the same card; keeping
  // duplicates would just stack identical lines on top of each other.
  const seen = new Set<string>();
  const rewired: CanvasEdge[] = [];
  for (const edge of crossing) {
    const next: CanvasEdge = {
      ...edge,
      fromNode: inside(edge.fromNode) ? doorwayId : edge.fromNode,
      toNode: inside(edge.toNode) ? doorwayId : edge.toNode,
    };
    const key = `${next.fromNode}->${next.toNode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rewired.push(next);
  }

  return {
    doorwayId,
    parent: {
      ...doc,
      nodes: [...doc.nodes.filter((n) => !chosen.has(n.id)), doorway],
      edges: [...untouched, ...rewired],
    },
    sub: { nodes: moving, edges: internal },
  };
}

/** Bring a folded map's contents back into its parent, replacing the doorway. */
export function unfoldNested(doc: Canvas, doorway: CanvasNode, sub: Canvas): Canvas | null {
  if (sub.nodes.length === 0) return null;

  // Sub-map ids are only unique within that map, so they are renamed on the way
  // in rather than risking a collision with something already here.
  const rename = new Map<string, string>();
  for (const n of sub.nodes) rename.set(n.id, makeId());

  const minX = Math.min(...sub.nodes.map((n) => n.x));
  const minY = Math.min(...sub.nodes.map((n) => n.y));
  const maxX = Math.max(...sub.nodes.map((n) => n.x + n.width));
  const maxY = Math.max(...sub.nodes.map((n) => n.y + n.height));
  // Land the contents where the doorway stood.
  const dx = Math.round(doorway.x + doorway.width / 2 - (minX + maxX) / 2);
  const dy = Math.round(doorway.y + doorway.height / 2 - (minY + maxY) / 2);

  const incoming = sub.nodes.map(
    (n) => ({ ...n, id: rename.get(n.id)!, x: n.x + dx, y: n.y + dy }) as CanvasNode,
  );
  const incomingEdges = sub.edges.map(
    (e) =>
      ({
        ...e,
        id: makeId(),
        fromNode: rename.get(e.fromNode)!,
        toNode: rename.get(e.toNode)!,
      }) as CanvasEdge,
  );

  // Reattach the parent's edges to the cards they originally came from. The
  // ports were recorded when folding; anything missing — a card deleted inside
  // the sub-map since — falls back to its first card rather than vanishing.
  const ports = nestedPorts(doorway);
  const fallback = rename.get(sub.nodes[0].id)!;
  const reattach = (edgeId: string) => {
    const original = ports[edgeId];
    const renamed = original ? rename.get(original) : undefined;
    return renamed ?? fallback;
  };

  const parentEdges = doc.edges.map((e) => {
    if (e.fromNode !== doorway.id && e.toNode !== doorway.id) return e;
    return {
      ...e,
      fromNode: e.fromNode === doorway.id ? reattach(e.id) : e.fromNode,
      toNode: e.toNode === doorway.id ? reattach(e.id) : e.toNode,
    } as CanvasEdge;
  });

  return {
    ...doc,
    nodes: [...doc.nodes.filter((n) => n.id !== doorway.id), ...incoming],
    edges: [...parentEdges, ...incomingEdges],
  };
}

/** A file name that will survive being written to a real filesystem. */
export function sanitizeName(name: string): string {
  const cleaned = name
    .replace(/[\\/\\\\:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return cleaned || "Nested map";
}

/** A sensible name for a fold, taken from what was selected. */
export function nameForFold(nodes: CanvasNode[]): string {
  const first = nodes.find((n) => n.type === "text" && n.text.trim());
  if (first && first.type === "text") {
    return first.text.trim().split(/\s+/).slice(0, 6).join(" ");
  }
  return "Nested map";
}
