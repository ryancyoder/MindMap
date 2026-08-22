# Verification

There is no unit test framework here. The things most worth checking — does a
drawn circle become a card, does a file survive a round trip — are only true in
a real browser, so they are checked by driving one.

These scripts need Playwright, which is **not** a dependency of this project.
Use a globally installed copy, or `npx`:

```bash
npm run build && npm run start &          # serve the app on :3000

node scripts/verify-gestures.mjs          # the pen model
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

Strokes are dispatched as mouse events, which the app treats as pen input. That
covers the recognizer and everything downstream of it. It does **not** cover
palm rejection or pressure, which need real touch and pen hardware — test those
on an iPad by hand.
