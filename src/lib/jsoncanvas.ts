// JSON Canvas 1.0 — the open .canvas file format (https://jsoncanvas.org).
//
// This module is the only place that knows what a .canvas file looks like.
// Everything else in the app works with the types it exports.
//
// Two rules keep files round-trippable with Obsidian and other JSON Canvas
// apps, and both are load-bearing:
//
//  1. Unknown keys are preserved. The spec lets applications store their own
//     attributes; if we dropped them, opening a file here and saving it would
//     silently delete another app's data.
//  2. x / y / width / height are written as integers, because the spec types
//     them as integers. Pointer input produces floats, so we round on the way
//     out rather than trusting callers to.

export type CanvasColor = string; // "1".."6" preset, or "#RRGGBB"

/** Preset colors are named by number; exact values are ours to choose. */
export const PRESET_COLORS: Record<string, string> = {
  "1": "#e5534b", // red
  "2": "#e8912d", // orange
  "3": "#d9b026", // yellow
  "4": "#3fa662", // green
  "5": "#3aa3c4", // cyan
  "6": "#8b5cf6", // purple
};

export const PRESET_COLOR_IDS = ["1", "2", "3", "4", "5", "6"] as const;

/** Resolve a canvas color to something CSS can paint, or null for "default". */
export function resolveColor(color: CanvasColor | undefined): string | null {
  if (!color) return null;
  if (color.startsWith("#")) return color;
  return PRESET_COLORS[color] ?? null;
}

export type NodeType = "text" | "file" | "link" | "group";
export type Side = "top" | "right" | "bottom" | "left";
export type EdgeEnd = "none" | "arrow";
export type BackgroundStyle = "cover" | "ratio" | "repeat";

type UnknownKeys = Record<string, unknown>;

type NodeBase = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
};

export type TextNode = NodeBase & { type: "text"; text: string };
export type FileNode = NodeBase & { type: "file"; file: string; subpath?: string };
export type LinkNode = NodeBase & { type: "link"; url: string };
export type GroupNode = NodeBase & {
  type: "group";
  label?: string;
  background?: string;
  backgroundStyle?: BackgroundStyle;
};

export type CanvasNode = (TextNode | FileNode | LinkNode | GroupNode) & UnknownKeys;

export type CanvasEdge = {
  id: string;
  fromNode: string;
  fromSide?: Side;
  fromEnd?: EdgeEnd;
  toNode: string;
  toSide?: Side;
  toEnd?: EdgeEnd;
  color?: CanvasColor;
  label?: string;
} & UnknownKeys;

/**
 * Both arrays are optional in the spec; we normalize them to always exist.
 * Extra top-level keys ride along for the same reason node-level ones do —
 * a future spec version, or another app's metadata, must survive a round trip.
 */
export type Canvas = { nodes: CanvasNode[]; edges: CanvasEdge[] } & UnknownKeys;

export function emptyCanvas(): Canvas {
  return { nodes: [], edges: [] };
}

