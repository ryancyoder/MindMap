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
| scribble over something | delete it — a card, or a connection on its own |
| short dab | select; dab again to edit |

Fingers do the rest: one finger drags a card if it starts on one and pans the
canvas if it doesn't, two fingers pinch-zoom, and a finger tap selects. Press
and hold before dragging and the card is copied instead of moved. Double-
tapping a card zooms to frame it; double-tapping away returns to the view you
came from, or fits the whole map if there isn't one. Two fingers double-tapped
undo; three redo. The
grip on a selected card's corner resizes it — the only control where pen and
finger do the same thing, so it is checked before either input branch.

**Pen mode is a deliberate exception.** The toggle in the bottom bar switches
the pen between drawing and pointing: in select mode it drags cards and lassoes
empty space instead of making them. Draw is the default and must stay so — a
tool switch is exactly the tax the gesture model exists to avoid — but
arranging a finished map is a different job from thinking one up, and lassoing
beats long-pressing twelve cards. Anything added to select mode must leave
draw mode untouched.

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

Connectors are hit-tested against **the same curve the renderer draws**
(`edgeCurve` / `sampleCurve` in `geometry.ts`), so what can be scribbled out is
exactly what can be seen. Keep those shared: they were separate once, and a
straight-line approximation misses any connector that bows away from it.

The scribble branch counts **cards and connectors**. Requiring a card meant
scribbling out a link on its own did nothing, leaving no way to remove a
connection without deleting a card — restored, and covered by
`verify-edges.mjs`.

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

## Zoom

Double-tap is a **finger gesture only**. The pen already uses a second tap to
open a card for text; taking that over would cost handwriting to buy
navigation, which is a bad trade on a device where the pen is the point.

`zoomBackRef` holds the view to return to and is set only on the way *in*, so
hopping between cards still returns to where you actually started rather than
to the previous card.

Only programmatic moves animate (`animateTransform`). Panning and pinching must
track the finger exactly — a transition there reads as lag, not polish — and
any new contact calls `cancelAnim()`, so direct manipulation always beats an
animation in flight.

## Selection

Selection is a **set** (`selectedIds`), not one id. Commands act on "the
selection" rather than "the selected card", which is what makes align, bulk
colour, multi-card drag and multi-delete fall out of one model instead of four
special cases. Keep it that way when adding commands.

Two ways to extend a selection, one per input mode: **shift-click** for a
keyboard, **long-press** (`LONG_PRESS_MS`) for a finger — the only free
single-finger gesture once tap, drag and double-tap were spoken for. Both
toggle, so the same gesture removes a card again. `longPressFiredRef` stops the
lift that follows a long press from also registering as a tap.

Dragging a card that is *in* the selection moves the whole selection; dragging
one that is not moves only it. The resize grip only appears when exactly one
card is selected, since resizing several at once has no obvious meaning.

**A long press also arms a copy.** Hold, then drag, and the originals stay put
while duplicates come away under the finger. The two meanings of the gesture do
not collide because different things settle them — lifting without moving
extends the selection, moving spends the copy — and nothing is duplicated until
the drag actually moves, so a long press that only selects still costs nothing.
The copies come from the set the drag recorded at press time, which is exactly
what a plain drag would have moved, and they replace the selection afterwards
because they are what the finger is now holding.

`src/lib/duplicate.ts` is pure and decides what a copy carries: fresh ids,
because an id is only unique within its map; edges **between** copied cards but
not edges to cards left behind, so a duplicated branch keeps its shape while a
copy inherits no claim on the original's connections; and everything else
verbatim, unknown keys included. A pen in select mode arms a copy the same way
but does not toggle the selection — that branch has already selected whatever
the pen came down on.

Alignment matches **both centres and size**: cards in a column all take the
widest width in the selection, so their left and right edges line up too.
Widest, never narrowest — narrowing a card would clip text that is already
written. Align aims at the centre of the selection so the group stays put
rather than sliding toward whichever card happens to be first.

**Snap-to-grid** (`GRID`, mirroring the dot grid in the stylesheet) applies
while dragging and resizing, and to newly drawn cards. Drags therefore record
each card's origin and position **absolutely** from the pointer's total
displacement — accumulating per-frame deltas makes a snapped card creep,
because each frame re-snaps an already-snapped value.

