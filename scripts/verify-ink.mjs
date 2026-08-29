// Writing and sketching inside a card with the pen.
//
// The thing worth checking is the boundary, not the drawing. A pen stroke over
// a card already means something — a scribble deletes it, a loop makes a new
// card, a line to another card joins them — so ink cannot also be the default
// reading of a stroke. A card is opened for ink the way it is opened for text,
// and these checks are mostly about that door: that nothing changes while it is
// shut, that strokes inside it are kept rather than recognized, and that
// leaving is one gesture and gives the pen straight back to the map.
//
// It drives pen events with an empty coalesced list, for the reason
// verify-pen-input.mjs exists: Chromium fills that list for trusted mouse
// events and Safari does not, and a check driven by the mouse proves nothing
// about an iPad.

import { BASE_URL, launchBrowser, makeChecker, readPersistedCanvas } from "./_harness.mjs";

const { check, finish } = makeChecker();

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

/** Pen events with an empty coalesced list, the way a real Pencil arrives. */
const pen = (events) =>
  page.evaluate((evs) => {
    const surface = document.querySelector('[class*="surface"]');
    for (const e of evs) {
      const event = new PointerEvent(e.type, {
        pointerId: 7, pointerType: "pen", isPrimary: true,
        clientX: e.x, clientY: e.y, width: 2, height: 2,
        pressure: e.type === "pointerup" ? 0 : 0.6, bubbles: true, cancelable: true,
      });
      event.getCoalescedEvents = () => [];
      surface.dispatchEvent(event);
    }
  }, events);

const stroke = async (points) => {
  await pen([
    { type: "pointerdown", x: points[0][0], y: points[0][1] },
    ...points.slice(1).map(([x, y]) => ({ type: "pointermove", x, y })),
    { type: "pointerup", x: points[points.length - 1][0], y: points[points.length - 1][1] },
  ]);
  await page.waitForTimeout(300);
};

/** A hand-drawn loop: the app's own way of making a card. */
const circle = async (cx, cy, r) => {
  const points = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    // A little tremor, because a real hand has some and the recognizer is
    // tuned for strokes that do.
    const wobble = r + Math.sin(i * 1.7) * 1.2;
    points.push([cx + Math.cos(a) * wobble, cy + Math.sin(a) * wobble]);
  }
  await stroke(points);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(450);
};

const cards = () => page.locator("[data-node-id]").count();
const isInking = async () => (await page.locator('[class*="sketchNode"]').count()) > 0;

/** Open the card for writing, if it is not already. The button is a toggle. */
const ensureInking = async () => {
  if (await isInking()) return;
  await page.locator("[data-node-id]").first().click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Ink", exact: true }).click();
  await page.waitForTimeout(250);
};
const inkPaths = () => page.locator('[class*="inkLayer"] path').count();
const box = async (i) => page.locator("[data-node-id]").nth(i).boundingBox();

await circle(320, 300, 90);
check("a loop still makes a card", await cards(), 1);

// ── with the door shut, the pen model is untouched ────────────────────────

const first = await box(0);
await stroke([
  [first.x + 20, first.y + 20],
  [first.x + first.width - 20, first.y + first.height - 20],
  [first.x + 20, first.y + first.height - 20],
  [first.x + first.width - 20, first.y + 20],
  [first.x + 20, first.y + 30],
]);
check("a scribble over a card still deletes it", await cards(), 0);
await page.keyboard.press("Control+z");
await page.waitForTimeout(400);
check("and undo brings it back", await cards(), 1);
check("nothing has been inked", await inkPaths(), 0);

// ── opening the card ──────────────────────────────────────────────────────

await page.keyboard.press("Escape");
await page.waitForTimeout(150);
await page.locator("[data-node-id]").first().click();
await page.waitForTimeout(250);
await page.getByRole("button", { name: "Ink", exact: true }).click();
await page.waitForTimeout(250);
check("the card says it is open for writing", await page.locator('[class*="sketchNode"]').count(), 1);

const open = await box(0);
await stroke([
  [open.x + 30, open.y + 40],
  [open.x + 55, open.y + 70],
  [open.x + 80, open.y + 35],
  [open.x + 105, open.y + 72],
]);
check("a stroke inside it becomes ink", await inkPaths(), 1);
check("and makes no new card", await cards(), 1);