/** Short, collision-resistant id in the style Obsidian writes. */
export function makeId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const SIDES: Side[] = ["top", "right", "bottom", "left"];
const ENDS: EdgeEnd[] = ["none", "arrow"];
const NODE_TYPES: NodeType[] = ["text", "file", "link", "group"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Result of reading a file: the canvas, plus anything we had to skip. */
export type ParseResult = { canvas: Canvas; warnings: string[] };

/**
 * Parse .canvas text. Deliberately tolerant: a file with three good nodes and
 * one malformed one opens with three nodes and a warning, rather than failing
 * outright and stranding the user's work behind an error message.
 */
export function parseCanvas(text: string): ParseResult {
  const warnings: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(raw)) throw new Error("A .canvas file must contain a JSON object.");

  const nodes: CanvasNode[] = [];
  const seenNodeIds = new Set<string>();

  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  if (raw.nodes !== undefined && !Array.isArray(raw.nodes)) warnings.push('"nodes" was not an array; ignored.');

  for (const entry of rawNodes) {
    if (!isRecord(entry)) {
      warnings.push("Skipped a node that was not an object.");
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id : "";
    const type = entry.type;
    if (!id) {
      warnings.push("Skipped a node with no id.");
      continue;
    }
    if (seenNodeIds.has(id)) {
      warnings.push(`Skipped a duplicate node id (${id}).`);
      continue;
    }
    if (typeof type !== "string" || !NODE_TYPES.includes(type as NodeType)) {
      warnings.push(`Skipped node ${id}: unsupported type ${JSON.stringify(type)}.`);
      continue;
    }

    // Spread first so unknown keys survive, then overwrite what we validate.
    const base = {
      ...entry,
      id,
      x: num(entry.x, 0),
      y: num(entry.y, 0),
      width: Math.max(1, num(entry.width, 200)),
      height: Math.max(1, num(entry.height, 100)),
    } as Record<string, unknown>;

    if (typeof entry.color !== "string") delete base.color;

    if (type === "text") {
      base.text = typeof entry.text === "string" ? entry.text : "";
    } else if (type === "file") {
      if (typeof entry.file !== "string") {
        warnings.push(`Skipped file node ${id}: missing "file".`);
        continue;
      }
      if (typeof entry.subpath !== "string") delete base.subpath;
    } else if (type === "link") {
      if (typeof entry.url !== "string") {
        warnings.push(`Skipped link node ${id}: missing "url".`);
        continue;
      }
    } else {
      if (typeof entry.label !== "string") delete base.label;
      if (typeof entry.background !== "string") delete base.background;
      if (
        typeof entry.backgroundStyle !== "string" ||
        !["cover", "ratio", "repeat"].includes(entry.backgroundStyle)
      ) {
        delete base.backgroundStyle;
      }
    }

    seenNodeIds.add(id);
    nodes.push(base as CanvasNode);
  }

  const edges: CanvasEdge[] = [];
  const seenEdgeIds = new Set<string>();

  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  if (raw.edges !== undefined && !Array.isArray(raw.edges)) warnings.push('"edges" was not an array; ignored.');

  for (const entry of rawEdges) {
    if (!isRecord(entry)) {
      warnings.push("Skipped an edge that was not an object.");
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id : "";
    const fromNode = typeof entry.fromNode === "string" ? entry.fromNode : "";
    const toNode = typeof entry.toNode === "string" ? entry.toNode : "";
    if (!id || !fromNode || !toNode) {
      warnings.push("Skipped an edge missing id, fromNode or toNode.");
      continue;
    }
    if (seenEdgeIds.has(id)) {
      warnings.push(`Skipped a duplicate edge id (${id}).`);
      continue;
    }
    // An edge pointing at a node we dropped would render as a line to nowhere.
    if (!seenNodeIds.has(fromNode) || !seenNodeIds.has(toNode)) {
      warnings.push(`Skipped edge ${id}: it references a node that is not in the file.`);
      continue;
    }

    const edge = { ...entry, id, fromNode, toNode } as Record<string, unknown>;
    if (typeof entry.fromSide !== "string" || !SIDES.includes(entry.fromSide as Side)) delete edge.fromSide;
    if (typeof entry.toSide !== "string" || !SIDES.includes(entry.toSide as Side)) delete edge.toSide;
    if (typeof entry.fromEnd !== "string" || !ENDS.includes(entry.fromEnd as EdgeEnd)) delete edge.fromEnd;
    if (typeof entry.toEnd !== "string" || !ENDS.includes(entry.toEnd as EdgeEnd)) delete edge.toEnd;
    if (typeof entry.color !== "string") delete edge.color;
    if (typeof entry.label !== "string") delete edge.label;

    seenEdgeIds.add(id);
    edges.push(edge as CanvasEdge);
  }

  const { nodes: _ignoredNodes, edges: _ignoredEdges, ...topLevelExtras } = raw;
  void _ignoredNodes;
  void _ignoredEdges;

  return { canvas: { ...topLevelExtras, nodes, edges }, warnings };
}

/**
 * Serialize to .canvas text. Tab-indented to match what Obsidian writes, so a
 * file edited here and committed next to one edited there produces a readable
 * diff instead of a whole-file rewrite.
 */
export function serializeCanvas(canvas: Canvas): string {
  const nodes = canvas.nodes.map((n) => ({
    ...n,
    x: Math.round(n.x),
    y: Math.round(n.y),
    width: Math.round(n.width),
    height: Math.round(n.height),
  }));
  const { nodes: _ignoredNodes, edges: _ignoredEdges, ...topLevelExtras } = canvas;
  void _ignoredNodes;
  void _ignoredEdges;

  // nodes and edges lead, so files stay readable and diff cleanly against the
  // ones Obsidian writes.
  return JSON.stringify({ nodes, edges: canvas.edges, ...topLevelExtras }, null, "\t") + "\n";
}

/**
 * A card that is a doorway into another map.
 *
 * `file` holds a path, so Obsidian and anything else reading the spec see an
 * ordinary file node. The stable id lives alongside it in an extra key, which
 * survives round trips, because resolving by name alone breaks the moment two
 * maps share one or a map is renamed.
 */
export const NESTED_ID_KEY = "x-mindmap-canvas";

/** Which sub-map node each crossing edge was attached to before folding. */
export const NESTED_PORTS_KEY = "x-mindmap-ports";

export function isCanvasFile(node: CanvasNode): boolean {
  return node.type === "file" && /\.canvas$/i.test(node.file);
}

/** The library id a doorway points at, if it has one. */
export function nestedCanvasId(node: CanvasNode): string | null {
  const value = (node as Record<string, unknown>)[NESTED_ID_KEY];
  return typeof value === "string" && value ? value : null;
}

export function nestedPorts(node: CanvasNode): Record<string, string> {
  const value = (node as Record<string, unknown>)[NESTED_PORTS_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** The name shown on a doorway card, without the extension. */
export function nestedCanvasName(node: CanvasNode): string {
  if (node.type !== "file") return "";
  const base = node.file.split("/").pop() ?? node.file;
  return base.replace(/\.canvas$/i, "");
}

export function isTextNode(node: CanvasNode): node is TextNode & UnknownKeys {
  return node.type === "text";
}

/** The label we show on a node in the editor, whatever its type. */
export function nodeDisplayText(node: CanvasNode): string {
  switch (node.type) {
    case "text":
      return node.text;
    case "link":
      return node.url;
    case "file":
      return node.file.split("/").pop() ?? node.file;
    case "group":
      return node.label ?? "";
  }
}

/**
 * A picture on a card.
 *
 * The value is the id of an image held outside the document — never the image
 * itself. Two reasons, and both are load-bearing:
 *
 *  - A `.canvas` file is text a person reads and an agent edits. A few hundred
 *    kilobytes of base64 in the middle of it makes the file unreadable and the
 *    JSON sheet useless, which is the surface the whole format exists to serve.
 *  - The cloud library is normalised precisely so one card can be updated
 *    without rewriting the map. An inline photo would put the biggest value in
 *    the document into every single one of those rewrites.
 *
 * It is an extra key rather than a spec `file` node because a picture has to be
 * attachable to a card that already says something. One mechanism covers both
 * "this card is a photo" (a text node with no text yet) and "this card has a
 * photo on it", and a caption keeps working either way. A `file` node would
 * also be a lie: it names a path that is not on disk anywhere.
 *
 * The key rides on the node, so it survives everything the parser survives —
 * a round trip through Obsidian, a fold into a sub-map, an unfold that renames
 * every id.
 */
export const IMAGE_KEY = "x-mindmap-image";

/** The image a node carries, if it carries one. */
export function imageKey(node: CanvasNode): string | null {
  const value = (node as Record<string, unknown>)[IMAGE_KEY];
  return typeof value === "string" && value ? value : null;
}

/** Put a picture on a node, or take it off. Never mutates the node given. */
export function withImage(node: CanvasNode, key: string | null): CanvasNode {
  const next = { ...node } as Record<string, unknown>;
  if (key) next[IMAGE_KEY] = key;
  else delete next[IMAGE_KEY];
  return next as CanvasNode;
}
