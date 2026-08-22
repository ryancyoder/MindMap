// Undo/redo by snapshot.
//
// A diff-based command stack would use less memory, but canvases are small
// (a large hand-drawn map is a few hundred KB of JSON) and snapshots cannot
// drift out of sync with the document the way inverse-operations can. For a
// drawing app where a misread gesture is the most likely reason to undo, being
// certain the previous state comes back exactly matters more than the bytes.

import type { Canvas } from "./jsoncanvas";

const LIMIT = 60;

export type History = {
  past: string[];
  present: string;
  future: string[];
};

export function initHistory(doc: Canvas): History {
  return { past: [], present: JSON.stringify(doc), future: [] };
}

/** Record a new state. No-ops when nothing actually changed. */
export function commit(history: History, doc: Canvas): History {
  const next = JSON.stringify(doc);
  if (next === history.present) return history;
  const past = [...history.past, history.present].slice(-LIMIT);
  return { past, present: next, future: [] };
}

export function canUndo(history: History): boolean {
  return history.past.length > 0;
}

export function canRedo(history: History): boolean {
  return history.future.length > 0;
}

export function undo(history: History): { history: History; doc: Canvas } | null {
  if (!canUndo(history)) return null;
  const past = history.past.slice(0, -1);
  const present = history.past[history.past.length - 1];
  return {
    history: { past, present, future: [history.present, ...history.future].slice(0, LIMIT) },
    doc: JSON.parse(present) as Canvas,
  };
}

export function redo(history: History): { history: History; doc: Canvas } | null {
  if (!canRedo(history)) return null;
  const [present, ...future] = history.future;
  return {
    history: { past: [...history.past, history.present].slice(-LIMIT), present, future },
    doc: JSON.parse(present) as Canvas,
  };
}