// The stroke that would have deleted the card now writes on it instead.
await stroke([
  [open.x + 30, open.y + 100],
  [open.x + open.width - 30, open.y + 110],
  [open.x + 30, open.y + 120],
  [open.x + open.width - 30, open.y + 100],
]);
check("even a scribble, which would otherwise have deleted it", await cards(), 1);
check("it is just a second stroke", await inkPaths(), 2);

await page.keyboard.press("Control+z");
await page.waitForTimeout(350);
check("one undo takes back one stroke, not the whole page", await inkPaths(), 1);

// ── what reaches the file ─────────────────────────────────────────────────

await page.waitForTimeout(800);
const doc = await readPersistedCanvas(page);
const inked = doc.nodes[0]["x-mindmap-ink"].strokes;
check("the ink is saved on the card", Array.isArray(inked) && inked.length, 1);
check(
  "as whole numbers, the way the spec writes geometry",
  inked[0].points.every((n) => Number.isInteger(n)),
  true,
);
check(
  "against a box the size of the card it was written on",
  [doc.nodes[0]["x-mindmap-ink"].width, doc.nodes[0]["x-mindmap-ink"].height],
  [doc.nodes[0].width, doc.nodes[0].height],
);
check(
  "and stays inside it",
  inked[0].points.every(
    (n, i) =>
      n >= 0 &&
      n <= (i % 2 ? doc.nodes[0]["x-mindmap-ink"].height : doc.nodes[0]["x-mindmap-ink"].width),
  ),
  true,
);
check("nothing invented at the top level", Object.keys(doc).sort().join(), "edges,nodes");

// ── leaving ───────────────────────────────────────────────────────────────

await page.getByRole("button", { name: "Stop writing on this card" }).click();
await page.waitForTimeout(250);
check("Done closes the card", await page.locator('[class*="sketchNode"]').count(), 0);

const closed = await box(0);
await stroke([
  [closed.x + 30, closed.y + 40],
  [closed.x + 60, closed.y + 70],
  [closed.x + 90, closed.y + 40],
  [closed.x + 40, closed.y + 60],
  [closed.x + 95, closed.y + 55],
]);
check("and the pen is the map's again", await cards(), 0);

// That scribble deleted the card, which is the point of it. Put it back.
await page.keyboard.press("Control+z");
await page.waitForTimeout(400);
check("the card, and its ink, come back together", await inkPaths(), 1);

// ── what the stroke became ────────────────────────────────────────────────
//
// The conversion is checked here rather than against the module, because the
// module reaches geometry.ts at runtime and node cannot resolve that from a
// script. Driving the app covers the same ground and is what this suite does
// everywhere else.

await page.keyboard.press("Escape");
await page.waitForTimeout(150);
await page.locator("[data-node-id]").first().click();
await page.waitForTimeout(200);
await page.getByRole("button", { name: "Ink", exact: true }).click();
await page.waitForTimeout(250);

const room = await box(0);
// A long straight run: its middle says nothing and should be thinned away.
await stroke(
  Array.from({ length: 24 }, (_, i) => [room.x + 20 + i * 4, room.y + 30]),
);
// A stroke that starts inside and wanders off the edge. The card clips what it
// draws, so ink beyond the edge would be kept and never seen again.
await stroke([
  [room.x + 60, room.y + 60],
  [room.x + room.width - 20, room.y + room.height - 20],
  [room.x + room.width + 80, room.y + room.height + 60],
]);
await page.waitForTimeout(800);

check("wandering off the edge does not make a card", await cards(), 1);
const written = (await readPersistedCanvas(page)).nodes[0];
const strokes = written["x-mindmap-ink"].strokes;
check("both strokes were kept", strokes.length, 3);
check(
  "a straight run keeps only its ends",
  strokes[1].points.length / 2,
  2,
);
check(
  "every point is inside the box they are drawn against",
  strokes.every((k) =>
    k.points.every(
      (n, i) =>
        n >= 0 && n <= (i % 2 ? written["x-mindmap-ink"].height : written["x-mindmap-ink"].width),
    ),
  ),
  true,
);
check(
  "and every one is a whole number",
  strokes.every((k) => k.points.every((n) => Number.isInteger(n))),
  true,
);
check(
  "a curve is drawn as a curve, not a hinge at every point",
  (await page.locator('[class*="inkLayer"] path').first().getAttribute("d")).includes("Q"),
  true,
);

