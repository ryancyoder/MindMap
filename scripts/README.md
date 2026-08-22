# Verification

There is no unit test framework here. The things most worth checking — does a
drawn circle become a card, does a file survive a round trip — are only true in
a real browser, so they are checked by driving one.

These scripts need Playwright, which is **not** a dependency of this project.
Use a globally installed copy, or `npx`:

```bash
npm run build && npm run start &          # serve the app on :3000

node scripts/verify-gestures.mjs          # the pen model
node scripts/verify-pen-input.mjs         # pen event capture
node scripts/verify-recognizer.mjs        # realistic hand-drawn shapes
node scripts/verify-touch.mjs             # pan, pinch, dragging cards
node scripts/verify-roundtrip.mjs         # .canvas fidelity
```

Both exit non-zero on failure, so they can be chained in CI later.

Options, via environment variables:

- `BASE_URL` — defaults to `http://localhost:3000`
- `PLAYWRIGHT_MODULE` — path to Playwright's entry, if it isn't resolvable
- `CHROMIUM_PATH` — explicit browser binary, if Playwright can't find one

## What they cover

`verify-gestures.mjs` drives the surface with synthetic strokes and asserts the
document that comes out: a loop makes one node, a stroke out of a node makes a
node *and* an edge, a stroke between nodes makes only an edge, a scribble
deletes the node and the edges touching it, and undo puts it all back. It then
reads the persisted canvas out of IndexedDB and checks it is valid JSON Canvas
with no dangling edges.

`verify-roundtrip.mjs` loads a `.canvas` file containing all four node types,
both color forms, edge labels and ends, and unknown keys at node and top level
— then asserts every one of them survived. This is the guarantee that lets a
file move between MindMap, Obsidian, and an AI without losing anything.

`verify-pen-input.mjs` guards the input path itself, which the other two do not
reach. They drive the app with Playwright's mouse, and those are *trusted*
events where Chromium populates `getCoalescedEvents()`. Safari and synthetic
events return an empty array instead — and code that trusted that array without
a fallback captured zero points from every stroke, so the app looked completely
dead on an iPad while every mouse-driven check passed. This script dispatches
`pointerType: "pen"` events with an empty coalesced list, and first asserts the
list really is empty, so a pass proves the fallback works rather than proving
the environment happened to be friendly.

`verify-recognizer.mjs` covers stroke *shape*, and exists for the same reason
in a different disguise. The earlier checks drew mathematically perfect
circles. A real Apple Pencil records hand tremor, and the recognizer counted
sharp corners to spot a scribble — so tremor on an ordinary circle registered
fourteen corners, the stroke was classified as crossing-out, and a crossing-out
over empty canvas did nothing at all. Ink appeared and no card did. The strokes
here wobble, leave gaps, double back, and run short of samples.

`verify-touch.mjs` covers the finger. Touch went untested until it broke on
hardware: the palm filter rejected any contact wider than 45px, and iOS reports
an ordinary fingertip on an iPad at 40-60px, so pan and pinch did nothing at
all — while synthetic tests passed, because a synthetic PointerEvent defaults
to `width: 1`. The 50px-wide contact case is the one that matters; keep it.

The lesson generalizes three times over: when a check drives the app through a
different input path than the user does, or feeds it idealized input the user
cannot produce, a green suite says nothing about the user's experience.

None of these cover palm rejection or pressure, which need real touch and pen
hardware — test those on an iPad by hand.
