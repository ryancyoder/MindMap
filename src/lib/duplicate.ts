// Copying part of a map.
//
// A long press arms a copy: the drag that follows leaves the originals where
// they were and carries duplicates away instead. Three things make the copy
// worth having rather than merely present:
//
//  - Every id is fresh, because an id only has to be unique within its map and
//    a copy sharing one would be the same card twice, not two cards.
//  - Edges between copied cards come along, so duplicating a cluster
//    duplicates its shape. Edges to cards left behind do not: a copy has no
//    claim on the original's connections, and guessing which end to keep is
//    how a duplicate quietly rewires a map.
//  - Everything else is carried verbatim, unknown keys included — the same
//    guarantee parseCanvas makes about a file, applied to a copy.

import { makeId, type Canvas, type CanvasEdge, type CanvasNode } from "./jsoncanvas";

export type Duplication = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Original id -> copy id, so a caller can follow what it was dragging. */
  idMap: Map<string, string>;
};

/** Copy `ids` out of `doc`. Pure: the caller decides what to do with them. */
export function duplicateNodes(doc: Canvas, ids: Iterable<string>): Duplication {
  const chosen = new Set(ids);
  const idMap = new Map<string, string>();
  const nodes: CanvasNode[] = [];

  for (const node of doc.nodes) {
    if (!chosen.has(node.id)) continue;
    const id = makeId();
    idMap.set(node.id, id);
    nodes.push({ ...node, id });
  }

  const edges: CanvasEdge[] = [];
  for (const edge of doc.edges) {
    const fromNode = idMap.get(edge.fromNode);
    const toNode = idMap.get(edge.toNode);
    if (!fromNode || !toNode) continue;
    edges.push({ ...edge, id: makeId(), fromNode, toNode });
  }

  return { nodes, edges, idMap };
}
