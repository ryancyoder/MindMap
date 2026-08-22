"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  anchorPoint,
  dist,
  nearestSide,
  pathLength,
  rectCenter,
  sideNormal,
  type Pt,
  type Rect,
} from "@/lib/geometry";
import {
  emptyCanvas,
  makeId,
  nodeDisplayText,
  parseCanvas,
  PRESET_COLOR_IDS,
  resolveColor,
  serializeCanvas,
  type Canvas,
  type CanvasEdge,
  type CanvasNode,
  type Side,
  type TextNode,
} from "@/lib/jsoncanvas";
import { nodeAt, nodeRect, recognize, RECOGNIZER } from "@/lib/recognize";
import {
  canRedo,
  canUndo,
  commit,
  initHistory,
  redo,
  undo,
  type History,
} from "@/lib/history";
import {
  deleteCanvas,
  getCanvas,
  listCanvases,
  newRecord,
  putCanvas,
  recallLastOpened,
  rememberLastOpened,
  type CanvasRecord,
} from "@/lib/store";
import styles from "./canvas.module.css";

type Transform = { x: number; y: number; k: number };

/**
 * How long touch input stays locked out after the pen lifts. A resting palm
 * lands as a touch pointer a beat before or after the nib does; without this
 * window the map pans itself mid-sentence.
 */
const PEN_PRIORITY_MS = 400;

/**
 * Contacts wider than this are a palm rather than a fingertip — but only while
 * the pen is in play. iOS reports an ordinary fingertip on an iPad at roughly
 * 40-60px, so applying this to every touch rejected normal navigation: pinch
 * and pan simply did nothing. Size is now only consulted just after pen
 * contact, which is the only time a palm is plausibly on the glass.
 */
const PALM_CONTACT_PX = 60;

/** How long after pen contact a wide touch is still treated as a palm. */
const PALM_WINDOW_MS = 2500;

/** Card padding and border, mirrored from canvas.module.css so measurement
 *  matches what actually renders. Getting the border wrong here loses a whole
 *  wrapped line on a narrow card. */
const CARD_PADDING_X = 12;
const CARD_PADDING_Y = 10;
const CARD_BORDER = 1.5;

/** Nothing may be resized smaller than this and stay usable. */
const MIN_CARD = { width: 90, height: 48 };

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;

type ActiveStroke = { pointerId: number; points: Pt[] };
type Toast = { id: number; message: string };

