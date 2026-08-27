# MindMap

Draw mind maps with an Apple Pencil. Reads and writes open
[JSON Canvas](https://jsoncanvas.org) `.canvas` files — the same format
Obsidian Canvas uses.

Built for iPad Safari, installed to the home screen. Works in any modern
desktop browser too, where the mouse stands in for the pen.

## Why the file format matters

`.canvas` is the bridge. A map drawn by hand on the iPad is a plain JSON file,
so an AI can read what you sketched and hand back a map you can keep drawing
on. Nothing is locked in an app-specific database.

## Drawing

There is no tool palette. The shape of the stroke says what you meant:

| Draw this | Get this |
|---|---|
| a circle | a new card, ready for text |
| a line out of a card | a new card there, joined to it |
| a line between two cards | a link |
| a scribble over something | it's deleted — a card, or just the line between two |
| a quick dab | select it; dab again to type |

**The pen draws. Fingers navigate.** One finger pans, two pinch to zoom, and
the pen never pans — so you can rest your hand on the glass while you draw.
Drag a card with a finger to move it, and double-tap one to zoom in on it;
double-tap the empty canvas to come back out.

**Draw / Select** switches what the pen does. In Select it drags cards and
lassoes an area to select everything it touches — useful when you are arranging
a finished map rather than thinking one up. **Snap** locks moving and resizing
to the grid. **Tilt** lets you pan by tilting the iPad, so you can move around the canvas
without putting the pen down. The first time, it asks you to lean the iPad once
for "right" and once for "down" — whatever you do defines those directions, so
they can't come out backwards. It stops while you're drawing, and ⟳ teaches it
again if you change how you hold it.

Text goes in with **Scribble**: the card opens a real text field, so you
handwrite into it with the Pencil and never see a keyboard.

**Hold a finger on a card** to add it to the selection (shift-click on a
keyboard), then move them together, or line them up with **Column**, **Row**
and **Space** — Column and Row also match the cards' size, so their edges are
flush, never just their centres. ⌘A takes everything.

**Two fingers double-tapped undo. Three redo.** Undo is also ⌘Z, and every gesture is undoable — which is the honest answer to a
recognizer that occasionally reads a stroke wrong.

Cards grow to fit what you write, so a long thought is never clipped. Drag the
corner grip on a selected card to size it by hand; a card you enlarge stays
that way.

## Pictures

**Photo** puts a picture on the map. On an iPad that button offers the camera,
the photo library, or a file — one control, because taking a photo of the thing
you are mapping and finding one you already took are the same job.

With a card selected the picture goes **on that card**, under whatever it says.
With nothing selected it becomes **a card of its own**, shaped like the photo,
and you can caption it by tapping it again. Dropping a picture onto the canvas
does the same thing, and drops it onto a card if you aim at one; ⌘V pastes a
screenshot the same way. **No photo** takes it off again, and undo puts it back.

Pictures are resized on the way in — 1600px on the long edge — so a map full of
them stays a few megabytes rather than a few hundred. They are stored beside
the map rather than inside the `.canvas` file, which keeps the file readable
text you can paste into a conversation. A map that travels as JSON therefore
travels without its pictures, and says so on the cards that had one.

## Files

Maps autosave to the browser on the device, and **Maps** lists everything
you've made — switch, rename or delete from there. **New** starts a fresh map
without abandoning the one you were on.

**Open** loads a `.canvas` file from Files or iCloud Drive; **Save .canvas**
downloads the current map back out. **JSON** does the same thing as text —
paste a map straight in, or copy the current one to the clipboard, which is how
you hand a map to an AI and get one back. Pasted JSON is checked as you type
and tells you what it contains before you apply it. Files from other apps round-trip without
losing their data — including attributes MindMap itself doesn't use.

## Running it

```bash
npm install
npm run dev      # http://localhost:3000
```

Checks, all of which must be clean before pushing:

```bash
npm run typecheck
npm run lint
npm run build
```

Behavior is verified by driving the real app in a browser — see
[`scripts/README.md`](scripts/README.md).

## Finding things

**⌘K** jumps to anything: type a few letters of a map's name to switch to it,
or a few letters of a card to select and zoom to it. It matches loosely, so
"pgest" finds "Pencil gestures".

Cards come from the map you're on by default. Tick **All maps** and it searches
every map you have — results say which map each card is in, and picking one
takes you there with the card selected. Without a keyboard, the same palette is
behind **Search** in the Maps sheet.

## When a map gets too big

Select a branch and hit **Fold**: those cards move into a map of their own and
leave a single doorway card behind, still connected to whatever they were
connected to. Tap **Open ↗** to walk in; the trail at the top walks you back.
**Unfold** brings everything back out, wired the way it was.

The doorway is an ordinary JSON Canvas file node, so a folded map still opens
in Obsidian — the doorway just appears there as a file card.

## The cloud library

If the deployment has Supabase configured, the Maps sheet grows an **In the
cloud** section. Push a map up and it becomes readable and writable by your
agents; open one back down to keep working on it here. The listing shows who
touched each map last, so an agent's edits are visible as theirs.

Pictures go up and come back down with the map they are on, so a photo taken on
the iPad is there when an agent reads the map — and a push only sends the ones
the cloud does not already have.

Nothing syncs automatically — pushing and pulling are things you do — which
keeps the conflict story honest: the newer push wins, and nothing merges behind
your back.

Without Supabase configured the app is unchanged: everything lives on the
device and the cloud section says so.

## Status

v1 is the drawing surface, and it runs entirely on the device: no server, no
account, no sync. A cloud library and in-app AI operations are planned; see
`AGENTS.md` for what's deliberately not built yet.
