// Local-first persistence. IndexedDB holds the canvas library and the pictures
// on its cards; localStorage remembers which one was open. Nothing leaves the
// device in v1 — the .canvas file itself is the bridge to everything else.

import { emptyCanvas, type Canvas } from "./jsoncanvas";

const DB_NAME = "MindMapDB";
const DB_VERSION = 2;
const STORE = "canvases";
/**
 * Pictures live in a store of their own, keyed by image id and NOT by map, so
 * a card keeps its photo when it is folded into a sub-map, unfolded back out,
 * or pasted somewhere else. A per-map store would strand the picture the
 * moment the card moved.
 */
const IMAGE_STORE = "images";
const LAST_OPENED_KEY = "mindmap_last_opened";

/** A picture on a card: a base64 data URL, addressed by the key the node holds. */
export type ImageRecord = {
  key: string;
  dataUrl: string;
  updated: string;
};

export type CanvasRecord = {
  id: string;
  name: string;
  doc: Canvas;
  created: string;
  updated: string;
  /** The cloud row this map is linked to, once it has been pushed. */
  cloudId?: string | null;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(IMAGE_STORE)) {
        db.createObjectStore(IMAGE_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open MindMapDB."));
  });
  return dbPromise;
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
  name: string = STORE,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(name, mode);
        const req = run(transaction.objectStore(name));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("MindMapDB request failed."));
      }),
  );
}

export async function listCanvases(): Promise<CanvasRecord[]> {
  const all = await tx<CanvasRecord[]>("readonly", (s) => s.getAll() as IDBRequest<CanvasRecord[]>);
  return all.sort((a, b) => b.updated.localeCompare(a.updated));
}

export async function getCanvas(id: string): Promise<CanvasRecord | undefined> {
  return tx<CanvasRecord | undefined>("readonly", (s) => s.get(id) as IDBRequest<CanvasRecord | undefined>);
}

export async function putCanvas(record: CanvasRecord): Promise<void> {
  await tx("readwrite", (s) => s.put(record) as IDBRequest<IDBValidKey>);
}

export async function deleteCanvas(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id) as IDBRequest<undefined>);
}

export function newRecord(name: string, doc: Canvas = emptyCanvas()): CanvasRecord {
  const now = new Date().toISOString();
  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  return { id, name, doc, created: now, updated: now };
}

// ─── PICTURES ───────────────────────────────────────────────────────────────
//
// Blobs are never deleted when a card is, because undo has to bring the picture
// back and not just the reference to it. They are small by the time they land
// here — see the size cap in lib/images.ts — and orphans are the cost of an
// undo stack that actually works.

export async function getImage(key: string): Promise<ImageRecord | undefined> {
  return tx<ImageRecord | undefined>(
    "readonly",
    (s) => s.get(key) as IDBRequest<ImageRecord | undefined>,
    IMAGE_STORE,
  );
}

export async function putImage(key: string, dataUrl: string): Promise<void> {
  const record: ImageRecord = { key, dataUrl, updated: new Date().toISOString() };
  await tx("readwrite", (s) => s.put(record) as IDBRequest<IDBValidKey>, IMAGE_STORE);
}

export function rememberLastOpened(id: string): void {
  try {
    localStorage.setItem(LAST_OPENED_KEY, id);
  } catch {
    // Private browsing can refuse writes; losing this is harmless.
  }
}

export function recallLastOpened(): string | null {
  try {
    return localStorage.getItem(LAST_OPENED_KEY);
  } catch {
    return null;
  }
}
