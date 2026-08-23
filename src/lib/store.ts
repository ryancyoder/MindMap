// Local-first persistence. IndexedDB holds the canvas library; localStorage
// remembers which one was open. Nothing leaves the device in v1 — the .canvas
// file itself is the bridge to everything else.

import { emptyCanvas, type Canvas } from "./jsoncanvas";

const DB_NAME = "MindMapDB";
const DB_VERSION = 1;
const STORE = "canvases";
const LAST_OPENED_KEY = "mindmap_last_opened";

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open MindMapDB."));
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const req = run(transaction.objectStore(STORE));
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
