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

Fingers do the rest: one finger drags a card if it starts on one and pans the
canvas if it doesn't, two fingers pinch-zoom, and a finger tap selects. The
grip on a selected card's corner resizes it — the only control where pen and
finger do the same thing, so it is checked before either input branch.

**Pen draws, finger manipulates.** That split is what makes palm rejection
free: a resting palm is a touch pointer, and touch never draws. `pointerType`
routes every event, and a pen-priority window (`PEN_PRIORITY_MS`) locks touch
out for a beat around each stroke so a palm landing late cannot pan mid-word.

Contact-size palm rejection (`PALM_CONTACT_PX`) applies **only** within
`PALM_WINDOW_MS` of real pen contact. iOS reports an ordinary fingertip on an
iPad at 40-60px, so filtering by size unconditionally rejected every
navigation touch and made pan and pinch appear missing. Do not widen that
filter back to all touches.

Recognizer thresholds live in one exported `RECOGNIZER` object in
`src/lib/recognize.ts`. Tune there, not at call sites.

**Shape is judged by compactness (`4·π·area / length²`), not by counting
corners.** A hand-drawn circle scores around 0.8; a scribble scores 0.00. An
earlier version counted sharp direction changes, which failed in both
directions: hand tremor added corners to circles, and smoothing removed them
from genuine zigzags, so the same scribble registered six corners at one size
and zero at another. Compactness is scale-invariant and measures the property
that actually separates "went around something" from "crossed it out". Do not
reintroduce corner counting.

Raw points are what get inked; recognition sees a smoothed, simplified copy.
Keep it that way — smoothing the ink would make strokes feel laggy and dead.

## Card sizing

Cards grow to fit their text when an edit is committed, and never shrink — so a
card you deliberately enlarged stays enlarged. Height comes from
`measureTextHeight`, which lays the text out in a real off-screen element
rather than estimating, because wrapping depends on the actual font.

`CARD_PADDING_X/Y` and `CARD_BORDER` mirror `canvas.module.css`. **If you change
the card's padding or border in CSS, change them here too** — they were 3px
apart once and that was enough to clip a whole wrapped line on a narrow card.

## JSON in and out

`JSON` opens a sheet that pastes a map in or copies the current one out as
text. It runs the **same `parseCanvas`** as the file picker, so anything that
opens as a file opens as a paste — do not add a second, more lenient parser
here. Input is validated as it is typed and the apply buttons stay disabled
until it parses, so a bad paste can never reach the document. "Replace this
map" goes through `applyDoc`, which keeps it one undo away.

Text, not files, is how a map travels to and from a conversation. That is the
whole point of this surface and of the v2 cloud library that will replace it
for agents.

## The map library

IndexedDB holds every map; `voicemap`-style last-opened lives in localStorage.
Autosave is debounced, so **anything that leaves the current canvas must call
`flushSave()` first** — `openLibrary`, `switchTo`, and `newCanvas` all do.
Without it, switching maps within a second of an edit silently lost that edit,
which is the exact failure the library exists to prevent.

Deleting the open map must leave another one open, creating a blank one if it
was the last.

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

Three bugs shipped past a fully green suite, all because the checks fed the app
something a hand never produces: trusted mouse events instead of pen events,
geometrically perfect circles instead of shaky ones, and 1px-wide touch
contacts instead of real fingertips. When adding a check, ask what it feeds the
app and whether a hand could produce it.

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
