"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  dist,
  nearestSide,
  pathLength,
  rectCenter,
  type Pt,
  type Rect,
} from "@/lib/geometry";
import {
  emptyCanvas,
  makeId,
  isCanvasFile,
  nestedCanvasId,
  nestedCanvasName,
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
import { edgeCurve, rectsOverlap, snap } from "@/lib/geometry";
import {
  loadCalibration,
  normalizeAxis,
  requestTiltPermission,
  saveCalibration,
  tiltOffset,
  tiltPan,
  tiltSupported,
  type TiltCalibration,
  type TiltReading,
} from "@/lib/tilt";
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
import { foldSelection, nameForFold, sanitizeName, unfoldNested } from "@/lib/nesting";
import { rank } from "@/lib/search";
import {
  deleteCloudCanvas,
  listCloudCanvases,
  pullCanvas,
  pushCanvas,
  type CloudCanvas,
} from "@/lib/cloud";
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

/** Two taps closer together than this, and nearer than DOUBLE_TAP_PX, pair up. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 32;

/** A finger that travels further than this was a drag, not a tap. */
const TAP_SLOP_PX = 8;

/** A multi-finger tap has to be brief, or a slow pinch would count as one. */
const MULTI_TAP_MAX_MS = 320;

/** Hold a finger on a card this long to add it to (or drop it from) the selection. */
const LONG_PRESS_MS = 450;

/** Framing for a card zoomed into: breathing room, and a sane ceiling. */
const CARD_ZOOM_PAD = 90;
const CARD_ZOOM_MAX = 2.2;

/** Programmatic zooms are animated; direct manipulation never is. */
const ZOOM_ANIM_MS = 260;

/** Matches the dot grid in canvas.module.css. Change both together. */
const GRID = 28;

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;

type ActiveStroke = { pointerId: number; points: Pt[] };
type Toast = { id: number; message: string };

export default function CanvasClient() {
  const [doc, setDoc] = useState<Canvas>(emptyCanvas);
  const [record, setRecord] = useState<CanvasRecord | null>(null);
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 });
  // Selection is a set. Almost every command below acts on "the selection"
  // rather than "the selected card", which is what makes align, bulk colour
  // and multi-card drag fall out of one model instead of three special cases.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
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
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [copied, setCopied] = useState(false);
  const [cloud, setCloud] = useState<CloudCanvas[]>([]);
  const [cloudState, setCloudState] = useState<"idle" | "loading" | "off" | "error">("idle");
  const [cloudError, setCloudError] = useState("");
  const [busyCloudId, setBusyCloudId] = useState<string | null>(null);
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [penMode, setPenMode] = useState<"draw" | "select">("draw");
  const [tiltOn, setTiltOn] = useState(false);
  /** Which direction the user is currently demonstrating, if any. */
  const [tiltStep, setTiltStep] = useState<"none" | "neutral" | "right" | "down">("none");
  /** Ancestors of the map currently open, outermost first. */
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  /** Card counts for the doorways on screen, so each can show its size. */
  const [nestedSizes, setNestedSizes] = useState<Record<string, number>>({});
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpQuery, setJumpQuery] = useState("");
  const [jumpIndex, setJumpIndex] = useState(0);
  /** Search cards in every map, not just the one open. */
  const [jumpEverywhere, setJumpEverywhere] = useState(false);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const inkRef = useRef<HTMLCanvasElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Live pointer bookkeeping. Refs, not state: these change at 240Hz and must
  // never trigger a React render.
  const strokeRef = useRef<ActiveStroke | null>(null);
  const touchesRef = useRef<
    Map<number, { x: number; y: number; startX: number; startY: number }>
  >(new Map());
  /** The multi-finger gesture in progress, from first finger down to last up. */
  const multiRef = useRef<{ startedAt: number; maxFingers: number; moved: boolean } | null>(null);
  const lastMultiTapRef = useRef<{ t: number; fingers: number } | null>(null);
  // Undo and redo are declared further down but fired from a gesture handler
  // above them, so they are reached through refs rather than reordering the
  // whole file around one gesture.
  const historyRef = useRef<History>(initHistory(emptyCanvas()));
  const undoRef = useRef<() => void>(() => {});
  const redoRef = useRef<() => void>(() => {});
  const penUntilRef = useRef(0);
  const pinchRef = useRef<{ dist: number; cx: number; cy: number } | null>(null);
  const panRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const lastTapRef = useRef<{ t: number; x: number; y: number; nodeId: string | null } | null>(null);
  /** The view to return to when double-tapping away from a card. */
  const zoomBackRef = useRef<Transform | null>(null);
  const animRef = useRef<number | null>(null);
  const tiltReadingRef = useRef<TiltReading>({ beta: 0, gamma: 0 });
  const tiltFrameRef = useRef<number | null>(null);
  const tiltCalRef = useRef<TiltCalibration | null>(null);
  /** Partial calibration, filled in as each direction is demonstrated. */
  const tiltDraftRef = useRef<{ neutral: TiltReading | null }>({ neutral: null });
  const nodeDragRef = useRef<{
    pointerId: number;
    nodeId: string;
    startWorld: { x: number; y: number };
    lastScreen: { x: number; y: number };
    moved: boolean;
    /** Where every moving card started, so the drag is absolute, not cumulative. */
    origins: Map<string, { x: number; y: number }>;
  } | null>(null);
  const snapRef = useRef(false);
  const penModeRef = useRef<"draw" | "select">("draw");
  const lassoRef = useRef<{
    pointerId: number;
    start: { x: number; y: number };
    current: { x: number; y: number };
    additive: boolean;
  } | null>(null);
  const lastPenAtRef = useRef(0);
  const selectedIdsRef = useRef<string[]>([]);
  /** Modifier state captured at pointerdown, since a tap is judged on lift. */
  const gestureShiftRef = useRef(false);
  /** Long-press on a card is the finger's equivalent of shift-click. */
  const longPressRef = useRef<{ pointerId: number; timer: number } | null>(null);
  const longPressFiredRef = useRef(false);
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
    historyRef.current = history;
    selectedIdsRef.current = selectedIds;
    snapRef.current = snapToGrid;
    penModeRef.current = penMode;
  });

  const selectOnly = useCallback((id: string | null) => {
    setSelectedIds(id ? [id] : []);
  }, []);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }, []);

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
      try {
        setSnapToGrid(localStorage.getItem("mindmap_snap") === "1");
        setPenMode(localStorage.getItem("mindmap_pen_mode") === "select" ? "select" : "draw");
        setJumpEverywhere(localStorage.getItem("mindmap_jump_everywhere") === "1");
      } catch {
        // Private browsing can refuse reads; the defaults are fine.
      }
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

    const t0 = transformRef.current;
    const lasso = lassoRef.current;
    if (lasso) {
      const x = Math.min(lasso.start.x, lasso.current.x) * t0.k + t0.x;
      const y = Math.min(lasso.start.y, lasso.current.y) * t0.k + t0.y;
      const w = Math.abs(lasso.current.x - lasso.start.x) * t0.k;
      const h = Math.abs(lasso.current.y - lasso.start.y) * t0.k;
      const style0 = getComputedStyle(document.documentElement);
      const accent = style0.getPropertyValue("--accent").trim() || "#3f6cd4";
      ctx.save();
      ctx.fillStyle = style0.getPropertyValue("--accent-soft").trim() || "rgba(63,108,212,0.14)";
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
      return;
    }

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

  /** Snap a world coordinate to the grid, when the option is on. */
  const gridSnap = useCallback((value: number) => {
    return snapRef.current ? snap(value, GRID) : Math.round(value);
  }, []);

  /**
   * Start dragging a card. Records where every card that will move started, so
   * each frame positions them absolutely — accumulating per-frame deltas makes
   * a snapped card creep, because every frame re-snaps an already-snapped value.
   */
  const beginNodeDrag = useCallback(
    (
      pointerId: number,
      nodeId: string,
      world: { x: number; y: number },
      screen: { x: number; y: number },
    ) => {
      const moving = selectedIdsRef.current.includes(nodeId)
        ? new Set(selectedIdsRef.current)
        : new Set([nodeId]);
      const origins = new Map<string, { x: number; y: number }>();
      for (const n of docRef.current.nodes) {
        if (moving.has(n.id)) origins.set(n.id, { x: n.x, y: n.y });
      }
      return { pointerId, nodeId, startWorld: world, lastScreen: screen, moved: false, origins };
    },
    [],
  );

  const createTextNode = useCallback((rect: Rect): TextNode => {
    return {
      id: makeId(),
      type: "text",
      text: "",
      x: gridSnap(rect.x),
      y: gridSnap(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }, [gridSnap]);

  const beginEditing = useCallback((node: CanvasNode) => {
    selectOnly(node.id);
    setEditingId(node.id);
    setEditingText(node.type === "text" ? node.text : nodeDisplayText(node));
  }, [selectOnly]);

  const applyGesture = useCallback(
    (points: Pt[]) => {
      const current = docRef.current;
      const gesture = recognize(points, current.nodes, current.edges);

      switch (gesture.kind) {
        case "tap": {
          if (!gesture.nodeId) {
            setSelectedIds([]);
            return;
          }
          const node = current.nodes.find((n) => n.id === gesture.nodeId);
          if (!node) return;
          // Tapping the node you already have selected opens it for text.
          if (selectedIdsRef.current.length === 1 && selectedIdsRef.current[0] === node.id) {
            beginEditing(node);
          } else if (gestureShiftRef.current) {
            // Shift keeps what is already selected and toggles this card.
            toggleSelected(node.id);
          } else {
            selectOnly(node.id);
          }
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
          const removedEdgeIds = new Set(gesture.edgeIds);
          if (nodeIds.size === 0 && removedEdgeIds.size === 0) return;

          const nodes = current.nodes.filter((n) => !nodeIds.has(n.id));
          const edges = current.edges.filter(
            (e) =>
              !removedEdgeIds.has(e.id) && !nodeIds.has(e.fromNode) && !nodeIds.has(e.toNode),
          );
          applyDoc({ nodes, edges });
          setSelectedIds((ids) => ids.filter((id) => !nodeIds.has(id)));
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
    [applyDoc, beginEditing, createTextNode, selectOnly, showToast, toggleSelected],
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

  /** Stop any in-flight programmatic zoom, so direct manipulation always wins. */
  const cancelAnim = useCallback(() => {
    if (animRef.current !== null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
  }, []);

  /**
   * Ease the view to a target. Only programmatic moves animate — panning and
   * pinching must track the finger exactly, and a transition there would feel
   * like lag rather than polish.
   */
  const animateTransform = useCallback(
    (to: Transform) => {
      cancelAnim();
      const from = transformRef.current;
      const start = performance.now();

      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ZOOM_ANIM_MS);
        // easeOutCubic: quick to leave, gentle to arrive.
        const e = 1 - Math.pow(1 - t, 3);
        setTransform({
          x: from.x + (to.x - from.x) * e,
          y: from.y + (to.y - from.y) * e,
          k: from.k + (to.k - from.k) * e,
        });
        animRef.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      animRef.current = requestAnimationFrame(step);
    },
    [cancelAnim],
  );

  useEffect(() => cancelAnim, [cancelAnim]);

  /** The view that frames one card comfortably. */
  const transformForCard = useCallback((node: CanvasNode): Transform | null => {
    const surface = surfaceRef.current;
    if (!surface) return null;
    const rect = surface.getBoundingClientRect();
    const k = clamp(
      Math.min(
        rect.width / (node.width + CARD_ZOOM_PAD * 2),
        rect.height / (node.height + CARD_ZOOM_PAD * 2),
      ),
      MIN_ZOOM,
      CARD_ZOOM_MAX,
    );
    return {
      k,
      x: rect.width / 2 - (node.x + node.width / 2) * k,
      y: rect.height / 2 - (node.y + node.height / 2) * k,
    };
  }, []);

  const fitTransform = useCallback((): Transform | null => {
    const surface = surfaceRef.current;
    const nodes = docRef.current.nodes;
    if (!surface || nodes.length === 0) return { x: 0, y: 0, k: 1 };
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
    return {
      k,
      x: rect.width / 2 - ((minX + maxX) / 2) * k,
      y: rect.height / 2 - ((minY + maxY) / 2) * k,
    };
  }, []);

  // ─── POINTER ROUTING ──────────────────────────────────────────────────────
  //
  // Pen draws. Touch navigates. That single split is what makes palm rejection
  // free: a palm can only ever pan, and pen priority stops even that.

  const isPenPriority = () => performance.now() < penUntilRef.current;

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (
        target.closest(`.${styles.nodeEditor}`) ||
        target.closest(`.${styles.chrome}`) ||
        // Buttons drawn on a card. Without this the surface captures the
        // pointer, pointerup is retargeted, and the click never arrives.
        target.closest("[data-card-action]")
      ) {
        return;
      }

      // The resize grip is the one place where pen and finger do the same
      // thing, so it is checked before either input branch.
      cancelAnim();

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

        if (touchesRef.current.size === 0) {
          multiRef.current = { startedAt: performance.now(), maxFingers: 0, moved: false };
        }
        touchesRef.current.set(e.pointerId, {
          x: e.clientX,
          y: e.clientY,
          startX: e.clientX,
          startY: e.clientY,
        });
        if (multiRef.current) {
          multiRef.current.maxFingers = Math.max(multiRef.current.maxFingers, touchesRef.current.size);
        }
        const touches = [...touchesRef.current.values()];
        if (touches.length === 1) {
          pinchRef.current = null;
          // One finger on a card moves the card; one finger on empty canvas
          // moves the canvas. The pen never does either — it draws.
          const world = toWorld(e.clientX, e.clientY);
          const hit = nodeAt(docRef.current.nodes, world);
          if (hit) {
            nodeDragRef.current = beginNodeDrag(e.pointerId, hit.id, world, {
              x: e.clientX,
              y: e.clientY,
            });
            panRef.current = null;

            // Held still on a card, a finger toggles it into the selection —
            // the touch equivalent of shift-clicking, and the only unused
            // single-finger gesture left.
            longPressFiredRef.current = false;
            longPressRef.current = {
              pointerId: e.pointerId,
              timer: window.setTimeout(() => {
                const drag = nodeDragRef.current;
                if (!drag || drag.pointerId !== e.pointerId || drag.moved) return;
                longPressFiredRef.current = true;
                longPressRef.current = null;
                toggleSelected(hit.id);
              }, LONG_PRESS_MS),
            };
          } else {
            nodeDragRef.current = null;
            panRef.current = {
              pointerId: e.pointerId,
              x: e.clientX,
              y: e.clientY,
              startX: e.clientX,
              startY: e.clientY,
              moved: false,
            };
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

      // Select mode turns the pen into a pointer instead of a nib: it drags
      // cards and lassoes empty space. Draw stays the default, because a tool
      // switch is exactly the tax the gesture model exists to avoid — this is
      // opt-in, for when you are arranging rather than thinking.
      if (penModeRef.current === "select") {
        cancelAnim();
        const world = toWorld(e.clientX, e.clientY);
        const hit = nodeAt(docRef.current.nodes, world);
        if (hit) {
          if (!selectedIdsRef.current.includes(hit.id)) {
            if (e.shiftKey) toggleSelected(hit.id);
            else selectOnly(hit.id);
          }
          nodeDragRef.current = beginNodeDrag(e.pointerId, hit.id, world, {
            x: e.clientX,
            y: e.clientY,
          });
        } else {
          lassoRef.current = {
            pointerId: e.pointerId,
            start: world,
            current: world,
            additive: e.shiftKey,
          };
        }
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Non-fatal; window-level events still finish the gesture.
        }
        return;
      }

      // Pen and mouse both draw, so the gestures are testable without an iPad.
      penUntilRef.current = performance.now() + PEN_PRIORITY_MS;
      gestureShiftRef.current = e.shiftKey;
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
    [beginNodeDrag, cancelAnim, commitEditing, editingId, selectOnly, toggleSelected, toWorld],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const resize = resizeRef.current;
      if (resize && resize.pointerId === e.pointerId) {
        const world = toWorld(e.clientX, e.clientY);
        const width = Math.max(
          MIN_CARD.width,
          gridSnap(resize.origWidth + (world.x - resize.startWorld.x)),
        );
        const height = Math.max(
          MIN_CARD.height,
          gridSnap(resize.origHeight + (world.y - resize.startWorld.y)),
        );
        setDoc((doc0) => ({
          ...doc0,
          nodes: doc0.nodes.map((n) =>
            n.id === resize.nodeId ? ({ ...n, width, height } as CanvasNode) : n,
          ),
        }));
        return;
      }

      // Card dragging is no longer touch-only: a pen in select mode uses the
      // same path, so it runs before the input branches rather than inside one.
      const drag = nodeDragRef.current;
      if (drag && drag.pointerId === e.pointerId) {
        const world = toWorld(e.clientX, e.clientY);
        const dx = world.x - drag.startWorld.x;
        const dy = world.y - drag.startWorld.y;
        drag.lastScreen = { x: e.clientX, y: e.clientY };
        drag.moved = true;
        if (longPressRef.current) {
          clearTimeout(longPressRef.current.timer);
          longPressRef.current = null;
        }
        // Live, without touching history; the whole drag is one undo entry.
        setDoc((d) => ({
          ...d,
          nodes: d.nodes.map((n) => {
            const from = drag.origins.get(n.id);
            if (!from) return n;
            return { ...n, x: gridSnap(from.x + dx), y: gridSnap(from.y + dy) } as CanvasNode;
          }),
        }));
        return;
      }

      if (e.pointerType === "touch") {
        if (isPenPriority()) return;
        const known = touchesRef.current.get(e.pointerId);
        if (!known) return;
        known.x = e.clientX;
        known.y = e.clientY;
        // Measure against where this finger landed, not the previous frame, so
        // slow drift accumulates instead of hiding under the per-frame delta.
        if (Math.hypot(e.clientX - known.startX, e.clientY - known.startY) > TAP_SLOP_PX) {
          if (multiRef.current) multiRef.current.moved = true;
        }
        const touches = [...touchesRef.current.values()];

        if (touches.length === 1 && panRef.current) {
          const pan = panRef.current;
          const dx = e.clientX - pan.x;
          const dy = e.clientY - pan.y;
          pan.x = e.clientX;
          pan.y = e.clientY;
          if (Math.hypot(e.clientX - pan.startX, e.clientY - pan.startY) > TAP_SLOP_PX) {
            pan.moved = true;
          }
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

      const lasso = lassoRef.current;
      if (lasso && lasso.pointerId === e.pointerId) {
        lasso.current = toWorld(e.clientX, e.clientY);
        drawInk();
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
    [drawInk, gridSnap, toWorld],
  );

  /**
   * Two fingers tapped twice undo; three redo.
   *
   * Both are confined to multi-finger taps precisely because one finger is
   * already busy — selecting, dragging, and double-tapping to zoom. Undo is
   * also the gesture most worth being able to reach without looking, which is
   * why it gets the easier of the two.
   */
  const handleMultiTap = useCallback(
    (fingers: number) => {
      if (fingers !== 2 && fingers !== 3) return;

      const now = performance.now();
      const last = lastMultiTapRef.current;
      if (last && now - last.t < DOUBLE_TAP_MS && last.fingers === fingers) {
        lastMultiTapRef.current = null;
        if (fingers === 2) {
          if (!canUndo(historyRef.current)) {
            showToast("Nothing to undo.");
            return;
          }
          undoRef.current();
          showToast("Undone.");
        } else {
          if (!canRedo(historyRef.current)) {
            showToast("Nothing to redo.");
            return;
          }
          redoRef.current();
          showToast("Redone.");
        }
        return;
      }
      lastMultiTapRef.current = { t: now, fingers };
    },
    [showToast],
  );

  /**
   * A finger that landed and lifted without travelling. Handles selection, and
   * pairs with a previous tap to make a double-tap.
   *
   * Double-tap is a finger gesture only. The pen already uses a second tap to
   * open a card for text, and taking that over would cost handwriting to buy
   * navigation — a bad trade on a device where the pen is the point.
   */
  const handleTap = useCallback(
    (nodeId: string | null, at: { x: number; y: number }) => {
      const now = performance.now();
      const last = lastTapRef.current;
      const paired =
        last !== null &&
        now - last.t < DOUBLE_TAP_MS &&
        Math.hypot(at.x - last.x, at.y - last.y) < DOUBLE_TAP_PX &&
        last.nodeId === nodeId;

      if (paired) {
        lastTapRef.current = null;
        if (nodeId) {
          const node = docRef.current.nodes.find((n) => n.id === nodeId);
          const target = node ? transformForCard(node) : null;
          if (target) {
            // Remember the overview only on the way in, so hopping between
            // cards still returns to where you actually started.
            if (!zoomBackRef.current) zoomBackRef.current = transformRef.current;
            animateTransform(target);
          }
          return;
        }
        // Away from any card: back to where you were, or the whole map.
        const back = zoomBackRef.current ?? fitTransform();
        zoomBackRef.current = null;
        if (back) animateTransform(back);
        return;
      }

      lastTapRef.current = { t: now, x: at.x, y: at.y, nodeId };
      selectOnly(nodeId);
    },
    [animateTransform, fitTransform, selectOnly, transformForCard],
  );

  const endTouch = useCallback((pointerId: number) => {
    if (longPressRef.current && longPressRef.current.pointerId === pointerId) {
      clearTimeout(longPressRef.current.timer);
      longPressRef.current = null;
    }
    const drag = nodeDragRef.current;
    if (drag && drag.pointerId === pointerId) {
      nodeDragRef.current = null;
      if (drag.moved) {
        // Positions are already whole numbers — gridSnap rounds either way —
        // so finishing only has to put the move on the undo stack.
        setDragCommit((t) => t + 1);
      } else if (longPressFiredRef.current) {
        // The long press already changed the selection; the lift is not a tap.
        longPressFiredRef.current = false;
      } else {
        handleTap(drag.nodeId, drag.lastScreen);
      }
    }

    const pan = panRef.current;
    if (pan && pan.pointerId === pointerId && !pan.moved) {
      handleTap(null, { x: pan.x, y: pan.y });
    }

    touchesRef.current.delete(pointerId);
    if (touchesRef.current.size < 2) pinchRef.current = null;
    if (touchesRef.current.size === 1) {
      const [only] = [...touchesRef.current.values()];
      // A finger lifted from a pinch: whichever remains keeps panning, but it
      // has already travelled, so it can never read as a tap.
      panRef.current = {
        pointerId: -1,
        x: only.x,
        y: only.y,
        startX: only.x,
        startY: only.y,
        moved: true,
      };
    }
    if (touchesRef.current.size === 0) {
      panRef.current = null;
      // The whole gesture is over: decide whether it was a multi-finger tap.
      const multi = multiRef.current;
      multiRef.current = null;
      if (
        multi &&
        !multi.moved &&
        multi.maxFingers >= 2 &&
        performance.now() - multi.startedAt < MULTI_TAP_MAX_MS
      ) {
        handleMultiTap(multi.maxFingers);
      }
    }
  }, [handleMultiTap, handleTap]);

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

  /** Select everything the lasso covers. Returns true if it handled the lift. */
  const finishLasso = useCallback(
    (pointerId: number): boolean => {
      const lasso = lassoRef.current;
      if (!lasso || lasso.pointerId !== pointerId) return false;
      lassoRef.current = null;
      clearInk();

      const rect = {
        x: Math.min(lasso.start.x, lasso.current.x),
        y: Math.min(lasso.start.y, lasso.current.y),
        width: Math.abs(lasso.current.x - lasso.start.x),
        height: Math.abs(lasso.current.y - lasso.start.y),
      };
      // A stray dab is not a lasso; treat it as clearing the selection.
      if (rect.width < 6 && rect.height < 6) {
        if (!lasso.additive) setSelectedIds([]);
        return true;
      }

      // Touching counts, not enclosing: on a crowded map, demanding full
      // containment means missing the card you were obviously reaching for.
      const caught = docRef.current.nodes.filter((n) => rectsOverlap(rect, nodeRect(n))).map((n) => n.id);
      setSelectedIds((ids) =>
        lasso.additive ? [...new Set([...ids, ...caught])] : caught,
      );
      if (caught.length) showToast(`${caught.length} selected.`);
      return true;
    },
    [clearInk, showToast],
  );

  /** Finish a card drag started by any pointer. Returns true if it handled it. */
  const finishNodeDrag = useCallback((pointerId: number): boolean => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== pointerId) return false;
    nodeDragRef.current = null;
    if (drag.moved) setDragCommit((t) => t + 1);
    return drag.moved;
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (finishResize(e.pointerId)) return;
      if (finishLasso(e.pointerId)) return;
      if (e.pointerType !== "touch" && finishNodeDrag(e.pointerId)) return;
      if (e.pointerType === "touch") {
        endTouch(e.pointerId);
        return;
      }
      const stroke = strokeRef.current;
      if (!stroke || stroke.pointerId !== e.pointerId) {
        // In select mode there is no stroke to judge; a bare lift is a click
        // on empty space, which clears the selection.
        if (penModeRef.current === "select" && !e.shiftKey) setSelectedIds([]);
        return;
      }

      penUntilRef.current = performance.now() + PEN_PRIORITY_MS;
      strokeRef.current = null;
      clearInk();
      applyGesture(stroke.points);
    },
    [applyGesture, clearInk, endTouch, finishLasso, finishNodeDrag, finishResize],
  );

  const onPointerCancel = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (finishResize(e.pointerId)) return;
      if (finishLasso(e.pointerId)) return;
      if (e.pointerType !== "touch" && finishNodeDrag(e.pointerId)) return;
      if (e.pointerType === "touch") {
        endTouch(e.pointerId);
        return;
      }
      strokeRef.current = null;
      clearInk();
    },
    [clearInk, endTouch, finishLasso, finishNodeDrag, finishResize],
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

  useEffect(() => {
    undoRef.current = doUndo;
    redoRef.current = doRedo;
  }, [doRedo, doUndo]);

  const deleteSelected = useCallback(() => {
    const ids = new Set(selectedIds);
    if (ids.size === 0) return;
    const current = docRef.current;
    applyDoc({
      nodes: current.nodes.filter((n) => !ids.has(n.id)),
      edges: current.edges.filter((e) => !ids.has(e.fromNode) && !ids.has(e.toNode)),
    });
    setSelectedIds([]);
    setEditingId(null);
  }, [applyDoc, selectedIds]);

  const setSelectedColor = useCallback(
    (color: string | null) => {
      const ids = new Set(selectedIds);
      if (ids.size === 0) return;
      const current = docRef.current;
      const nodes = current.nodes.map((n) => {
        if (!ids.has(n.id)) return n;
        const next = { ...n } as CanvasNode;
        if (color) next.color = color;
        else delete next.color;
        return next;
      });
      applyDoc({ ...current, nodes });
    },
    [applyDoc, selectedIds],
  );

  /**
   * Line the selection up on one axis, by centre rather than by edge — cards
   * differ in width, and a column of boxes with matching centres reads as
   * straight where matching left edges does not.
   *
   * axis "x" aligns centres horizontally, producing a vertical column.
   */
  const alignSelected = useCallback(
    (axis: "x" | "y") => {
      const ids = new Set(selectedIds);
      if (ids.size < 2) return;
      const current = docRef.current;
      const chosen = current.nodes.filter((n) => ids.has(n.id));
      const size = axis === "x" ? ("width" as const) : ("height" as const);

      // Aim at the centre of what is selected, so the group stays put rather
      // than sliding towards whichever card happens to be first.
      const centre =
        chosen.reduce((sum, n) => sum + n[axis] + n[size] / 2, 0) / chosen.length;

      // A column of differently-sized cards still looks ragged with matching
      // centres, because the edges do not line up. Give them all the largest
      // measurement on that axis so the edges agree. Largest, never smallest,
      // so nothing gets narrowed into clipping its own text.
      const uniform = Math.max(...chosen.map((n) => n[size]));

      applyDoc({
        ...current,
        nodes: current.nodes.map((n) =>
          ids.has(n.id)
            ? ({
                ...n,
                [size]: uniform,
                [axis]: Math.round(centre - uniform / 2),
              } as CanvasNode)
            : n,
        ),
      });
      showToast(
        axis === "x"
          ? "Aligned into a column, edges matched."
          : "Aligned into a row, edges matched.",
      );
    },
    [applyDoc, selectedIds, showToast],
  );

  /** Even the gaps along whichever axis the selection is more spread out on. */
  const distributeSelected = useCallback(() => {
    const ids = new Set(selectedIds);
    if (ids.size < 3) return;
    const current = docRef.current;
    const chosen = current.nodes.filter((n) => ids.has(n.id));

    const spread = (axis: "x" | "y", size: "width" | "height") =>
      Math.max(...chosen.map((n) => n[axis] + n[size])) - Math.min(...chosen.map((n) => n[axis]));
    const vertical = spread("y", "height") > spread("x", "width");
    const axis = vertical ? ("y" as const) : ("x" as const);
    const size = vertical ? ("height" as const) : ("width" as const);

    const order = [...chosen].sort((a, b) => a[axis] - b[axis]);
    const start = order[0][axis];
    const end = order[order.length - 1][axis] + order[order.length - 1][size];
    const occupied = order.reduce((sum, n) => sum + n[size], 0);
    const gap = (end - start - occupied) / (order.length - 1);

    const placed = new Map<string, number>();
    let cursor = start;
    for (const node of order) {
      placed.set(node.id, Math.round(cursor));
      cursor += node[size] + gap;
    }

    applyDoc({
      ...current,
      nodes: current.nodes.map((n) =>
        placed.has(n.id) ? ({ ...n, [axis]: placed.get(n.id)! } as CanvasNode) : n,
      ),
    });
    showToast("Spaced evenly.");
  }, [applyDoc, selectedIds, showToast]);

  const selectAll = useCallback(() => {
    setSelectedIds(docRef.current.nodes.map((n) => n.id));
  }, []);

  /**
   * Tilt panning runs its own animation frame loop rather than moving the view
   * on each sensor reading: readings arrive at whatever rate the hardware
   * feels like, and panning has to be smooth and frame-rate independent.
   *
   * It stands down whenever a pointer is doing something — mid-stroke, mid-drag
   * or mid-pinch — because a canvas that slides while you are drawing on it
   * would ruin the stroke you are making.
   */
  useEffect(() => {
    if (!tiltOn && tiltStep === "none") return;

    const onReading = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return;
      tiltReadingRef.current = { beta: e.beta, gamma: e.gamma };
    };
    window.addEventListener("deviceorientation", onReading);

    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      tiltFrameRef.current = requestAnimationFrame(step);

      const cal = tiltCalRef.current;
      // Nothing pans while a direction is being demonstrated, or the canvas
      // would slide out from under the thing being calibrated.
      if (!cal || !tiltOn || tiltStep !== "none") return;

      // Stand down while a pointer is busy: a canvas sliding underneath a
      // stroke would drag that stroke out of shape as it was drawn.
      const busy =
        strokeRef.current !== null ||
        nodeDragRef.current !== null ||
        resizeRef.current !== null ||
        lassoRef.current !== null ||
        touchesRef.current.size > 0;
      if (busy) return;

      const { vx, vy } = tiltPan(tiltReadingRef.current, cal);
      if (vx === 0 && vy === 0) return;
      // Lean toward what you want to see: the view moves, so content moves the
      // other way. Which lean means which direction is whatever was
      // demonstrated, so this sign is the only convention left in the code.
      setTransform((t) => ({ ...t, x: t.x - vx * dt, y: t.y - vy * dt }));
    };
    tiltFrameRef.current = requestAnimationFrame(step);

    return () => {
      window.removeEventListener("deviceorientation", onReading);
      if (tiltFrameRef.current !== null) cancelAnimationFrame(tiltFrameRef.current);
      tiltFrameRef.current = null;
    };
  }, [tiltOn, tiltStep]);

  /** Record whatever the device is doing right now as the current step. */
  const captureTiltStep = useCallback(() => {
    const reading = tiltReadingRef.current;

    if (tiltStep === "neutral") {
      tiltDraftRef.current.neutral = { ...reading };
      setTiltStep("right");
      return;
    }

    const neutral = tiltDraftRef.current.neutral;
    if (!neutral) return;
    const axis = normalizeAxis(tiltOffset(reading, neutral));
    if (!axis) {
      showToast("Tilt it a bit further, then tap again.");
      return;
    }

    if (tiltStep === "right") {
      tiltCalRef.current = { neutral, right: axis, down: { g: 0, b: 0 } };
      setTiltStep("down");
      return;
    }

    if (tiltStep === "down") {
      const partial = tiltCalRef.current;
      if (!partial) return;
      const complete: TiltCalibration = { ...partial, down: axis };
      tiltCalRef.current = complete;
      saveCalibration(complete);
      setTiltStep("none");
      setTiltOn(true);
      try {
        localStorage.setItem("mindmap_tilt", "1");
      } catch {
        // Losing the preference is harmless.
      }
      showToast("Tilt ready.");
    }
  }, [showToast, tiltStep]);

  const cancelTiltSetup = useCallback(() => {
    setTiltStep("none");
    tiltDraftRef.current.neutral = null;
    if (!tiltCalRef.current) setTiltOn(false);
  }, []);

  const startTiltSetup = useCallback(() => {
    tiltDraftRef.current.neutral = null;
    tiltCalRef.current = null;
    setTiltStep("neutral");
  }, []);

  const toggleTilt = useCallback(async () => {
    if (tiltOn || tiltStep !== "none") {
      setTiltOn(false);
      setTiltStep("none");
      try {
        localStorage.setItem("mindmap_tilt", "0");
      } catch {
        // Losing the preference is harmless.
      }
      return;
    }
    if (!tiltSupported()) {
      showToast("This device doesn't report tilt.");
      return;
    }
    const verdict = await requestTiltPermission();
    if (verdict !== "granted") {
      showToast(
        verdict === "denied"
          ? "Motion access was denied. Allow it in Settings › Safari to use tilt."
          : "This device doesn't report tilt.",
      );
      return;
    }

    // A saved calibration is reused; the first time, it has to be taught.
    const saved = loadCalibration();
    if (saved) {
      tiltCalRef.current = saved;
      setTiltOn(true);
      try {
        localStorage.setItem("mindmap_tilt", "1");
      } catch {
        // Losing the preference is harmless.
      }
      showToast("Tilt on.");
      return;
    }
    startTiltSetup();
  }, [showToast, startTiltSetup, tiltOn, tiltStep]);

  const toggleSnap = useCallback(() => {
    setSnapToGrid((on) => {
      const next = !on;
      try {
        localStorage.setItem("mindmap_snap", next ? "1" : "0");
      } catch {
        // Losing the preference is harmless.
      }
      return next;
    });
  }, []);

  const togglePenMode = useCallback(() => {
    setPenMode((mode) => {
      const next = mode === "draw" ? "select" : "draw";
      try {
        localStorage.setItem("mindmap_pen_mode", next);
      } catch {
        // Losing the preference is harmless.
      }
      return next;
    });
  }, []);

  const zoomToFit = useCallback(() => {
    const next = fitTransform();
    if (next) {
      cancelAnim();
      setTransform(next);
    }
  }, [cancelAnim, fitTransform]);

  // ─── FILE I/O ─────────────────────────────────────────────────────────────

  const fileInputRef = useRef<HTMLInputElement>(null);
  const jumpInputRef = useRef<HTMLInputElement>(null);

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
        setSelectedIds([]);
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

  const refreshCloud = useCallback(async () => {
    setCloudState("loading");
    const res = await listCloudCanvases();
    if (res.ok) {
      setCloud(res.value);
      setCloudState("idle");
      return;
    }
    setCloud([]);
    setCloudState(res.unconfigured ? "off" : "error");
    setCloudError(res.error);
  }, []);

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
    void refreshCloud();
  }, [flushSave, refreshCloud, refreshLibrary]);

  /** Make `next` the open canvas. Callers must have flushed the current one. */
  const adopt = useCallback((next: CanvasRecord) => {
    setRecord(next);
    setDoc(next.doc);
    setHistory(initHistory(next.doc));
    setSelectedIds([]);
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
      setTrail([]);
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

  // ─── CLOUD LIBRARY ────────────────────────────────────────────────────────
  //
  // The cloud is a second, shared library rather than a replacement: the device
  // stays the working store so the app keeps working on a plane, and pushing is
  // how a map becomes visible to the agents.

  const pushCurrent = useCallback(
    async (target: CanvasRecord) => {
      setBusyCloudId(target.id);
      const res = await pushCanvas(target.doc, target.name, target.cloudId ?? null);
      setBusyCloudId(null);
      if (!res.ok) {
        showToast(res.unconfigured ? "Cloud sync isn't set up." : res.error);
        return;
      }
      // Remember the link so the next push updates rather than duplicates.
      const linked = { ...target, cloudId: res.value };
      await putCanvas(linked);
      if (record?.id === target.id) setRecord(linked);
      await refreshLibrary();
      await refreshCloud();
      showToast(`Pushed “${target.name}” to the cloud.`);
    },
    [record, refreshCloud, refreshLibrary, showToast],
  );

  const openFromCloud = useCallback(
    async (item: CloudCanvas) => {
      setBusyCloudId(item.id);
      const res = await pullCanvas(item.id);
      setBusyCloudId(null);
      if (!res.ok) {
        showToast(res.error);
        return;
      }
      await flushSave();

      // Pulling into the local map already linked to this cloud row updates it
      // in place; otherwise it arrives as a new local map.
      const existing = (await listCanvases()).find((c) => c.cloudId === item.id);
      const next: CanvasRecord = existing
        ? { ...existing, name: item.name, doc: res.value, updated: new Date().toISOString() }
        : { ...newRecord(item.name, res.value), cloudId: item.id };

      await putCanvas(next);
      adopt(next);
      setLibraryOpen(false);
      showToast(`Opened “${item.name}” from the cloud.`);
      requestAnimationFrame(zoomToFit);
    },
    [adopt, flushSave, showToast, zoomToFit],
  );

  const removeFromCloud = useCallback(
    async (item: CloudCanvas) => {
      setBusyCloudId(item.id);
      const res = await deleteCloudCanvas(item.id);
      setBusyCloudId(null);
      if (!res.ok) {
        showToast(res.error);
        return;
      }
      await refreshCloud();
      showToast("Removed from the cloud. The copy on this device is untouched.");
    },
    [refreshCloud, showToast],
  );

  // ─── NESTED MAPS ──────────────────────────────────────────────────────────
  //
  // A doorway is a spec `file` node pointing at another .canvas, so Obsidian
  // sees an ordinary file card. The library id rides along in an extra key,
  // because resolving by name breaks on a rename or a duplicate.

  /** Keep the card counts shown on doorways in step with the maps behind them. */
  useEffect(() => {
    let cancelled = false;
    const doorways = doc.nodes.filter((n) => isCanvasFile(n) && nestedCanvasId(n));
    (async () => {
      const sizes: Record<string, number> = {};
      for (const node of doorways) {
        const id = nestedCanvasId(node);
        if (!id) continue;
        try {
          const record = await getCanvas(id);
          if (record) sizes[id] = record.doc.nodes.length;
        } catch {
          // A doorway to a map that has gone is still drawn, just without a count.
        }
      }
      if (cancelled) return;
      // Replace only when something actually differs, or this effect would
      // re-run itself forever through the doc it depends on.
      setNestedSizes((prev) => {
        const same =
          Object.keys(prev).length === Object.keys(sizes).length &&
          Object.entries(sizes).every(([k, v]) => prev[k] === v);
        return same ? prev : sizes;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [doc.nodes]);

  /** Walk into the map a doorway points at. */
  const openNested = useCallback(
    async (node: CanvasNode) => {
      const id = nestedCanvasId(node);
      if (!id) {
        showToast("That card points at a file, not a map in this library.");
        return;
      }
      const target = await getCanvas(id);
      if (!target) {
        showToast("That map isn't in this library any more.");
        return;
      }
      // Flush first: autosave is debounced, and walking away within a second of
      // an edit would otherwise lose it — the same race the library has.
      await flushSave();
      const here = record;
      adopt(target);
      if (here) setTrail((t) => [...t, { id: here.id, name: here.name }]);
      requestAnimationFrame(zoomToFit);
    },
    [adopt, flushSave, record, showToast, zoomToFit],
  );

  /** Back out to an ancestor. */
  const openAncestor = useCallback(
    async (index: number) => {
      const step = trail[index];
      if (!step) return;
      const target = await getCanvas(step.id);
      if (!target) {
        showToast("That map isn't in this library any more.");
        setTrail((t) => t.slice(0, index));
        return;
      }
      await flushSave();
      adopt(target);
      setTrail((t) => t.slice(0, index));
      requestAnimationFrame(zoomToFit);
    },
    [adopt, flushSave, showToast, trail, zoomToFit],
  );

  /** Move the selection into a map of its own, leaving a doorway behind. */
  const foldSelected = useCallback(async () => {
    const current = docRef.current;
    const chosen = current.nodes.filter((n) => selectedIds.includes(n.id));
    if (chosen.length === 0) return;
    if (chosen.length === current.nodes.length) {
      showToast("Leave at least one card behind to fold into.");
      return;
    }

    const name = sanitizeName(nameForFold(chosen));
    const subRecord = newRecord(name);
    const result = foldSelection(current, selectedIds, subRecord.id, name);
    if (!result) return;

    await putCanvas({ ...subRecord, doc: result.sub });
    applyDoc(result.parent);
    setSelectedIds([result.doorwayId]);
    setEditingId(null);
    await refreshLibrary();
    showToast(`Folded ${chosen.length} card${chosen.length === 1 ? "" : "s"} into “${name}”.`);
  }, [applyDoc, refreshLibrary, selectedIds, showToast]);

  /** Bring a folded map's contents back, replacing the doorway. */
  const unfoldSelected = useCallback(async () => {
    const current = docRef.current;
    const node = current.nodes.find((n) => n.id === selectedIds[0]);
    if (!node || !isCanvasFile(node)) return;
    const id = nestedCanvasId(node);
    if (!id) {
      showToast("That card points at a file, not a map in this library.");
      return;
    }
    const target = await getCanvas(id);
    if (!target) {
      showToast("That map isn't in this library any more.");
      return;
    }
    const next = unfoldNested(current, node, target.doc);
    if (!next) {
      showToast("That map is empty — nothing to bring back.");
      return;
    }
    applyDoc(next);
    setSelectedIds([]);
    showToast(`Brought back ${target.doc.nodes.length} card${target.doc.nodes.length === 1 ? "" : "s"}.`);
  }, [applyDoc, selectedIds, showToast]);

  // ─── JUMP PALETTE ─────────────────────────────────────────────────────────
  //
  // Maps first, since jumping between them is the point, then cards in the map
  // currently open — typing a card's name and getting nothing would feel broken.

  const openJump = useCallback(async () => {
    setJumpQuery("");
    setJumpIndex(0);
    setJumpOpen(true);
    await refreshLibrary();
  }, [refreshLibrary]);

  const closeJump = useCallback(() => {
    setJumpOpen(false);
    setJumpQuery("");
  }, []);

  const toggleJumpEverywhere = useCallback(() => {
    setJumpEverywhere((on) => {
      const next = !on;
      try {
        localStorage.setItem("mindmap_jump_everywhere", next ? "1" : "0");
      } catch {
        // Losing the preference is harmless.
      }
      return next;
    });
    setJumpIndex(0);
    // Hand focus back to the query, or the next keystroke goes nowhere.
    requestAnimationFrame(() => jumpInputRef.current?.focus());
  }, []);

  type JumpTarget =
    | { kind: "map"; id: string; name: string; cards: number; current: boolean }
    | { kind: "card"; id: string; text: string; mapId: string | null; mapName: string };

  const jumpTargets = useMemo<JumpTarget[]>(() => {
    if (!jumpOpen) return [];

    const maps: JumpTarget[] = library.map((item) => ({
      kind: "map" as const,
      id: item.id,
      name: item.name,
      cards: item.doc.nodes.length,
      current: item.id === record?.id,
    }));

    // Every map's document is already in memory once the library has loaded, so
    // searching all of them costs no more than searching one.
    const sources = jumpEverywhere
      ? library.map((item) => ({
          mapId: item.id === record?.id ? null : item.id,
          mapName: item.name,
          nodes: item.doc.nodes,
        }))
      : [{ mapId: null, mapName: record?.name ?? "", nodes: doc.nodes }];

    const cards: JumpTarget[] = sources.flatMap((source) =>
      source.nodes
        .map((n) => ({
          kind: "card" as const,
          id: n.id,
          text: nodeDisplayText(n).trim(),
          mapId: source.mapId,
          mapName: source.mapName,
        }))
        .filter((c) => c.text.length > 0),
    );

    return [
      ...rank(jumpQuery, maps, (m) => (m.kind === "map" ? m.name : ""), 6),
      ...rank(jumpQuery, cards, (c) => (c.kind === "card" ? c.text : ""), jumpEverywhere ? 12 : 8),
    ];
  }, [doc.nodes, jumpEverywhere, jumpOpen, jumpQuery, library, record]);

  const activateJump = useCallback(
    async (target: JumpTarget | undefined) => {
      if (!target) return;
      if (target.kind === "map") {
        closeJump();
        if (target.id === record?.id) return;
        await switchTo(target.id);
        setTrail([]);
        return;
      }
      closeJump();

      // A card in the map already open: select and glide to it.
      if (!target.mapId) {
        const node = docRef.current.nodes.find((n) => n.id === target.id);
        if (!node) return;
        setSelectedIds([node.id]);
        const view = transformForCard(node);
        if (view) animateTransform(view);
        return;
      }

      // A card somewhere else: switch first, then land on it. The view is set
      // outright rather than animated — easing from the previous map's
      // scroll position would read as drift, not motion.
      await flushSave();
      const holding = await getCanvas(target.mapId);
      if (!holding) {
        showToast("That map isn't in this library any more.");
        return;
      }
      const node = holding.doc.nodes.find((n) => n.id === target.id);
      adopt(holding);
      setTrail([]);
      if (!node) {
        requestAnimationFrame(zoomToFit);
        return;
      }
      setSelectedIds([node.id]);
      const view = transformForCard(node);
      cancelAnim();
      if (view) setTransform(view);
    },
    [
      adopt,
      animateTransform,
      cancelAnim,
      closeJump,
      flushSave,
      record,
      showToast,
      switchTo,
      transformForCard,
      zoomToFit,
    ],
  );

  // Two things iPadOS makes awkward. The palette is opened with a metaKey
  // combination, and Safari refuses focus() for a moment afterwards; and in a
  // standalone PWA that moment can outlast the animation frame. So focus is
  // attempted, and any keystrokes that miss the input are routed into the query
  // by hand rather than being swallowed.
  useEffect(() => {
    if (!jumpOpen) return;
    const raf = requestAnimationFrame(() => jumpInputRef.current?.focus());

    const onKeyPress = (e: KeyboardEvent) => {
      if (document.activeElement === jumpInputRef.current) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length !== 1) return;
      e.preventDefault();
      setJumpQuery((q) => q + e.key);
      setJumpIndex(0);
      jumpInputRef.current?.focus();
    };
    window.addEventListener("keypress", onKeyPress, true);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keypress", onKeyPress, true);
    };
  }, [jumpOpen]);

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

  // ─── PASTE / COPY JSON ────────────────────────────────────────────────────
  //
  // The file picker is fine for maps that already live in Files, but the way a
  // map actually travels between here and a conversation is as text. This is
  // the same parser the file path uses, so anything that opens as a file opens
  // as a paste and vice versa.

  const pasteResult = useMemo(() => {
    const text = pasteText.trim();
    if (!text) return null;
    try {
      const { canvas, warnings } = parseCanvas(text);
      return { canvas, warnings, error: null as string | null };
    } catch (err) {
      return {
        canvas: null,
        warnings: [] as string[],
        error: err instanceof Error ? err.message : "That isn't valid JSON.",
      };
    }
  }, [pasteText]);

  const closePaste = useCallback(() => {
    setPasteOpen(false);
    setPasteText("");
  }, []);

  const pasteAsNewMap = useCallback(async () => {
    if (!pasteResult?.canvas) return;
    await flushSave();
    const next = newRecord("Pasted map", pasteResult.canvas);
    await putCanvas(next);
    adopt(next);
    closePaste();
    showToast(`Opened ${pasteResult.canvas.nodes.length} cards as a new map.`);
    requestAnimationFrame(zoomToFit);
  }, [adopt, closePaste, flushSave, pasteResult, showToast, zoomToFit]);

  const pasteIntoThisMap = useCallback(() => {
    if (!pasteResult?.canvas) return;
    // Replacing goes through applyDoc, so a mistaken paste is one undo away.
    applyDoc(pasteResult.canvas);
    setSelectedIds([]);
    setEditingId(null);
    closePaste();
    showToast("Replaced this map. Undo if that wasn't right.");
    requestAnimationFrame(zoomToFit);
  }, [applyDoc, closePaste, pasteResult, showToast, zoomToFit]);

  const copyCurrentJson = useCallback(async () => {
    const text = serializeCanvas(docRef.current);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; show the text so it can be copied by
      // hand rather than failing with nothing on screen.
      setPasteText(text);
      showToast("Couldn't reach the clipboard — copy it from the box.");
    }
  }, [showToast]);

  // ─── KEYBOARD ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === "TEXTAREA" || target?.tagName === "INPUT";

      if (jumpOpen && e.key === "Escape") {
        e.preventDefault();
        closeJump();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (jumpOpen) closeJump();
        else void openJump();
        return;
      }

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
        if (selectedIds.length) {
          e.preventDefault();
          deleteSelected();
        }
        return;
      }
      if (e.key === "Escape") setSelectedIds([]);
      if (e.key.toLowerCase() === "a" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        selectAll();
      }
      if (e.key === "0" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        zoomToFit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    closeJump,
    commitEditing,
    deleteSelected,
    doRedo,
    doUndo,
    jumpOpen,
    openJump,
    selectAll,
    selectedIds,
    zoomToFit,
  ]);

  // ─── RENDER ───────────────────────────────────────────────────────────────

  const edgePaths = useMemo(() => buildEdgePaths(doc), [doc]);
  const selectedNodes = doc.nodes.filter((n) => selectedIds.includes(n.id));

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
                  isCanvasFile(node) ? styles.doorwayNode : "",
                  selectedIds.includes(node.id) ? styles.nodeSelected : "",
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
                {selectedIds.length === 1 && selectedIds[0] === node.id && !isEditing ? (
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
                ) : isCanvasFile(node) ? (
                  <div className={styles.doorway}>
                    <span className={styles.doorwayName}>{nestedCanvasName(node)}</span>
                    <span className={styles.doorwayMeta}>{doorwaySubtitle(node, nestedSizes)}</span>
                    <button
                      className={styles.doorwayOpen}
                      data-card-action="open"
                      onClick={() => void openNested(node)}
                      aria-label={`Open ${nestedCanvasName(node)}`}
                    >
                      Open ↗
                    </button>
                  </div>
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
          <button className={styles.button} onClick={() => setPasteOpen(true)}>
            JSON
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

      {trail.length > 0 ? (
        <nav className={`${styles.chrome} ${styles.trail}`} aria-label="Map trail">
          {trail.map((step, i) => (
            <button
              key={`${step.id}-${i}`}
              className={styles.trailStep}
              onClick={() => void openAncestor(i)}
            >
              {step.name}
            </button>
          ))}
          <span className={styles.trailHere}>{record?.name ?? ""}</span>
        </nav>
      ) : null}

      <div className={styles.bottomDock}>
        {toasts.length > 0 ? (
          <div className={styles.toasts}>
            {toasts.map((t) => (
              <div key={t.id} className={styles.toast}>
                {t.message}
              </div>
            ))}
          </div>
        ) : null}

        <div className={`${styles.chrome} ${styles.bottomBar}`}>
          <button className={styles.button} onClick={doUndo} disabled={!canUndo(history)}>
            Undo
          </button>
          <button className={styles.button} onClick={doRedo} disabled={!canRedo(history)}>
            Redo
          </button>
          <span className={styles.spacer} />
          <button
            className={`${styles.button} ${penMode === "select" ? styles.buttonOn : ""}`}
            onClick={togglePenMode}
            title={
              penMode === "draw"
                ? "Pen draws. Switch it to moving cards and lassoing."
                : "Pen moves and lassoes. Switch it back to drawing."
            }
          >
            {penMode === "draw" ? "✎ Draw" : "⬚ Select"}
          </button>
          <button
            className={`${styles.button} ${snapToGrid ? styles.buttonOn : ""}`}
            onClick={toggleSnap}
            title="Snap cards to the grid while moving and resizing"
          >
            Snap
          </button>
          <button
            className={`${styles.button} ${tiltOn ? styles.buttonOn : ""}`}
            onClick={() => void toggleTilt()}
            title="Tilt the iPad to pan, so you can keep hold of the pen"
          >
            Tilt
          </button>
          {tiltOn && tiltStep === "none" ? (
            <button
              className={styles.button}
              onClick={startTiltSetup}
              title="Teach it the directions again"
              aria-label="Recalibrate tilt"
            >
              ⟳
            </button>
          ) : null}
          <button className={styles.button} onClick={zoomToFit}>
            Fit
          </button>
          <span className={styles.zoomLabel}>{Math.round(transform.k * 100)}%</span>
        </div>

        {selectedNodes.length > 0 ? (
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
            {selectedNodes.length === 1 && isCanvasFile(selectedNodes[0]) ? (
              <>
                <button className={styles.button} onClick={() => void openNested(selectedNodes[0])}>
                  Open
                </button>
                <button className={styles.button} onClick={() => void unfoldSelected()}>
                  Unfold
                </button>
              </>
            ) : selectedNodes.length === 1 ? (
              <>
                <button
                  className={styles.button}
                  onClick={() => {
                    const node = docRef.current.nodes.find((n) => n.id === selectedIds[0]);
                    if (node) beginEditing(node);
                  }}
                >
                  Edit
                </button>
                <button
                  className={styles.button}
                  onClick={() => void foldSelected()}
                  title="Move this into a map of its own"
                >
                  Fold
                </button>
              </>
            ) : (
              <>
                <span className={styles.selectionCount}>{selectedNodes.length} selected</span>
                <button
                  className={styles.button}
                  onClick={() => alignSelected("x")}
                  title="Line them up in a column"
                >
                  Column
                </button>
                <button
                  className={styles.button}
                  onClick={() => alignSelected("y")}
                  title="Line them up in a row"
                >
                  Row
                </button>
                <button
                  className={styles.button}
                  onClick={distributeSelected}
                  disabled={selectedNodes.length < 3}
                  title="Even out the gaps"
                >
                  Space
                </button>
                <button
                  className={styles.button}
                  onClick={() => void foldSelected()}
                  title="Move these into a map of their own"
                >
                  Fold
                </button>
              </>
            )}
            <button className={`${styles.button} ${styles.danger}`} onClick={deleteSelected}>
              Delete
            </button>
          </div>
        ) : null}

      </div>

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

      {jumpOpen ? (
        <div className={styles.sheetBackdrop} onClick={closeJump}>
          <div
            className={`${styles.chrome} ${styles.jump}`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Jump to"
          >
            <div className={styles.jumpHeader}>
            <input
              ref={jumpInputRef}
              className={styles.jumpInput}
              value={jumpQuery}
              placeholder="Jump to a map or a card…"
              aria-label="Jump to"
              autoFocus
              spellCheck={false}
              onChange={(e) => {
                setJumpQuery(e.target.value);
                setJumpIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setJumpIndex((i) => Math.min(i + 1, Math.max(jumpTargets.length - 1, 0)));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setJumpIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  void activateJump(jumpTargets[jumpIndex]);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeJump();
                }
              }}
            />
              <button
                className={`${styles.jumpScope} ${jumpEverywhere ? styles.jumpScopeOn : ""}`}
                onClick={toggleJumpEverywhere}
                role="switch"
                aria-checked={jumpEverywhere}
                title="Search cards in every map, not just this one"
              >
                <span className={styles.jumpScopeBox} aria-hidden="true">
                  {jumpEverywhere ? "✓" : ""}
                </span>
                All maps
              </button>
            </div>

            {jumpTargets.length === 0 ? (
              <p className={styles.jumpEmpty}>
                {jumpQuery ? "Nothing matches that." : "Start typing to find a map or a card."}
              </p>
            ) : (
              <ul className={styles.jumpList}>
                {jumpTargets.map((target, i) => (
                  <li key={`${target.kind}-${target.id}`}>
                    <button
                      className={`${styles.jumpRow} ${i === jumpIndex ? styles.jumpRowActive : ""}`}
                      data-jump-kind={target.kind}
                      onMouseEnter={() => setJumpIndex(i)}
                      onClick={() => void activateJump(target)}
                    >
                      <span className={styles.jumpKind}>
                        {target.kind === "map" ? "Map" : "Card"}
                      </span>
                      <span className={styles.jumpLabel}>
                        {target.kind === "map" ? target.name : target.text}
                      </span>
                      <span className={styles.jumpMeta}>
                        {target.kind === "map"
                          ? `${target.cards} card${target.cards === 1 ? "" : "s"}${
                              target.current ? " · open" : ""
                            }`
                          : target.mapId
                            ? `in ${target.mapName}`
                            : "in this map"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      {tiltStep !== "none" ? (
        <div className={`${styles.chrome} ${styles.tiltSetup}`} role="dialog" aria-label="Set up tilt">
          <p className={styles.tiltStepLabel}>
            {tiltStep === "neutral"
              ? "Hold the iPad however you're comfortable."
              : tiltStep === "right"
                ? "Now lean it the way you'd lean to look at the RIGHT of your map. Hold it there."
                : "Now lean it the way you'd lean to look BELOW your map. Hold it there."}
          </p>
          <p className={styles.tiltStepHint}>
            {tiltStep === "neutral"
              ? "This becomes level — everything is measured from here."
              : "Whatever you do defines that direction, so it can't come out backwards."}
          </p>
          <div className={styles.tiltStepActions}>
            <button className={styles.button} onClick={cancelTiltSetup}>
              Cancel
            </button>
            <button className={`${styles.button} ${styles.primary}`} onClick={captureTiltStep}>
              {tiltStep === "neutral" ? "This is level" : "Like this"}
            </button>
          </div>
          <span className={styles.tiltStepCount}>
            {tiltStep === "neutral" ? "1" : tiltStep === "right" ? "2" : "3"} of 3
          </span>
        </div>
      ) : null}

      {pasteOpen ? (
        <div className={styles.sheetBackdrop} onClick={closePaste}>
          <div
            className={`${styles.chrome} ${styles.sheet}`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Map JSON"
          >
            <header className={styles.sheetHeader}>
              <h2 className={styles.sheetTitle}>Map JSON</h2>
              <button className={styles.button} onClick={closePaste}>
                Close
              </button>
            </header>

            <div className={styles.pasteBody}>
              <textarea
                className={styles.pasteInput}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="Paste .canvas JSON here…"
                autoFocus
                spellCheck={false}
                aria-label="Canvas JSON"
              />

              <div className={styles.pasteStatus} aria-live="polite">
                {pasteResult === null ? (
                  <span className={styles.pasteHint}>
                    Paste a JSON Canvas file — the same format Save .canvas writes.
                  </span>
                ) : pasteResult.error ? (
                  <span className={styles.pasteError}>{pasteResult.error}</span>
                ) : (
                  <>
                    <span className={styles.pasteOk}>
                      {pasteResult.canvas!.nodes.length} card
                      {pasteResult.canvas!.nodes.length === 1 ? "" : "s"} ·{" "}
                      {pasteResult.canvas!.edges.length} link
                      {pasteResult.canvas!.edges.length === 1 ? "" : "s"}
                    </span>
                    {pasteResult.warnings.length ? (
                      <span className={styles.pasteWarning}>
                        {pasteResult.warnings.length} thing
                        {pasteResult.warnings.length === 1 ? "" : "s"} skipped: {pasteResult.warnings[0]}
                      </span>
                    ) : null}
                  </>
                )}
              </div>
            </div>

            <footer className={styles.sheetFooter}>
              <button className={styles.button} onClick={() => void copyCurrentJson()}>
                {copied ? "Copied" : "Copy this map"}
              </button>
              <div className={styles.pasteActions}>
                <button
                  className={styles.button}
                  onClick={pasteIntoThisMap}
                  disabled={!pasteResult?.canvas}
                >
                  Replace this map
                </button>
                <button
                  className={`${styles.button} ${styles.primary}`}
                  onClick={() => void pasteAsNewMap()}
                  disabled={!pasteResult?.canvas}
                >
                  Open as new map
                </button>
              </div>
            </footer>
          </div>
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
              <div className={styles.sheetHeaderActions}>
                <button
                  className={styles.button}
                  onClick={() => {
                    setLibraryOpen(false);
                    void openJump();
                  }}
                >
                  Search
                </button>
                <button className={styles.button} onClick={() => setLibraryOpen(false)}>
                  Done
                </button>
              </div>
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
                      <button
                        className={styles.button}
                        onClick={() => void pushCurrent(item)}
                        disabled={busyCloudId === item.id || cloudState === "off"}
                        title={
                          item.cloudId ? "Update the cloud copy" : "Copy this map to the cloud"
                        }
                      >
                        {busyCloudId === item.id ? "Pushing…" : item.cloudId ? "Push ↑" : "To cloud"}
                      </button>
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

            <div className={styles.cloudSection}>
              <div className={styles.cloudHeader}>
                <h3 className={styles.cloudTitle}>In the cloud</h3>
                <button
                  className={styles.button}
                  onClick={() => void refreshCloud()}
                  disabled={cloudState === "loading"}
                >
                  {cloudState === "loading" ? "Checking…" : "Refresh"}
                </button>
              </div>

              {cloudState === "off" ? (
                <p className={styles.cloudNote}>
                  Not set up on this deployment. Everything still works on this device.
                </p>
              ) : cloudState === "error" ? (
                <p className={styles.cloudError}>{cloudError}</p>
              ) : cloud.length === 0 ? (
                <p className={styles.cloudNote}>
                  Nothing here yet. Push a map up and your agents can read and write it.
                </p>
              ) : (
                <ul className={styles.mapList}>
                  {cloud.map((item) => (
                    <li key={item.id} className={styles.mapRow} data-cloud-id={item.id}>
                      <button
                        className={styles.mapOpen}
                        onClick={() => void openFromCloud(item)}
                        disabled={busyCloudId === item.id}
                      >
                        <span className={styles.mapName}>{item.name}</span>
                        <span className={styles.mapMeta}>
                          {item.nodes} card{item.nodes === 1 ? "" : "s"} · {item.edges} link
                          {item.edges === 1 ? "" : "s"} · {relativeTime(item.updated_at)}
                          {item.updated_by && item.updated_by !== "app"
                            ? ` · by ${item.updated_by}`
                            : ""}
                        </span>
                      </button>
                      <div className={styles.mapActions}>
                        <button
                          className={`${styles.button} ${styles.danger}`}
                          onClick={() => void removeFromCloud(item)}
                          disabled={busyCloudId === item.id}
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <footer className={styles.sheetFooter}>
              <button className={styles.button} onClick={() => void newCanvas()}>
                New map
              </button>
            </footer>
          </div>
        </div>
      ) : null}

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

/** What a doorway says under its name. */
function doorwaySubtitle(node: CanvasNode, sizes: Record<string, number>): string {
  const id = nestedCanvasId(node);
  if (!id) return "linked file";
  const size = sizes[id];
  return size === undefined ? "nested map" : `${size} card${size === 1 ? "" : "s"}`;
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

    const { a, b, c1, c2 } = edgeCurve(fromRect, fromSide, toRect, toSide);

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