## Multi-finger gestures

Undo and redo live on two- and three-finger double-taps because one finger is
already busy selecting, dragging and zooming. Their danger is false positives,
not misses: a pinch that barely moves must never quietly undo work. Three
guards prevent that — the whole gesture must finish inside `MULTI_TAP_MAX_MS`,
no finger may travel past `TAP_SLOP_PX`, and **movement is measured from where
each finger landed**, not from the previous frame, because slow drift hides
under a per-frame delta.

`handleMultiTap` fires above where `doUndo`/`doRedo` are declared, so it
reaches them through refs rather than reordering the file around one gesture.

## Tilt to pan

Tilting the iPad pans the canvas, for when the hand that would pan is holding
the pen. Off by default and behind a toggle, because a canvas that drifts
whenever you shift in your chair is worse than no feature.

**The sensor-to-screen mapping is calibrated by demonstration, and that is the
design — do not replace it with a derived one.** Getting it from first
principles means being right about all of: the sign of `beta`, the sign of
`gamma`, how both rotate with `screen.orientation.angle`, how the device is
being held, and whether "tilt right" should move the view or the content. Each
is a coin flip. A derived version got several wrong at once — axes swapped and
signs inverted — and passed its tests, because those tests checked the
convention against itself.

The user leans once per direction and whatever they do defines it. Orientation,
sensor conventions and holding style are all baked into two vectors; the pan is
just the offset from neutral projected onto each. `verify-tilt.mjs` proves the
point by running the same checks on two simulated devices whose sensors work in
opposite directions — a hard-coded mapping can pass one, never both.

Two things it must keep doing:

- **Stand down while a pointer is busy** — mid-stroke, mid-drag, mid-pinch. A
  canvas sliding under a stroke ruins the stroke. It also stands down during
  calibration, or the canvas slides out from under the thing being taught.
- **Run on `requestAnimationFrame`**, not on sensor readings: readings arrive
  at whatever rate the hardware likes, and panning has to be frame-rate
  independent.

iOS only grants motion access from a user gesture, which is why
`requestTiltPermission` is called from the toggle's click handler and nowhere
else. Calibration is saved, so it is asked for once.

## Chrome layout

Both bottom bars live in **one wrapping dock** (`.bottomDock`), not as two
independently positioned elements. They were independent once, and adding two
buttons to the left bar pushed it underneath the right one in portrait, hiding
the zoom control on every narrow screen. As flex children of a wrapping row
they stack instead of colliding, at any width.

The dock itself is `pointer-events: none` with its children `auto`, so the gaps
between the bars stay drawable rather than becoming a dead strip across the
bottom of the canvas.

**Add a control to either bar and run `verify-layout.mjs`.** It checks four
device sizes; the rest of the suite runs at one wide desktop viewport where
this class of bug cannot appear.

## Jump palette

⌘K opens a palette over everything: maps first, then cards in the map currently
open. Matching is by **subsequence, not substring** (`src/lib/search.ts`), so
"pgest" finds "Pencil gestures" — a palette is for typing what you remember.
Scoring favours consecutive letters and letters at word starts.

**iPadOS refuses `focus()` for a moment after a metaKey combination**, and in a
standalone PWA that moment can outlast the animation frame — so ⌘K can open a
palette that swallows everything you type. A capture-phase `keypress` listener
routes stray characters into the query by hand. Do not remove it; the same
workaround is documented in VoiceMap for the same reason.

⌘K is handled **before** the "are we typing" guard in the key handler, so it
works from inside a field and can close the palette it opened.

The **All maps** toggle widens card results from the open map to every map.
That costs nothing: the library already holds every document in memory by the
time the palette opens, so it is a different filter over data already loaded,
not extra reading. Jumping to a card elsewhere switches map first and sets the
view outright rather than animating — easing from the previous map's scroll
position reads as drift, not motion.

**Escape and ⌘K are handled globally, not on the palette's input.** Tapping the
scope toggle moves focus to a button, and Escape bound to the input alone
stopped closing the palette entirely. The toggle also hands focus back to the
query, or the next keystroke goes nowhere.