// ── writing stretches with the card ───────────────────────────────────────
//
// An annotation belongs to the tile it is on, so resizing the tile resizes the
// writing — in both axes independently, because a card can change shape as well
// as size.

const drawnBox = await page.evaluate(() => {
  const svg = document.querySelector('[class*="inkLayer"]');
  const card = document.querySelector("[data-node-id]");
  return {
    viewBox: svg.getAttribute("viewBox"),
    svg: [Math.round(svg.width.baseVal.value), Math.round(svg.height.baseVal.value)],
    card: [parseFloat(card.style.width), parseFloat(card.style.height)],
    fit: svg.getAttribute("preserveAspectRatio"),
  };
});
check("the writing is drawn at the card's size", drawnBox.svg, drawnBox.card);
check("and may change shape doing it", drawnBox.fit, "none");

// Drag the grip out, further in one axis than the other.
const before = await box(0);
await page.locator("[data-node-id]").first().click();
await page.waitForTimeout(250);
const handle = await page.locator("[data-resize-handle]").boundingBox();
await page.evaluate(
  ({ x, y }) => {
    const surface = document.querySelector('[class*="surface"]');
    const grip = document.querySelector("[data-resize-handle]");
    const at = (node, type, cx, cy) =>
      node.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 93, pointerType: "touch", isPrimary: true,
          clientX: cx, clientY: cy, width: 40, height: 40,
          pressure: type === "pointerup" ? 0 : 0.5, bubbles: true, cancelable: true,
        }),
      );
    at(grip, "pointerdown", x, y);
    for (let i = 1; i <= 8; i++) at(surface, "pointermove", x + i * 20, y + i * 5);
    at(surface, "pointerup", x + 160, y + 40);
  },
  { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 },
);
await page.waitForTimeout(400);

const stretched = await page.evaluate(() => {
  const svg = document.querySelector('[class*="inkLayer"]');
  const card = document.querySelector("[data-node-id]");
  return {
    viewBox: svg.getAttribute("viewBox"),
    svg: [Math.round(svg.width.baseVal.value), Math.round(svg.height.baseVal.value)],
    card: [parseFloat(card.style.width), parseFloat(card.style.height)],
  };
});
check("the card really did change shape", stretched.card, [before.width + 160, before.height + 40]);
check("the writing is drawn at the new size", stretched.svg, stretched.card);
check("stretched from the box it was written against, which does not move", stretched.viewBox, drawnBox.viewBox);

await page.waitForTimeout(800);
const resized = (await readPersistedCanvas(page)).nodes[0];
check(
  "and nothing was rewritten to do it",
  resized["x-mindmap-ink"].strokes.map((k) => k.points.join()).join("|"),
  strokes.map((k) => k.points.join()).join("|"),
);

// A stroke added after the resize has to join the ones already there rather
// than being pinned to the size the card happens to be now.
await ensureInking();
const room2 = await box(0);
// Across the middle, clear of the Done and undo buttons in the bottom corner —
// those carry data-card-action and the surface deliberately does not see them.
await stroke([
  [room2.x + 40, room2.y + room2.height * 0.55],
  [room2.x + room2.width * 0.6, room2.y + room2.height * 0.6],
]);
await page.waitForTimeout(800);
const joined = (await readPersistedCanvas(page)).nodes[0];
check(
  "a stroke drawn after the resize keeps the same box",
  [joined["x-mindmap-ink"].width, joined["x-mindmap-ink"].height],
  [resized["x-mindmap-ink"].width, resized["x-mindmap-ink"].height],
);
check("and joins the strokes already there", joined["x-mindmap-ink"].strokes.length, strokes.length + 1);

// The proof that converting into the box is right: scaling the stored points
// back out by the card's size has to land where the pen actually was.
const last = joined["x-mindmap-ink"].strokes.at(-1);
const inkBox = joined["x-mindmap-ink"];
check(
  "and lands where the pen was, not where the card's size would have put it",
  [
    Math.round((last.points[0] * joined.width) / inkBox.width),
    Math.round((last.points[1] * joined.height) / inkBox.height),
  ],
  [40, Math.round(room2.height * 0.55)],
);

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
