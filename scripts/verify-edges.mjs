// Removing a connection without removing the cards.
//
// This regressed once: the scribble branch required a *card* to be crossed, so
// scribbling out a link on its own did nothing, and there was no way to delete
// a connection except by deleting a card it attached to.
//
// Hit-testing samples the same curve the renderer draws, so what you can
// scribble out is exactly what you can see. The bowed-connector check below is
// what holds that together — a straight-line approximation passes the first
// check and fails that one.

import { BASE_URL, launchBrowser, makeChecker } from "./_harness.mjs";

const { check, finish } = makeChecker();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

const send = (evs) =>
  page.evaluate((e) => {
    const s = document.querySelector('[class*="surface"]');
    for (const ev of e) {
      s.dispatchEvent(
        new PointerEvent(ev.type, {
          pointerId: ev.id, pointerType: "pen", isPrimary: true,
          clientX: ev.x, clientY: ev.y,
          pressure: ev.type === "pointerup" ? 0 : 0.5, bubbles: true, cancelable: true,
        }),
      );
    }
  }, evs);

const counts = async () => ({
  nodes: await page.locator("[data-node-id]").count(),
  edges: await page.locator("[data-edge-id]").count(),
});

async function load(doc) {
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await page.waitForTimeout(200);
  await page.locator('textarea[aria-label="Canvas JSON"]').fill(JSON.stringify(doc));
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Open as new map" }).click();
  await page.waitForTimeout(800);
}

const line = (x1, y1, x2, y2, n = 6) =>
  Array.from({ length: n + 1 }, (_, i) => ({
    x: x1 + ((x2 - x1) * i) / n, y: y1 + ((y2 - y1) * i) / n,
  }));

let pid = 500;
/** A zigzag centred on a point, the way a hand crosses something out. */
async function scribbleAt(at, w = 140, h = 90) {
  const corners = Array.from({ length: 8 }, (_, i) => ({
    x: at.x - w / 2 + (w * i) / 7,
    y: i % 2 === 0 ? at.y - h / 2 : at.y + h / 2,
  }));
  const pts = [];
  for (let i = 1; i < corners.length; i++) {
    pts.push(...line(corners[i - 1].x, corners[i - 1].y, corners[i].x, corners[i].y, 6));
  }
  const id = ++pid;
  await send([
    { type: "pointerdown", id, x: pts[0].x, y: pts[0].y },
    ...pts.slice(1).map((p) => ({ type: "pointermove", id, x: p.x, y: p.y })),
    { type: "pointerup", id, x: pts[pts.length - 1].x, y: pts[pts.length - 1].y },
  ]);
  await page.waitForTimeout(400);
}

/** Where a connector actually runs on screen, sampled off its own path. */
const pointOnEdge = (index = 0, t = 0.5) =>
  page.evaluate(
    ({ index, t }) => {
      const path = document.querySelectorAll("[data-edge-id]")[index];
      const at = path.getPointAtLength(path.getTotalLength() * t);
      const svg = path.ownerSVGElement;
      const pt = svg.createSVGPoint();
      pt.x = at.x;
      pt.y = at.y;
      const screen = pt.matrixTransform(path.getScreenCTM());
      return { x: screen.x, y: screen.y };
    },
    { index, t },
  );

// ── a straight-ish connector ───────────────────────────────────────────────

await load({
  nodes: [
    { id: "a", type: "text", text: "Left", x: -500, y: 0, width: 200, height: 80 },
    { id: "b", type: "text", text: "Right", x: 400, y: 0, width: 200, height: 80 },
  ],
  edges: [{ id: "e1", fromNode: "a", fromSide: "right", toNode: "b", toSide: "left" }],
});
check("a map with one link", await counts(), { nodes: 2, edges: 1 });

await scribbleAt(await pointOnEdge(0, 0.5));
check("scribbling over the link removes it", await counts(), { nodes: 2, edges: 0 });

// ── a connector that bows well away from the straight line ─────────────────
// Both sides leave rightwards, so the curve loops out and back. Sampling a
// straight line between the cards would miss it entirely.

await load({
  nodes: [
    { id: "a", type: "text", text: "One", x: -400, y: -260, width: 200, height: 80 },
    { id: "b", type: "text", text: "Two", x: -400, y: 260, width: 200, height: 80 },
  ],
  edges: [{ id: "e1", fromNode: "a", fromSide: "right", toNode: "b", toSide: "right" }],
});
await scribbleAt(await pointOnEdge(0, 0.5));
check("a bowed connector is hit where it is drawn", await counts(), { nodes: 2, edges: 0 });

// ── it must stay precise ───────────────────────────────────────────────────

await load({
  nodes: [
    { id: "a", type: "text", text: "One", x: -500, y: -200, width: 200, height: 80 },
    { id: "b", type: "text", text: "Two", x: 400, y: -200, width: 200, height: 80 },
    { id: "c", type: "text", text: "Three", x: -500, y: 200, width: 200, height: 80 },
    { id: "d", type: "text", text: "Four", x: 400, y: 200, width: 200, height: 80 },
  ],
  edges: [
    { id: "e1", fromNode: "a", fromSide: "right", toNode: "b", toSide: "left" },
    { id: "e2", fromNode: "c", fromSide: "right", toNode: "d", toSide: "left" },
  ],
});
check("two links to choose between", (await counts()).edges, 2);

await scribbleAt(await pointOnEdge(0, 0.5), 100, 60);
const after = await counts();
check("only the link scribbled over goes", after, { nodes: 4, edges: 1 });

await page.keyboard.press("Control+z");
await page.waitForTimeout(300);
check("and one undo brings it back", (await counts()).edges, 2);

// Scribbling empty canvas must still not silently eat anything.
const before = await counts();
await scribbleAt({ x: 590, y: 760 }, 120, 70);
check("scribbling empty canvas changes nothing", await counts(), before);

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
