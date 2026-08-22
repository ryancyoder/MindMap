<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# MindMap

A web app for drawing mind maps with Apple Pencil, built around the open
[JSON Canvas](https://jsoncanvas.org) `.canvas` format. Primary target is iPad
Safari, installed to the home screen as a PWA.

The point of the file format is the point of the app: `.canvas` is the bridge
between drawing by hand and working with an AI. What you draw on the iPad is a
plain JSON file that Claude, Obsidian, or anything else can read and write.

## Shape of the code

Conventions follow VoiceData: a page directory holds `page.tsx` +
`XClient.tsx` + `x.module.css`, and shared logic lives under `src/lib` behind
the `@/` alias.

```
src/app/page.tsx           server component; hands off to the client
src/app/CanvasClient.tsx   the whole editor: pointer routing, render, chrome
src/app/canvas.module.css  editor styles
src/lib/jsoncanvas.ts      the ONLY module that knows the .canvas format
src/lib/geometry.ts        stroke math, hit tests, edge anchoring
src/lib/recognize.ts       stroke -> intent (the pen model lives here)
src/lib/store.ts           IndexedDB canvas library, localStorage last-opened
src/lib/history.ts         undo/redo by snapshot
```

## The pen model

There is no tool palette, and adding one would be a regression. The user never
selects a mode; the shape of the stroke says what they meant:

| Stroke | Result |
|---|---|
| closed loop | new text node at its bounds, opened for text |
| line out of a node into space | new node there, joined by an edge |
| line between two nodes | an edge |
| scribble over something | delete it and any edges touching it |
| short dab | select; dab again to edit |

**Pen draws, finger navigates.** That split is what makes palm rejection free:
a resting palm is a touch pointer, and touch can only pan or zoom. `pointerType`
routes every event, and a pen-priority window (`PEN_PRIORITY_MS`) locks touch
out for a beat around each stroke so a palm landing late cannot pan mid-word.

Recognizer thresholds live in one exported `RECOGNIZER` object in
`src/lib/recognize.ts`. Tune there, not at call sites.

## Rules that are load-bearing

1. **Unknown keys survive.** `parseCanvas`/`serializeCanvas` preserve
   attributes they do not understand, at node, edge, and top level. Dropping
   them would silently delete another app's data on a round trip.
2. **Geometry is written as integers**, because the spec types it that way.
   Pointer input is float; `serializeCanvas` rounds.
3. **Coordinates are world-space everywhere** except the ink canvas. Convert
   once, at the pointer event, via `toWorld`.
4. **Pointer handlers read refs, not state.** They fire at pointer rate and
   must not be rebuilt per render. React 19's lint rules forbid writing refs
   during render, so a single effect syncs them after each commit.
5. **`touch-action: none`** on the drawing surface, `auto` on the node
   textarea — that exception is what lets iPadOS Scribble write into a card.
6. **Text entry is a real `<textarea>`.** Do not replace it with a custom
   editor; Scribble only works in native fields, and it is the whole reason
   handwriting works without a keyboard.

## Checks

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run build       # next build (Turbopack)
```

There is no unit test framework. Behavior is verified by driving the real app
in a browser — see `scripts/README.md`. Run those after any change to the
recognizer or the format module.

## Status

v1 is the drawing surface: local-first, no server, no account. The canvas
library lives in IndexedDB; `.canvas` files move in and out by file picker and
download.

Planned, deliberately not built yet:

- **v2** — cloud canvas library in Supabase behind server routes, so agents can
  read and write maps without a manual export.
- **v3** — in-app AI operations (expand a node into children, cluster loose
  nodes, critique a map), with the Anthropic key server-side in a route
  handler, never in the browser.

`.env.example` lists the variables those will use. Nothing reads them today.