The Maps sheet has a Search button opening the same palette, because ⌘K needs a
keyboard and this is an iPad app first.

## Nested maps

A card can be a doorway into another map. It is a spec `file` node whose `file`
is a `.canvas` path, so Obsidian and anything else reading the format see an
ordinary file card — nothing invented. The library id rides alongside in
`NESTED_ID_KEY`, because resolving by name breaks on a rename or a duplicate,
and extras survive round trips.

**Fold** moves a selection into a map of its own and leaves a doorway. Edges
that crossed the boundary are rewired onto the doorway, so nothing is orphaned,
and **which sub-map card each of those edges came from is recorded** in
`NESTED_PORTS_KEY`. That is what makes unfolding restore the original wiring
instead of guessing — without it, everything reattaches to whatever card is
first, and folding quietly loses information.

Unfolding renames every incoming id. Sub-map ids are only unique within that
map and would otherwise collide with the parent's.

The fold/unfold logic in `src/lib/nesting.ts` is pure — it takes documents and
returns documents. Keep it that way; the caller owns creating library records.

**Buttons drawn on a card need `data-card-action`**, which exempts them in
`onPointerDown`. Without it the surface captures the pointer, `pointerup` is
retargeted, and the click never reaches the button — which is exactly how the
doorway's Open button failed the first time.

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

Four bugs shipped past a fully green suite. Three fed the app something a hand
never produces — trusted mouse events instead of pen events, geometrically
perfect circles instead of shaky ones, 1px-wide touch contacts instead of real
fingertips. The fourth rendered it at a size nobody holds: every suite ran at
one wide desktop viewport, so two bars colliding in portrait went unseen.

When adding a check, ask what it feeds the app, whether a hand could produce
it, and what shape of screen it is looking at.

## Cloud library (v2)

Maps live in Supabase in `mindmap_canvases` / `mindmap_nodes` / `mindmap_edges`,
**normalised** rather than as one JSON blob — the whole point is that an agent
can update a single card without reading and rewriting the document.

Every table carries an `extra` jsonb for attributes this schema does not model,
because JSON Canvas lets applications add their own keys and dropping them
would corrupt another tool's data on a round trip. That guarantee already holds
in `jsoncanvas.ts`; the schema keeps it true through the database.

For agents:

```sql
select * from mindmap_canvas_list();                  -- every map
select mindmap_canvas_doc('<uuid>');                  -- one map as .canvas JSON
select mindmap_save_canvas('<doc>'::jsonb, 'Name', '<uuid or null>', 'agent-name');
select mindmap_delete_canvas('<uuid>');               -- soft delete
update mindmap_nodes set text = '...' where canvas_id = '<uuid>' and id = '<node id>';
```

`mindmap_save_canvas` is a **whole-document replace** — it deletes and reinserts
the map's rows, so it will clobber a concurrent row-level edit. Surgical
changes should UPDATE the row; that is what the normalised shape is for.
Malformed cards and dangling edges are skipped rather than failing the save,
matching how the parser treats a malformed file.

Editing a single card bumps its canvas's `updated_at` via trigger, so polling
one column is enough to know whether anything changed.

RLS is enabled with **no policies**, matching every other table in that
project: the service-role key is the only way in, it lives in
`SUPABASE_SERVICE_ROLE_KEY` on the server, and the browser never holds a
database credential — `src/lib/supabaseServer.ts` is server-only and its
variables are deliberately not `NEXT_PUBLIC_`.

Cloud sync is optional throughout. Unset the variables and every route returns
503, the UI says so, and the app is exactly what it was before.

## Status

v1 is the drawing surface: local-first, no server, no account. The canvas
library lives in IndexedDB; `.canvas` files move in and out by file picker and
download.

v2 is the cloud library above: push a map up from the Maps sheet, open one back
down, and agents read and write it in between.

Planned, deliberately not built yet:

- **v3** — in-app AI operations (expand a node into children, cluster loose
  nodes, critique a map), with the Anthropic key server-side in a route
  handler, never in the browser.
- Automatic sync. Today pushing and pulling are explicit, which is honest about
  conflicts: nothing merges, the newer push wins. Real two-way sync needs a
  merge story before it is worth building.
