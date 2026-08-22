// Shape coverage for the recognizer, using strokes a hand actually produces.
//
// The other suites drew mathematically perfect circles. A real Apple Pencil
// records hand tremor, and unsmoothed tremor generated a dozen-plus fake
// direction reversals on an ordinary circle — which tripped the scribble
// detector, and a scribble over empty canvas silently did nothing. Ink
// appeared, no card did, and nothing explained why.
//
// So these strokes wobble, leave gaps, double back, and run short of samples.
// The scribble cases matter just as much: the fix loosened that branch, and
// crossing something out has to keep working.

import { BASE_URL, launchBrowser, makeChecker } from "./_harness.mjs";

const { check, finish } = makeChecker();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

async function pen(points) {
  await page.evaluate((pts) => {
    const surface = document.querySelector('[class*="surface"]');
    const send = (type, x, y) =>
      surface.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1, pointerType: "pen", isPrimary: true, clientX: x, clientY: y,
          pressure: type === "pointerup" ? 0 : 0.5, bubbles: true, cancelable: true,
        }),
      );
    send("pointerdown", pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) send("pointermove", p.x, p.y);
    send("pointerup", pts[pts.length - 1].x, pts[pts.length - 1].y);
  }, points);
  await page.waitForTimeout(260);
}

/** A circle with optional tremor, an optional unclosed gap, and n samples. */
const arc = (cx, cy, r, { turns = 1, gap = 0, noise = 0, n = 48 } = {}) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2 * turns * (1 - gap);
    const rr = r + (noise ? (Math.sin(i * 3.7) + Math.cos(i * 2.3)) * noise : 0);
    return { x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr };
  });

const line = (x1, y1, x2, y2, n = 8) =>
  Array.from({ length: n + 1 }, (_, i) => ({
    x: x1 + ((x2 - x1) * i) / n, y: y1 + ((y2 - y1) * i) / n,
  }));

function zigzag(cx, cy, w, h, sweeps) {
  const corners = Array.from({ length: sweeps + 1 }, (_, i) => ({
    x: cx - w / 2 + (w * i) / sweeps, y: i % 2 === 0 ? cy - h / 2 : cy + h / 2,
  }));
  const out = [];
  for (let i = 1; i < corners.length; i++) {
    out.push(...line(corners[i - 1].x, corners[i - 1].y, corners[i].x, corners[i].y, 6));
  }
  return out;
}

const nodes = () => page.locator("[data-node-id]").count();
const escape = async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(120); };

// Every shape here must produce exactly one card.
const SHAPES = [
  ["a clean circle", arc(400, 400, 90)],
  ["a small circle", arc(400, 400, 28, { n: 32 })],
  ["a shaky circle (real hand tremor)", arc(400, 400, 85, { noise: 7, n: 60 })],
  ["a circle left 10% open", arc(400, 400, 90, { gap: 0.1 })],
  ["a circle left 25% open", arc(400, 400, 90, { gap: 0.25 })],
  ["a circle drawn round twice", arc(400, 400, 70, { turns: 2, n: 80 })],
  ["a wide ellipse", arc(400, 400, 70).map((p) => ({ x: 400 + (p.x - 400) * 2, y: p.y }))],
  ["a fast circle with few samples", arc(400, 400, 80, { gap: 0.05, noise: 5, n: 12 })],
];

for (const [name, stroke] of SHAPES) {
  const before = await nodes();
  await pen(stroke);
  await escape();
  check(`${name} makes a card`, (await nodes()) - before, 1);
  // Clear for the next shape so positions never collide.
  await pen(zigzag(400, 400, 260, 90, 9));
  await page.waitForTimeout(150);
}

check("canvas is empty again after the scribbles", await nodes(), 0);

// Crossing out still has to work, including over a shaky card.
await pen(arc(700, 300, 75, { noise: 6, n: 50 }));
await escape();
check("a shaky circle away from origin makes a card", await nodes(), 1);
await pen(zigzag(700, 300, 140, 50, 9));
check("a scribble deletes it", await nodes(), 0);

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
