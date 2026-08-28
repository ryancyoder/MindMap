// Copying a card by long-pressing it and dragging.
//
// The gesture is layered on the one that was already there: a finger held on a
// card still toggles it into the selection when it lifts, and only *moving*
// after the press turns the drag into a copy. So this script has to prove both
// halves — that a plain drag still moves, that a long press that goes nowhere
// still selects, and that a long press followed by a drag leaves the original
// behind and carries a duplicate away.
//
// Copying a connected pair is the case worth being careful about: the edge
// between them has to come along, or duplicating a branch quietly flattens it,
// and the edge to the card left behind must not, or the copy silently rewires
// the map.

import { BASE_URL, launchBrowser, makeChecker, readPersistedCanvas } from "./_harness.mjs";

const { check, finish } = makeChecker();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

const send = (events) =>
  page.evaluate((evs) => {
    const surface = document.querySelector('[class*="surface"]');
    for (const e of evs) {
      surface.dispatchEvent(
        new PointerEvent(e.type, {
          pointerId: e.id, pointerType: e.kind ?? "touch", isPrimary: true,
          clientX: e.x, clientY: e.y, width: e.w ?? 1, height: e.w ?? 1,
          pressure: e.type === "pointerup" ? 0 : 0.5, bubbles: true, cancelable: true,
        }),
      );
    }
  }, events);

const boxes = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-node-id]")].map((n) => ({
      id: n.dataset.nodeId,
      x: Math.round(parseFloat(n.style.left)), y: Math.round(parseFloat(n.style.top)),
      w: Math.round(parseFloat(n.style.width)), h: Math.round(parseFloat(n.style.height)),
    })),
  );
const selectedCount = () => page.locator('[class*="nodeSelected"]').count();
const at = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

let pid = 500;

/** A hand-drawn loop: the app's own way of making a card. */
async function drawCard(cx, cy, r) {
  const evs = [{ type: "pointerdown", id: 9, kind: "pen", x: cx + r, y: cy }];
  for (let i = 1; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    evs.push({ type: "pointermove", id: 9, kind: "pen", x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  evs.push({ type: "pointerup", id: 9, kind: "pen", x: cx + r, y: cy });
  await send(evs);
  await page.waitForTimeout(260);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(480);
}

/** A pen stroke from one card to another: a connector. */
async function connect(from, to) {
  const evs = [{ type: "pointerdown", id: 9, kind: "pen", x: from.x, y: from.y }];
  for (let i = 1; i <= 16; i++) {
    evs.push({
      type: "pointermove", id: 9, kind: "pen",
      x: from.x + ((to.x - from.x) * i) / 16,
      y: from.y + ((to.y - from.y) * i) / 16,
    });
  }
  evs.push({ type: "pointerup", id: 9, kind: "pen", x: to.x, y: to.y });
  await send(evs);
  await page.waitForTimeout(400);
}

/** A finger drag, optionally held still first — which is what arms the copy. */
async function drag(from, dx, dy, hold = 0) {
  const id = ++pid;
  await send([{ type: "pointerdown", id, x: from.x, y: from.y, w: 50 }]);
  if (hold) await page.waitForTimeout(hold);
  await send(
    Array.from({ length: 10 }, (_, i) => ({
      type: "pointermove", id, w: 50,
      x: from.x + (dx * (i + 1)) / 10,
      y: from.y + (dy * (i + 1)) / 10,
    })),
  );
  await send([{ type: "pointerup", id, x: from.x + dx, y: from.y + dy, w: 50 }]);
  await page.waitForTimeout(320);
}

/** A stationary finger held for `ms`. */
async function press(x, y, ms) {
  const id = ++pid;
  await send([{ type: "pointerdown", id, x, y, w: 50 }]);
  await page.waitForTimeout(ms);
  await send([{ type: "pointerup", id, x, y, w: 50 }]);
  await page.waitForTimeout(150);
}

// ── two connected cards to work on ─────────────────────────────────────────

await drawCard(300, 260, 54);
await drawCard(620, 260, 54);
const drawn = await boxes();
check("two cards drawn", drawn.length, 2);

await connect(at(drawn[0]), at(drawn[1]));
await page.keyboard.press("Escape");
await page.waitForTimeout(700);
const linked = await readPersistedCanvas(page);
check("and connected", linked.edges.length, 1);

// ── a plain drag still moves ───────────────────────────────────────────────

await page.keyboard.press("Escape");
await page.waitForTimeout(150);
const before = await boxes();
await drag(at(before[0]), 60, 90);
const moved = await boxes();
check("a plain drag makes no new card", moved.length, 2);
check(
  "it moves the card it started on",
  [moved[0].x - before[0].x, moved[0].y - before[0].y],
  [60, 90],
);

// ── a long press that goes nowhere is still a long press ───────────────────

await page.keyboard.press("Escape");
await page.waitForTimeout(150);
await press(at(moved[0]).x, at(moved[0]).y, 100);
await press(at(moved[1]).x, at(moved[1]).y, 650);
check("a long press with no movement still extends the selection", await selectedCount(), 2);
check("and copies nothing", (await boxes()).length, 2);

// ── long press, then drag: a copy comes away ───────────────────────────────

await page.keyboard.press("Escape");
await page.waitForTimeout(200);
const origin = (await boxes())[0];
await drag(at(origin), 200, 140, 650);

const copied = await boxes();
check("long-press then drag makes a third card", copied.length, 3);
const stayed = copied.find((b) => b.id === origin.id);
check("the original stays exactly where it was", [stayed.x, stayed.y], [origin.x, origin.y]);
const copy = copied.find(
  (b) => b.id !== origin.id && b.x === origin.x + 200 && b.y === origin.y + 140,
);
check("the copy is the card that followed the finger", !!copy, true);
check("and it is the same size", [copy.w, copy.h], [origin.w, origin.h]);
check("the copy is what ends up selected", await selectedCount(), 1);

await page.waitForTimeout(700);
const afterCopy = await readPersistedCanvas(page);
check("copying one card copies none of its connections", afterCopy.edges.length, 1);
check("and the copy carries the original's text", afterCopy.nodes.find((n) => n.id === copy.id).text,
  afterCopy.nodes.find((n) => n.id === origin.id).text);

await page.keyboard.press("Control+z");
await page.waitForTimeout(400);
check("one undo takes the copy and its move back together", (await boxes()).length, 2);

// ── copying a pair takes the edge between them ─────────────────────────────

await page.keyboard.press("Control+a");
await page.waitForTimeout(250);
check("both cards selected", await selectedCount(), 2);

const pair = await boxes();
await drag(at(pair[0]), 40, 260, 650);
const four = await boxes();
check("dragging a selected card after a long press copies the whole selection", four.length, 4);
check(
  "the originals are untouched",
  pair.map((b) => [b.x, b.y].join()).join(" "),
  pair.map((b) => {
    const now = four.find((f) => f.id === b.id);
    return [now.x, now.y].join();
  }).join(" "),
);

await page.waitForTimeout(700);
const doc = await readPersistedCanvas(page);
check("the connection between the two copies came along", doc.edges.length, 2);
const originals = new Set(pair.map((b) => b.id));
const copies = new Set(four.filter((b) => !originals.has(b.id)).map((b) => b.id));
const copyEdge = doc.edges.find((e) => copies.has(e.fromNode) && copies.has(e.toNode));
check("and it joins the copies, not the originals", !!copyEdge, true);
check(
  "no edge straddles a copy and an original",
  doc.edges.some((e) => copies.has(e.fromNode) !== copies.has(e.toNode)),
  false,
);

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
