// Drives the drawing surface with synthetic strokes and asserts the document
// that comes out the other side. Strokes are dispatched as mouse events, which
// the app treats as pen input.

import { BASE_URL, launchBrowser, makeChecker, readPersistedCanvas } from "./_harness.mjs";

const { check, finish } = makeChecker();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

const counts = async () => ({
  nodes: await page.locator("[data-node-id]").count(),
  edges: await page.locator("[data-edge-id]").count(),
});

async function stroke(points) {
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(p.x, p.y);
  await page.mouse.up();
  await page.waitForTimeout(150);
}

function circle(cx, cy, r, n = 40) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });
}

function line(x1, y1, x2, y2, n = 24) {
  return Array.from({ length: n + 1 }, (_, i) => ({
    x: x1 + ((x2 - x1) * i) / n,
    y: y1 + ((y2 - y1) * i) / n,
  }));
}

function scribble(cx, cy, w, h, sweeps = 7) {
  const corners = Array.from({ length: sweeps + 1 }, (_, i) => ({
    x: cx - w / 2 + (w * i) / sweeps,
    y: i % 2 === 0 ? cy - h / 2 : cy + h / 2,
  }));
  const dense = [];
  for (let i = 1; i < corners.length; i++) {
    dense.push(...line(corners[i - 1].x, corners[i - 1].y, corners[i].x, corners[i].y, 6));
  }
  return dense;
}

const closeEditor = async () => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
};

// A closed loop becomes a node, opened for text.
await stroke(circle(360, 430, 70));
check("loop creates one node", (await counts()).nodes, 1);
check("loop opens the text editor", await page.locator("textarea").count(), 1);

await page.keyboard.type("Root idea");
await closeEditor();
check("typed text is committed", await page.locator("[data-node-id]").first().innerText(), "Root idea");

// A stroke out of a node into open space branches: new node AND edge.
await stroke(line(360, 430, 720, 300));
await closeEditor();
let c = await counts();
check("branch adds a node", c.nodes, 2);
check("branch adds an edge", c.edges, 1);

// A branch is the same kind of thing as what it came from, so it comes out the
// same size and shape — a row of siblings lines up without being dragged into
// line, and a map of big cards does not sprout a small one off every idea.
const boxes = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-node-id]")].map((n) => ({
      x: parseFloat(n.style.left), y: parseFloat(n.style.top),
      w: parseFloat(n.style.width), h: parseFloat(n.style.height),
    })),
  );
const sized = await boxes();
check(
  "the branched card matches the one it came from",
  [sized[1].w, sized[1].h],
  [sized[0].w, sized[0].h],
);
check(
  "and does not land on top of it",
  sized[0].x + sized[0].w <= sized[1].x || sized[1].x + sized[1].w <= sized[0].x,
  true,
);

await stroke(circle(360, 690, 60));
await closeEditor();
check("second loop creates a third node", (await counts()).nodes, 3);

// A stroke between two existing nodes links them and creates nothing.
await stroke(line(380, 690, 715, 305));
c = await counts();
check("connect adds an edge only", [c.nodes, c.edges], [3, 2]);

// A scribble deletes what it crosses, and the edges hanging off it.
await stroke(scribble(360, 690, 150, 70));
await page.waitForTimeout(250);
c = await counts();
check("scribble deletes the node", c.nodes, 2);
check("scribble deletes its edges too", c.edges, 1);

await page.keyboard.press("Control+z");
await page.waitForTimeout(200);
c = await counts();
check("undo restores node and edge", [c.nodes, c.edges], [3, 2]);

// Matching the parent means a big card branches a big card, so a short flick
// off a wide one has to be pushed clear rather than landing on top of it. Last,
// because it leaves extra cards behind.
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
await page.locator("[data-node-id]").first().click();
await page.waitForTimeout(250);
const grip = await page.locator("[data-resize-handle]").boundingBox();
await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
await page.mouse.down();
await page.mouse.move(grip.x + 300, grip.y + 40, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(350);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

const wide = (await boxes())[0];
// A flick barely clear of the card's right edge. The new card is as wide as its
// parent, so centring it on where the stroke stopped would bury the parent.
await stroke(line(wide.x + wide.w - 40, wide.y + 40, wide.x + wide.w + 70, wide.y + 45));
await closeEditor();
const after = await boxes();
const child = after[after.length - 1];
check("a short flick off a wide card still matches its size", [child.w, child.h], [wide.w, wide.h]);
check("and is pushed clear of it", child.x >= wide.x + wide.w, true);

// What was persisted must be valid JSON Canvas.
const saved = await readPersistedCanvas(page);
check("canvas persisted to IndexedDB", saved !== null, true);
if (saved) {
  const nodeIds = new Set(saved.nodes.map((n) => n.id));
  check(
    "every node has a spec-valid type",
    saved.nodes.every((n) => ["text", "file", "link", "group"].includes(n.type)),
    true,
  );
  check(
    "node geometry is numeric",
    saved.nodes.every((n) => [n.x, n.y, n.width, n.height].every(Number.isFinite)),
    true,
  );
  check(
    "no edge dangles",
    saved.edges.every((e) => nodeIds.has(e.fromNode) && nodeIds.has(e.toNode)),
    true,
  );
}

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