export default function CanvasClient() {
  const [doc, setDoc] = useState<Canvas>(emptyCanvas);
  const [record, setRecord] = useState<CanvasRecord | null>(null);
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [history, setHistory] = useState<History>(() => initHistory(emptyCanvas()));
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [ready, setReady] = useState(false);
  // Bumped when a finger-drag ends, so the move lands on the undo stack as one
  // entry instead of one per frame.
  const [dragCommit, setDragCommit] = useState(0);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [library, setLibrary] = useState<CanvasRecord[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const inkRef = useRef<HTMLCanvasElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Live pointer bookkeeping. Refs, not state: these change at 240Hz and must
  // never trigger a React render.
  const strokeRef = useRef<ActiveStroke | null>(null);
  const touchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const penUntilRef = useRef(0);
  const pinchRef = useRef<{ dist: number; cx: number; cy: number } | null>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const nodeDragRef = useRef<{
    pointerId: number;
    nodeId: string;
    lastWorld: { x: number; y: number };
    moved: boolean;
  } | null>(null);
  const lastPenAtRef = useRef(0);
  const resizeRef = useRef<{
    pointerId: number;
    nodeId: string;
    startWorld: { x: number; y: number };
    origWidth: number;
    origHeight: number;
  } | null>(null);
  const transformRef = useRef(transform);
  const docRef = useRef(doc);
  const editingIdRef = useRef<string | null>(null);
  const editingTextRef = useRef("");

  // Mirror the state that pointer handlers read. Handlers fire between renders
  // and must see the latest values, but they run at pointer rate and must not
  // be rebuilt on every change — so they read refs rather than close over state.
  // Writing these during render is what the React 19 rules forbid, hence the
  // effect: it runs after every commit, before any event can observe it.
  useEffect(() => {
    transformRef.current = transform;
    docRef.current = doc;
    editingIdRef.current = editingId;
    editingTextRef.current = editingText;
  });

  const showToast = useCallback((message: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 2600);
  }, []);

  // ─── LOAD / SAVE ──────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lastId = recallLastOpened();
      let loaded: CanvasRecord | undefined;
      if (lastId) {
        try {
          loaded = await getCanvas(lastId);
        } catch {
          // A corrupt or blocked IndexedDB shouldn't stop the editor opening.
        }
      }
      if (cancelled) return;
      const next = loaded ?? newRecord("Untitled map");
      setRecord(next);
      setDoc(next.doc);
      setHistory(initHistory(next.doc));
      rememberLastOpened(next.id);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Autosave, debounced. Every gesture writes; the user never presses save.
  useEffect(() => {
    if (!ready || !record) return;
    const handle = setTimeout(() => {
      void putCanvas({ ...record, doc, updated: new Date().toISOString() }).catch(() => {
        showToast("Could not save locally.");
      });
    }, 600);
    return () => clearTimeout(handle);
  }, [doc, record, ready, showToast]);

  // A finished finger-drag lands on the undo stack here rather than inside a
  // state updater, which would double-fire under StrictMode.
  useEffect(() => {
    if (dragCommit === 0) return;
    setHistory((h) => commit(h, docRef.current));
  }, [dragCommit]);

  /** Apply a document change and push it onto the undo stack. */
  const applyDoc = useCallback((next: Canvas) => {
    setDoc(next);
    setHistory((h) => commit(h, next));
  }, []);

  // ─── COORDINATES ──────────────────────────────────────────────────────────

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const surface = surfaceRef.current;
    const t = transformRef.current;
    if (!surface) return { x: 0, y: 0 };
    const rect = surface.getBoundingClientRect();
    return {
      x: (clientX - rect.left - t.x) / t.k,
      y: (clientY - rect.top - t.y) / t.k,
    };
  }, []);

  // ─── INK LAYER ────────────────────────────────────────────────────────────

  const resizeInk = useCallback(() => {
    const canvas = inkRef.current;
    const surface = surfaceRef.current;
    if (!canvas || !surface) return;
    const rect = surface.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
  }, []);

  useEffect(() => {
    resizeInk();
    window.addEventListener("resize", resizeInk);
    return () => window.removeEventListener("resize", resizeInk);
  }, [resizeInk]);

  /** Redraw the wet stroke. Screen space, cleared and repainted each frame. */
  const drawInk = useCallback(() => {
    const canvas = inkRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    const stroke = strokeRef.current;
    if (!stroke || stroke.points.length < 2) return;

    const t = transformRef.current;
    const style = getComputedStyle(document.documentElement);
    ctx.strokeStyle = style.getPropertyValue("--ink").trim() || "#000";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Width tracks pressure, so the ink looks like ink. Apple Pencil reports
    // real pressure; a finger or mouse reports 0.5 and gets a uniform line.
    for (let i = 1; i < stroke.points.length; i++) {
      const a = stroke.points[i - 1];
      const b = stroke.points[i];
      ctx.beginPath();
      ctx.lineWidth = Math.max(1.2, 1 + b.p * 3.5) * Math.min(t.k, 1.5);
      ctx.moveTo(a.x * t.k + t.x, a.y * t.k + t.y);
      ctx.lineTo(b.x * t.k + t.x, b.y * t.k + t.y);
      ctx.stroke();
    }
  }, []);

  const clearInk = useCallback(() => {
    const canvas = inkRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  }, []);

  // ─── GESTURE APPLICATION ──────────────────────────────────────────────────

  const createTextNode = useCallback((rect: Rect): TextNode => {
    return {
      id: makeId(),
      type: "text",
      text: "",
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }, []);

  const beginEditing = useCallback((node: CanvasNode) => {
    setSelectedId(node.id);
    setEditingId(node.id);
    setEditingText(node.type === "text" ? node.text : nodeDisplayText(node));
  }, []);

  const applyGesture = useCallback(
    (points: Pt[]) => {
      const current = docRef.current;
      const gesture = recognize(points, current.nodes);

      switch (gesture.kind) {
        case "tap": {
          if (!gesture.nodeId) {
            setSelectedId(null);
            return;
          }
          const node = current.nodes.find((n) => n.id === gesture.nodeId);
          if (!node) return;
          // Tapping the node you already have selected opens it for text.
          if (selectedId === node.id) beginEditing(node);
          else setSelectedId(node.id);
          return;
        }

        case "loop": {
          const node = createTextNode(gesture.rect);
          applyDoc({ ...current, nodes: [...current.nodes, node] });
          beginEditing(node);
          return;
        }

        case "branch": {
          const node = createTextNode(gesture.rect);
          const toSide = oppositeSide(gesture.fromSide);
          const edge: CanvasEdge = {
            id: makeId(),
            fromNode: gesture.fromId,
            fromSide: gesture.fromSide,
            toNode: node.id,
            toSide,
          };
          applyDoc({ nodes: [...current.nodes, node], edges: [...current.edges, edge] });
          beginEditing(node);
          return;
        }

        case "connect": {
          const duplicate = current.edges.some(
            (e) => e.fromNode === gesture.fromId && e.toNode === gesture.toId,
          );
          if (duplicate) {
            showToast("Those are already connected.");
            return;
          }
          const edge: CanvasEdge = {
            id: makeId(),
            fromNode: gesture.fromId,
            fromSide: gesture.fromSide,
            toNode: gesture.toId,
            toSide: gesture.toSide,
          };
          applyDoc({ ...current, edges: [...current.edges, edge] });
          return;
        }

        case "scribble": {
          const nodeIds = new Set(gesture.nodeIds);
          const crossedEdges = current.edges.filter((e) =>
            edgeCrossedByStroke(e, current, gesture.strokePoints),
          );
          if (nodeIds.size === 0 && crossedEdges.length === 0) return;

          const removedEdgeIds = new Set(crossedEdges.map((e) => e.id));
          const nodes = current.nodes.filter((n) => !nodeIds.has(n.id));
          const edges = current.edges.filter(
            (e) =>
              !removedEdgeIds.has(e.id) && !nodeIds.has(e.fromNode) && !nodeIds.has(e.toNode),
          );
          applyDoc({ nodes, edges });
          if (selectedId && nodeIds.has(selectedId)) setSelectedId(null);
          const parts: string[] = [];
          if (nodeIds.size) parts.push(`${nodeIds.size} card${nodeIds.size > 1 ? "s" : ""}`);
          if (removedEdgeIds.size) {
            parts.push(`${removedEdgeIds.size} link${removedEdgeIds.size > 1 ? "s" : ""}`);
          }
          showToast(`Deleted ${parts.join(" and ")}.`);
          return;
        }

        case "unknown": {
          // Never fail silently on a deliberate stroke. A miss the user can see
          // is a recognizer to tune; a miss they cannot see is a dead app.
          // Short accidental drags stay quiet, so this does not nag.
          const length = pathLength(points);
          if (length > RECOGNIZER.tapMaxLength * 4) {
            showToast("Didn't catch that — try closing the circle.");
          }
          return;
        }
      }
    },
    [applyDoc, beginEditing, createTextNode, selectedId, showToast],
  );

  // ─── TEXT EDITING ─────────────────────────────────────────────────────────
  //
  // A real <textarea> over the node, which is what makes iPadOS Scribble work:
  // handwriting goes straight into the field, no keyboard, no custom recognizer.

  const commitEditing = useCallback(() => {
    const id = editingIdRef.current;
    if (!id) return;
    setEditingId(null);

    const current = docRef.current;
    const node = current.nodes.find((n) => n.id === id);
    if (!node || node.type !== "text") return;

    const trimmed = editingTextRef.current.trim();
    if (node.text === trimmed) return;

    // Grow the card to fit what was written. Growing only, never shrinking, so
    // a card you deliberately made bigger stays that way.
    const needed = measureTextHeight(trimmed, node.width);
    const height = Math.max(node.height, needed);

    const nodes = current.nodes.map((n) =>
      n.id === id ? ({ ...n, text: trimmed, height } as CanvasNode) : n,
    );
    applyDoc({ ...current, nodes });
  }, [applyDoc]);

  // ─── POINTER ROUTING ──────────────────────────────────────────────────────
  //
  // Pen draws. Touch navigates. That single split is what makes palm rejection
  // free: a palm can only ever pan, and pen priority stops even that.

  const isPenPriority = () => performance.now() < penUntilRef.current;

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.closest(`.${styles.nodeEditor}`) || target.closest(`.${styles.chrome}`)) return;

      // The resize grip is the one place where pen and finger do the same
      // thing, so it is checked before either input branch.
      const grip = target.closest<HTMLElement>("[data-resize-handle]");
      if (grip) {
        const nodeId = grip.dataset.resizeHandle;
        const node = nodeId ? docRef.current.nodes.find((n) => n.id === nodeId) : undefined;
        if (node) {
          resizeRef.current = {
            pointerId: e.pointerId,
            nodeId: node.id,
            startWorld: toWorld(e.clientX, e.clientY),
            origWidth: node.width,
            origHeight: node.height,
          };
          return;
        }
      }

      if (e.pointerType === "touch") {
        if (isPenPriority()) return;
        // Only treat a wide contact as a palm while the pen is actually in use.
        const palmPlausible = performance.now() - lastPenAtRef.current < PALM_WINDOW_MS;
        if (palmPlausible && (e.width > PALM_CONTACT_PX || e.height > PALM_CONTACT_PX)) return;

        touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const touches = [...touchesRef.current.values()];
        if (touches.length === 1) {
          pinchRef.current = null;
          // One finger on a card moves the card; one finger on empty canvas
          // moves the canvas. The pen never does either — it draws.
          const world = toWorld(e.clientX, e.clientY);
          const hit = nodeAt(docRef.current.nodes, world);
          if (hit) {
            nodeDragRef.current = { pointerId: e.pointerId, nodeId: hit.id, lastWorld: world, moved: false };
            panRef.current = null;
          } else {
            nodeDragRef.current = null;
            panRef.current = { x: e.clientX, y: e.clientY };
          }
        } else if (touches.length === 2) {
          // A second finger means zoom. Leave the card wherever it got to.
          nodeDragRef.current = null;
          panRef.current = null;
          pinchRef.current = {
            dist: dist(touches[0], touches[1]),
            cx: (touches[0].x + touches[1].x) / 2,
            cy: (touches[0].y + touches[1].y) / 2,
          };
        }
        return;
      }

      // Pen and mouse both draw, so the gestures are testable without an iPad.
      penUntilRef.current = performance.now() + PEN_PRIORITY_MS;
      if (e.pointerType === "pen") lastPenAtRef.current = performance.now();
      touchesRef.current.clear();
      panRef.current = null;
      pinchRef.current = null;

      if (editingId) commitEditing();

      const world = toWorld(e.clientX, e.clientY);
      strokeRef.current = {
        pointerId: e.pointerId,
        points: [{ x: world.x, y: world.y, p: e.pressure || 0.5, t: performance.now() }],
      };
      // Capture keeps moves coming if the stroke wanders off the surface, but
      // it throws for a pointer the browser no longer considers active. The
      // stroke is already recorded above, so failing here must not take the
      // handler down with it.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Non-fatal: window-level events still complete the stroke.
      }
    },
    [commitEditing, editingId, toWorld],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const resize = resizeRef.current;
      if (resize && resize.pointerId === e.pointerId) {
        const world = toWorld(e.clientX, e.clientY);
        const width = Math.max(MIN_CARD.width, resize.origWidth + (world.x - resize.startWorld.x));
        const height = Math.max(MIN_CARD.height, resize.origHeight + (world.y - resize.startWorld.y));
        setDoc((doc0) => ({
          ...doc0,
          nodes: doc0.nodes.map((n) =>
            n.id === resize.nodeId ? ({ ...n, width, height } as CanvasNode) : n,
          ),
        }));
        return;
      }

      if (e.pointerType === "touch") {
        if (isPenPriority()) return;
        if (!touchesRef.current.has(e.pointerId)) return;
        touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const touches = [...touchesRef.current.values()];

        const drag = nodeDragRef.current;
        if (touches.length === 1 && drag && drag.pointerId === e.pointerId) {
          const world = toWorld(e.clientX, e.clientY);
          const dx = world.x - drag.lastWorld.x;
          const dy = world.y - drag.lastWorld.y;
          drag.lastWorld = world;
          drag.moved = true;
          // Move live without touching history; the whole drag becomes one
          // undo entry when the finger lifts.
          setDoc((d) => ({
            ...d,
            nodes: d.nodes.map((n) =>
              n.id === drag.nodeId ? ({ ...n, x: n.x + dx, y: n.y + dy } as CanvasNode) : n,
            ),
          }));
          return;
        }

        if (touches.length === 1 && panRef.current) {
          const dx = e.clientX - panRef.current.x;
          const dy = e.clientY - panRef.current.y;
          panRef.current = { x: e.clientX, y: e.clientY };
          setTransform((t) => ({ ...t, x: t.x + dx, y: t.y + dy }));
        } else if (touches.length === 2 && pinchRef.current) {
          const nextDist = dist(touches[0], touches[1]);
          const cx = (touches[0].x + touches[1].x) / 2;
          const cy = (touches[0].y + touches[1].y) / 2;
          const prev = pinchRef.current;
          const scale = nextDist / (prev.dist || nextDist);
          pinchRef.current = { dist: nextDist, cx, cy };

          setTransform((t) => {
            const k = clamp(t.k * scale, MIN_ZOOM, MAX_ZOOM);
            const surface = surfaceRef.current;
            if (!surface) return t;
            const rect = surface.getBoundingClientRect();
            const px = cx - rect.left;
            const py = cy - rect.top;
            // Keep the point between the fingers pinned while scaling, and
            // carry the midpoint drift so pinch and pan work as one gesture.
            const ratio = k / t.k;
            return {
              k,
              x: px - (px - t.x) * ratio + (cx - prev.cx),
              y: py - (py - t.y) * ratio + (cy - prev.cy),
            };
          });
        }
        return;
      }

      const stroke = strokeRef.current;
      if (!stroke || stroke.pointerId !== e.pointerId) return;
      penUntilRef.current = performance.now() + PEN_PRIORITY_MS;

      // Coalesced events recover the full ~240Hz Pencil sample rate that the
      // browser batched into this one frame; without them, fast strokes come
      // back as polygons and the recognizer misreads their shape.
      //
      // The method existing does NOT mean it returns anything: Safari hands
      // back an empty array in cases where Chromium fills it in, and so do
      // synthetic events. Trusting it blindly captured zero points, which made
      // every stroke collapse to a single-point "tap" and the app look dead.
      // Always fall back to the event itself — a lower sample rate is a
      // degraded stroke; an empty list is no stroke at all.
      const coalesced =
        typeof e.nativeEvent.getCoalescedEvents === "function"
          ? e.nativeEvent.getCoalescedEvents()
          : [];
      const events = coalesced.length > 0 ? coalesced : [e.nativeEvent];

      for (const ev of events) {
        const world = toWorld(ev.clientX, ev.clientY);
        stroke.points.push({ x: world.x, y: world.y, p: ev.pressure || 0.5, t: performance.now() });
      }
      drawInk();
    },
    [drawInk, toWorld],
  );

  const endTouch = useCallback((pointerId: number) => {
    const drag = nodeDragRef.current;
    if (drag && drag.pointerId === pointerId) {
      nodeDragRef.current = null;
      if (drag.moved) {
        // Snap to whole pixels, since the format stores integers anyway.
        setDoc((d) => ({
          ...d,
          nodes: d.nodes.map((n) =>
            n.id === drag.nodeId
              ? ({ ...n, x: Math.round(n.x), y: Math.round(n.y) } as CanvasNode)
              : n,
          ),
        }));
        setDragCommit((t) => t + 1);
      } else {
        // A finger that didn't travel is a tap: select the card.
        setSelectedId(drag.nodeId);
      }
    }
    touchesRef.current.delete(pointerId);
    if (touchesRef.current.size < 2) pinchRef.current = null;
    if (touchesRef.current.size === 1) {
      const [only] = [...touchesRef.current.values()];
      panRef.current = { x: only.x, y: only.y };
    }
    if (touchesRef.current.size === 0) panRef.current = null;
  }, []);

  /** Round a finished resize and put it on the undo stack as one entry. */
  const finishResize = useCallback((pointerId: number): boolean => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== pointerId) return false;
    resizeRef.current = null;
    setDoc((doc0) => ({
      ...doc0,
      nodes: doc0.nodes.map((n) =>
        n.id === resize.nodeId
          ? ({ ...n, width: Math.round(n.width), height: Math.round(n.height) } as CanvasNode)
          : n,
      ),
    }));
    setDragCommit((t) => t + 1);
    return true;
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (finishResize(e.pointerId)) return;
      if (e.pointerType === "touch") {
        endTouch(e.pointerId);
        return;
      }
      const stroke = strokeRef.current;
      if (!stroke || stroke.pointerId !== e.pointerId) return;

      penUntilRef.current = performance.now() + PEN_PRIORITY_MS;
      strokeRef.current = null;
      clearInk();
      applyGesture(stroke.points);
    },
    [applyGesture, clearInk, endTouch, finishResize],
  );

  const onPointerCancel = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (finishResize(e.pointerId)) return;
      if (e.pointerType === "touch") {
        endTouch(e.pointerId);
        return;
      }
      strokeRef.current = null;
      clearInk();
    },
    [clearInk, endTouch, finishResize],
  );

  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    setTransform((t) => {
      // Trackpad pinch arrives as ctrl+wheel; plain wheel scrolls the canvas.
      if (!e.ctrlKey && !e.metaKey) return { ...t, x: t.x - e.deltaX, y: t.y - e.deltaY };
      const k = clamp(t.k * Math.exp(-e.deltaY / 240), MIN_ZOOM, MAX_ZOOM);
      const ratio = k / t.k;
      return { k, x: px - (px - t.x) * ratio, y: py - (py - t.y) * ratio };
    });
  }, []);

  useEffect(() => {
    if (!editingId) return;
    const handle = requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(handle);
  }, [editingId]);

  // ─── COMMANDS ─────────────────────────────────────────────────────────────

  const doUndo = useCallback(() => {
    const result = undo(history);
    if (!result) return;
    setHistory(result.history);
    setDoc(result.doc);
    setEditingId(null);
  }, [history]);

  const doRedo = useCallback(() => {
    const result = redo(history);
    if (!result) return;
    setHistory(result.history);
    setDoc(result.doc);
    setEditingId(null);
  }, [history]);

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    const current = docRef.current;
    applyDoc({
      nodes: current.nodes.filter((n) => n.id !== selectedId),
      edges: current.edges.filter((e) => e.fromNode !== selectedId && e.toNode !== selectedId),
    });
    setSelectedId(null);
    setEditingId(null);
  }, [applyDoc, selectedId]);

  const setSelectedColor = useCallback(
    (color: string | null) => {
      if (!selectedId) return;
      const current = docRef.current;
      const nodes = current.nodes.map((n) => {
        if (n.id !== selectedId) return n;
        const next = { ...n } as CanvasNode;
        if (color) next.color = color;
        else delete next.color;
        return next;
      });
      applyDoc({ ...current, nodes });
    },
    [applyDoc, selectedId],
  );

  const zoomToFit = useCallback(() => {
    const surface = surfaceRef.current;
    const nodes = docRef.current.nodes;
    if (!surface || nodes.length === 0) {
      setTransform({ x: 0, y: 0, k: 1 });
      return;
    }
    const rect = surface.getBoundingClientRect();
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + n.width));
    const maxY = Math.max(...nodes.map((n) => n.y + n.height));
    const pad = 80;
    const k = clamp(
      Math.min(rect.width / (maxX - minX + pad * 2), rect.height / (maxY - minY + pad * 2)),
      MIN_ZOOM,
      1.5,
    );
    setTransform({
      k,
      x: rect.width / 2 - ((minX + maxX) / 2) * k,
      y: rect.height / 2 - ((minY + maxY) / 2) * k,
    });
  }, []);

  // ─── FILE I/O ─────────────────────────────────────────────────────────────

  const fileInputRef = useRef<HTMLInputElement>(null);

  const openFile = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const { canvas, warnings } = parseCanvas(text);
        const name = file.name.replace(/\.canvas$/i, "") || "Untitled map";
        const next = newRecord(name, canvas);
        setRecord(next);
        setDoc(canvas);
        setHistory(initHistory(canvas));
        setSelectedId(null);
        setEditingId(null);
        rememberLastOpened(next.id);
        await putCanvas(next);
        if (warnings.length) showToast(`Opened with ${warnings.length} warning(s). ${warnings[0]}`);
        else showToast(`Opened ${file.name}`);
        requestAnimationFrame(zoomToFit);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Could not open that file.");
      }
    },
    [showToast, zoomToFit],
  );

  const saveFile = useCallback(() => {
    const text = serializeCanvas(docRef.current);
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${record?.name || "mindmap"}.canvas`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [record]);

  // ─── CANVAS LIBRARY ───────────────────────────────────────────────────────
  //
  // Autosave is debounced, so anything that leaves the current canvas has to
  // flush first. Without this, switching maps within a second of an edit lost
  // that edit — the exact failure a library is supposed to prevent.
  const flushSave = useCallback(async () => {
    if (!record) return;
    await putCanvas({ ...record, doc: docRef.current, updated: new Date().toISOString() }).catch(
      () => showToast("Could not save locally."),
    );
  }, [record, showToast]);

  const refreshLibrary = useCallback(async () => {
    try {
      setLibrary(await listCanvases());
    } catch {
      showToast("Could not read the map library.");
    }
  }, [showToast]);

  const openLibrary = useCallback(async () => {
    await flushSave();
    await refreshLibrary();
    setRenamingId(null);
    setConfirmDeleteId(null);
    setLibraryOpen(true);
  }, [flushSave, refreshLibrary]);

  /** Make `next` the open canvas. Callers must have flushed the current one. */
  const adopt = useCallback((next: CanvasRecord) => {
    setRecord(next);
    setDoc(next.doc);
    setHistory(initHistory(next.doc));
    setSelectedId(null);
    setEditingId(null);
    rememberLastOpened(next.id);
  }, []);

  const switchTo = useCallback(
    async (id: string) => {
      await flushSave();
      const next = await getCanvas(id);
      if (!next) {
        showToast("That map is no longer there.");
        await refreshLibrary();
        return;
      }
      adopt(next);
      setLibraryOpen(false);
      requestAnimationFrame(zoomToFit);
    },
    [adopt, flushSave, refreshLibrary, showToast, zoomToFit],
  );

  const removeCanvas = useCallback(
    async (id: string) => {
      await deleteCanvas(id);
      const remaining = await listCanvases();
      setLibrary(remaining);
      setConfirmDeleteId(null);

      // Deleting the open map has to leave something open.
      if (record?.id === id) {
        const next = remaining[0] ?? newRecord("Untitled map");
        if (!remaining.length) await putCanvas(next);
        adopt(next);
        requestAnimationFrame(zoomToFit);
      }
      showToast("Map deleted.");
    },
    [adopt, record, showToast, zoomToFit],
  );

  const commitRename = useCallback(async () => {
    const id = renamingId;
    if (!id) return;
    const name = renameText.trim() || "Untitled map";
    const target = await getCanvas(id);
    if (target) await putCanvas({ ...target, name });
    if (record?.id === id) setRecord((r) => (r ? { ...r, name } : r));
    setRenamingId(null);
    await refreshLibrary();
  }, [record, refreshLibrary, renameText, renamingId]);

  const newCanvas = useCallback(async () => {
    // Flush first: "New" used to walk away from unsaved edits, and with no
    // library to find the old map in, that read as losing the work.
    await flushSave();
    const next = newRecord("Untitled map");
    await putCanvas(next);
    adopt(next);
    setTransform({ x: 0, y: 0, k: 1 });
    setLibraryOpen(false);
    await refreshLibrary();
  }, [adopt, flushSave, refreshLibrary]);

  // ─── KEYBOARD ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === "TEXTAREA" || target?.tagName === "INPUT";

      if (typing) {
        if (e.key === "Escape") {
          e.preventDefault();
          commitEditing();
        }
        // Cmd/Ctrl+Enter finishes a card without reaching for the mouse.
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commitEditing();
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        if (selectedId) {
          e.preventDefault();
          deleteSelected();
        }
        return;
      }
      if (e.key === "Escape") setSelectedId(null);
      if (e.key === "0" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        zoomToFit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commitEditing, deleteSelected, doRedo, doUndo, selectedId, zoomToFit]);

  // ─── RENDER ───────────────────────────────────────────────────────────────

  const edgePaths = useMemo(() => buildEdgePaths(doc), [doc]);
  const selectedNode = doc.nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className={styles.root}>
      <div
        ref={surfaceRef}
        className={styles.surface}
        style={{
          backgroundSize: `${28 * transform.k}px ${28 * transform.k}px`,
          backgroundPosition: `${transform.x}px ${transform.y}px`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onWheel={onWheel}
      >
        <div
          className={styles.world}
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})`,
          }}
        >
          <svg className={styles.edges} overflow="visible">
            <defs>
              <marker
                id="mm-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-strong)" />
              </marker>
            </defs>
            {edgePaths.map((edge) => (
              <path
                key={edge.id}
                data-edge-id={edge.id}
                d={edge.d}
                className={styles.edge}
                stroke={resolveColor(edge.color) ?? "var(--border-strong)"}
                markerEnd={edge.toEnd === "none" ? undefined : "url(#mm-arrow)"}
                markerStart={edge.fromEnd === "arrow" ? "url(#mm-arrow)" : undefined}
              />
            ))}
          </svg>

          {doc.nodes.map((node) => {
            const accent = resolveColor(node.color);
            const isEditing = editingId === node.id;
            return (
              <div
                key={node.id}
                data-node-id={node.id}
                className={[
                  styles.node,
                  node.type === "group" ? styles.groupNode : "",
                  selectedId === node.id ? styles.nodeSelected : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  height: node.height,
                  borderColor: accent ?? undefined,
                }}
              >
                {accent ? <span className={styles.nodeStripe} style={{ background: accent }} /> : null}
                {selectedId === node.id && !isEditing ? (
                  <span
                    className={styles.resizeHandle}
                    data-resize-handle={node.id}
                    aria-label="Resize card"
                  />
                ) : null}
                {isEditing ? (
                  <textarea
                    ref={textareaRef}
                    className={styles.nodeEditor}
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    onBlur={commitEditing}
                    placeholder="Write here…"
                  />
                ) : (
                  <div className={node.type === "group" ? styles.groupLabel : styles.nodeText}>
                    {nodeDisplayText(node) ||
                      (node.type === "group" ? null : (
                        <span className={styles.nodePlaceholder}>Empty</span>
                      ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <canvas ref={inkRef} className={styles.ink} />
      </div>

      {/* ─── CHROME ─────────────────────────────────────────────────────── */}

      <header className={`${styles.chrome} ${styles.topBar}`}>
        <input
          className={styles.title}
          value={record?.name ?? ""}
          onChange={(e) => setRecord((r) => (r ? { ...r, name: e.target.value } : r))}
          aria-label="Canvas name"
        />
        <div className={styles.topActions}>
          <button className={styles.button} onClick={() => void openLibrary()}>
            Maps
          </button>
          <button className={styles.button} onClick={() => void newCanvas()}>
            New
          </button>
          <button className={styles.button} onClick={() => fileInputRef.current?.click()}>
            Open
          </button>
          <button className={styles.button} onClick={saveFile}>
            Save .canvas
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".canvas,application/json"
          className={styles.hiddenInput}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void openFile(file);
            e.target.value = "";
          }}
        />
      </header>

      <div className={`${styles.chrome} ${styles.bottomBar}`}>
        <button className={styles.button} onClick={doUndo} disabled={!canUndo(history)}>
          Undo
        </button>
        <button className={styles.button} onClick={doRedo} disabled={!canRedo(history)}>
          Redo
        </button>
        <span className={styles.spacer} />
        <button className={styles.button} onClick={zoomToFit}>
          Fit
        </button>
        <span className={styles.zoomLabel}>{Math.round(transform.k * 100)}%</span>
      </div>

      {selectedNode ? (
        <div className={`${styles.chrome} ${styles.inspector}`}>
          <div className={styles.swatches}>
            <button
              className={`${styles.swatch} ${styles.swatchNone}`}
              onClick={() => setSelectedColor(null)}
              aria-label="Default color"
            />
            {PRESET_COLOR_IDS.map((id) => (
              <button
                key={id}
                className={styles.swatch}
                style={{ background: resolveColor(id) ?? undefined }}
                onClick={() => setSelectedColor(id)}
                aria-label={`Color ${id}`}
              />
            ))}
          </div>
          <button
            className={styles.button}
            onClick={() => {
              const node = docRef.current.nodes.find((n) => n.id === selectedId);
              if (node) beginEditing(node);
            }}
          >
            Edit
          </button>
          <button className={`${styles.button} ${styles.danger}`} onClick={deleteSelected}>
            Delete
          </button>
        </div>
      ) : null}

      {doc.nodes.length === 0 && ready ? (
        <div className={styles.emptyHint}>
          <p className={styles.emptyTitle}>Draw a circle to begin.</p>
          <ul className={styles.emptyList}>
            <li>
              <b>Circle</b> anywhere → a new card
            </li>
            <li>
              <b>Line out</b> of a card → a child card, joined
            </li>
            <li>
              <b>Line between</b> two cards → a link
            </li>
            <li>
              <b>Scribble</b> over anything → delete it
            </li>
            <li>
              <b>One finger</b> pans, <b>two</b> zoom. The pen never pans.
            </li>
          </ul>
        </div>
      ) : null}

      {libraryOpen ? (
        <div className={styles.sheetBackdrop} onClick={() => setLibraryOpen(false)}>
          <div
            className={`${styles.chrome} ${styles.sheet}`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Your maps"
          >
            <header className={styles.sheetHeader}>
              <h2 className={styles.sheetTitle}>Your maps</h2>
              <button className={styles.button} onClick={() => setLibraryOpen(false)}>
                Done
              </button>
            </header>

            <ul className={styles.mapList}>
              {library.map((item) => {
                const isCurrent = item.id === record?.id;
                const count = item.doc.nodes.length;
                return (
                  <li key={item.id} className={styles.mapRow} data-map-id={item.id}>
                    {renamingId === item.id ? (
                      <input
                        className={styles.renameInput}
                        value={renameText}
                        autoFocus
                        onChange={(e) => setRenameText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename();
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        aria-label="Map name"
                      />
                    ) : (
                      <button
                        className={styles.mapOpen}
                        onClick={() => void switchTo(item.id)}
                        disabled={isCurrent}
                      >
                        <span className={styles.mapName}>
                          {item.name}
                          {isCurrent ? <span className={styles.mapBadge}>open</span> : null}
                        </span>
                        <span className={styles.mapMeta}>
                          {count} card{count === 1 ? "" : "s"} · {relativeTime(item.updated)}
                        </span>
                      </button>
                    )}

                    <div className={styles.mapActions}>
                      {renamingId === item.id ? (
                        <button className={styles.button} onClick={() => void commitRename()}>
                          Save
                        </button>
                      ) : (
                        <button
                          className={styles.button}
                          onClick={() => {
                            setRenamingId(item.id);
                            setRenameText(item.name);
                            setConfirmDeleteId(null);
                          }}
                        >
                          Rename
                        </button>
                      )}
                      {confirmDeleteId === item.id ? (
                        <button
                          className={`${styles.button} ${styles.danger}`}
                          onClick={() => void removeCanvas(item.id)}
                        >
                          Really delete
                        </button>
                      ) : (
                        <button
                          className={`${styles.button} ${styles.danger}`}
                          onClick={() => setConfirmDeleteId(item.id)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            <footer className={styles.sheetFooter}>
              <button className={styles.button} onClick={() => void newCanvas()}>
                New map
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      <div className={styles.toasts}>
        {toasts.map((t) => (
          <div key={t.id} className={styles.toast}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

/**
 * Height a card needs to show all of its text at a given width.
 *
 * Measured in a real off-screen element rather than estimated, because line
 * wrapping depends on the actual font, and a card that clips its own text is
 * the fastest way to lose an idea you just wrote down.
 */
let measureEl: HTMLDivElement | null = null;

function measureTextHeight(text: string, width: number): number {
  if (typeof document === "undefined") return 0;
  if (!measureEl) {
    measureEl = document.createElement("div");
    measureEl.setAttribute("aria-hidden", "true");
    Object.assign(measureEl.style, {
      position: "absolute",
      left: "-99999px",
      top: "0",
      visibility: "hidden",
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      fontSize: "15px",
      lineHeight: "1.35",
      fontFamily: getComputedStyle(document.body).fontFamily,
    });
    document.body.appendChild(measureEl);
  }
  const content = width - CARD_PADDING_X * 2 - CARD_BORDER * 2;
  measureEl.style.width = `${Math.max(20, content)}px`;
  // A trailing newline needs a line box of its own, which an empty text node
  // would not produce.
  measureEl.textContent = text.length ? text : " ";
  return measureEl.offsetHeight + CARD_PADDING_Y * 2 + CARD_BORDER * 2;
}

/** "3 minutes ago" — enough to tell two maps apart at a glance. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(then).toLocaleDateString();
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function oppositeSide(side: Side): Side {
  switch (side) {
    case "top":
      return "bottom";
    case "bottom":
      return "top";
    case "left":
      return "right";
    case "right":
      return "left";
  }
}

type RenderedEdge = {
  id: string;
  d: string;
  color?: string;
  fromEnd?: string;
  toEnd?: string;
};

/**
 * Build the SVG path for each edge. Sides are honored when the file specifies
 * them and inferred from node positions when it doesn't, so canvases authored
 * elsewhere still render sensibly.
 */
function buildEdgePaths(doc: Canvas): RenderedEdge[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const out: RenderedEdge[] = [];

  for (const edge of doc.edges) {
    const from = byId.get(edge.fromNode);
    const to = byId.get(edge.toNode);
    if (!from || !to) continue;

    const fromRect = nodeRect(from);
    const toRect = nodeRect(to);
    const fromSide = edge.fromSide ?? nearestSide(fromRect, rectCenter(toRect));
    const toSide = edge.toSide ?? nearestSide(toRect, rectCenter(fromRect));

    const a = anchorPoint(fromRect, fromSide);
    const b = anchorPoint(toRect, toSide);
    const na = sideNormal(fromSide);
    const nb = sideNormal(toSide);
    const reach = Math.max(40, dist(a, b) * 0.4);

    const c1 = { x: a.x + na.x * reach, y: a.y + na.y * reach };
    const c2 = { x: b.x + nb.x * reach, y: b.y + nb.y * reach };

    out.push({
      id: edge.id,
      d: `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`,
      color: edge.color,
      fromEnd: edge.fromEnd,
      toEnd: edge.toEnd,
    });
  }

  return out;
}

/** Did a scribble cross this edge? Sampled along its straight-line span. */
function edgeCrossedByStroke(edge: CanvasEdge, doc: Canvas, points: Pt[]): boolean {
  const from = doc.nodes.find((n) => n.id === edge.fromNode);
  const to = doc.nodes.find((n) => n.id === edge.toNode);
  if (!from || !to) return false;

  const a = rectCenter(nodeRect(from));
  const b = rectCenter(nodeRect(to));

  for (const p of points) {
    const t = closestT(p, a, b);
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (Math.hypot(p.x - x, p.y - y) < RECOGNIZER.nodeHitPadding * 2) return true;
  }
  return false;
}

function closestT(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return 0;
  return clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq, 0, 1);
}
