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
| a scribble over something | it's deleted |
| a quick dab | select it; dab again to type |

**The pen draws. Fingers navigate.** One finger pans, two pinch to zoom, and
the pen never pans — so you can rest your hand on the glass while you draw.

Text goes in with **Scribble**: the card opens a real text field, so you
handwrite into it with the Pencil and never see a keyboard.

Undo is ⌘Z, and every gesture is undoable — which is the honest answer to a
recognizer that occasionally reads a stroke wrong.

Cards grow to fit what you write, so a long thought is never clipped. Drag the
corner grip on a selected card to size it by hand; a card you enlarge stays
that way.

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

## Status

v1 is the drawing surface, and it runs entirely on the device: no server, no
account, no sync. A cloud library and in-app AI operations are planned; see
`AGENTS.md` for what's deliberately not built yet.
