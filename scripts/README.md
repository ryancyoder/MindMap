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
node scripts/verify-library.mjs           # card sizing and the map library
node scripts/verify-paste.mjs             # pasting and copying map JSON
node scripts/verify-doubletap.mjs         # double-tap to zoom
node scripts/verify-multitouch.mjs        # two/three-finger undo and redo
node scripts/verify-multiselect.mjs       # multi-select, align, bulk move
node scripts/verify-copy.mjs              # long-press to copy a card
node scripts/verify-bookmark.mjs          # pasting a link, and the route that fetches it
node scripts/verify-arrange.mjs           # snap, edge alignment, pen select mode
node scripts/verify-layout.mjs            # chrome layout at real device sizes
node scripts/verify-edges.mjs             # deleting a connection
node scripts/verify-nesting.mjs           # folding a branch into its own map
node scripts/verify-jump.mjs              # the Cmd-K jump palette
node scripts/verify-tilt.mjs              # tilt-to-pan maths and interaction
node scripts/verify-cloud.mjs             # cloud library (skips if unconfigured)
node scripts/verify-images.mjs            # pictures on cards
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

`verify-library.mjs` covers card sizing and the map library. Its important
checks are the losing ones — that "New" does not strand the map you were on,
that switching maps keeps an edit made a moment earlier (autosave is debounced,
so that is a real race), and that deleting the open map leaves something open.

`verify-paste.mjs` covers JSON in and out. Its useful checks are the unhappy
ones: malformed input has to say so rather than destroy the open map, a
partly-broken file has to open with what survived and report what it dropped,
and replacing a map has to stay one undo away.

`verify-doubletap.mjs` covers double-tap zoom, and most of its checks are
negative: taps that are too slow, too far apart, on different targets, or that
followed a pan must NOT pair. A gesture recognizer is judged by what it
declines as much as by what it catches — an over-eager double-tap would fire
while you were simply working.

`verify-multitouch.mjs` covers the undo and redo gestures, and its risk is
false positives rather than misses — a pinch that barely moves must never
quietly undo your work. It therefore checks a drifting two-finger gesture, a
slow two-finger rest, mismatched finger counts, and a one-finger double-tap,
all of which must decline.

Note when reading its expectations: creating a card and committing its text are
**two** history entries, so a card typed into costs two undos. An earlier
version of this file counted them as one and looked like an off-by-one in the
app.

`verify-multiselect.mjs` covers both ways into a multi-selection — shift-click
and long-press — and the commands it unlocks. Alignment is checked on centres
rather than edges, and each command is checked to be a single undo rather than
one per card.

`verify-copy.mjs` covers long-press-to-copy, which shares a gesture with
long-press-to-select — so it has to prove the two halves stay separate: a plain
drag still moves, a long press that goes nowhere still extends the selection and
copies nothing, and only a press followed by movement duplicates. Its careful
case is copying a connected pair, where the edge between the copies has to come
along and no edge may straddle a copy and an original.

It also holds the checks that only matter once pictures and bookmarks are in
the same app: that a photo put on a bookmark card replaces the fetched picture
rather than adding a second one, and that a paste carrying both a picture and
its address — which is what copying from a web page gives you — leaves one card
behind rather than one of each.

`verify-bookmark.mjs` covers link cards in two halves. The card is checked in
the browser with the preview route stubbed, because a suite that fetches a real
website fails on the day that website is slow rather than on the day this code
is wrong. The route's own checks are the refusals, and they are the ones that
matter: it takes a URL from the user and asks the network for it, from a server
sitting next to a service-role key, so loopback, the private ranges, the
link-local block cloud providers keep credentials on, and non-web schemes all
have to come back refused.

`verify-cloud.mjs` drives the cloud library through the app's own routes. It
needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` and **skips cleanly** when
they are absent, because a deployment without cloud sync is a working app
rather than a broken one. It writes and then removes its own map, and touches
nothing else.

`verify-arrange.mjs` covers snap-to-grid, edge-matching alignment, and the
pen's select mode. Its most important check is the last one: switching back to
Draw has to leave the recognizer exactly as it was, because a mode that leaks
is worse than no mode.

`verify-layout.mjs` checks the chrome at four device sizes. It exists because
of a regression every other suite missed: two extra buttons pushed the bottom
bar underneath the selection bar in portrait, hiding the zoom control. Nothing
failed, because every other suite runs at one wide desktop viewport and the
collision cannot happen there. **Add anything to a bar and run this.**

`verify-edges.mjs` covers removing a connection. That regressed once: the
scribble branch required a *card* to be crossed, so scribbling out a link on
its own did nothing, and there was no way to delete a connection at all except
by deleting one of the cards it joined. Its bowed-connector check is the one
that matters — hit-testing samples the same curve the renderer draws, and a
straight-line approximation passes the first check while failing that one.

`verify-tilt.mjs` runs the same checks on **two simulated devices whose sensors
work in opposite directions**, because the mapping is calibrated by
demonstration rather than derived. A hard-coded mapping can pass one of those,
never both. The first version was derived, passed its tests, and was wrong on
real hardware — axes swapped, signs inverted — because those tests checked the
convention against itself rather than against a device.

The sensor and the iOS permission prompt cannot be driven here, and whether the
gain and dead zone feel right has to be judged in the hand.

`verify-nesting.mjs` covers folding and unfolding. Two of its checks carry the
weight: that no edge dangles after either operation, and that unfolding
restores the **original** wiring rather than reattaching everything to
whichever card happens to be first. An early version of the suite also had
parent and sub-map with identical card counts, so "it navigated" passed
without navigating — the maps are now told apart by their contents.

`verify-jump.mjs` covers the palette. Its most valuable check simulates the
iPadOS focus quirk: it blurs the input after opening and then types, asserting
the characters still reach the query. Safari refuses `focus()` for a moment
after a metaKey combination, so ⌘K can open a palette you cannot type into —
which looks exactly like the feature not working at all.

It also covers the **All maps** scope toggle, including the bug that found:
Escape was bound to the palette's input, so tapping the toggle moved focus to a
button and Escape stopped closing the palette. Escape and ⌘K are global now.

The lesson generalizes four times over: when a check drives the app through a
different input path than the user does, feeds it idealized input the user
cannot produce, or renders it at a size the user never holds, a green suite
says nothing about the user's experience.

`verify-images.mjs` covers pictures, and its first assertion is about its own
input: it generates a JPEG at 3024x4032 and checks the file really is megabytes
before checking what became of it. A 1x1 test pixel would satisfy every other
line in the file while proving nothing about the resize that keeps a map's rows
a sane size — which is the same mistake the perfect-circle strokes made.

Its other load-bearing check looks at the document rather than the screen: the
persisted `.canvas` must contain no image data at all. A picture is stored beside
the map precisely so the file stays readable text, and a regression that inlined
it would look perfect in the browser.

The rest is the two ways in and the ways a card can move: a picture onto a card
keeps that card's words, folding and unfolding keep it attached through renamed
ids, and taking it off is one undo away — with the blob still on the device, so
undo restores the picture and not just the reference to it.

None of these cover palm rejection or pressure, which need real touch and pen
hardware — test those on an iPad by hand.
