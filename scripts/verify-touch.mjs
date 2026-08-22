// Touch behavior: pan, pinch, and moving a card with a finger.
//
// Touch was entirely untested until it broke. The palm filter rejected any
// contact wider than 45px, and iOS reports an ordinary fingertip on an iPad at
// roughly 40-60px — so on real hardware pan and pinch did nothing at all while
// every synthetic test passed, because synthetic events default to width 1.
// The wide-contact case below is the one that matters; keep it.

import { BASE_URL, launchBrowser, makeChecker } from "./_harness.mjs";

const { check, finish } = makeChecker();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });

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
          pointerId: e.id,
          pointerType: e.kind ?? "touch",
          isPrimary: e.id === 1,
          clientX: e.x,
          clientY: e.y,
          width: e.w ?? 1,
          height: e.w ?? 1,
          pressure: e.type === "pointerup" ? 0 : 0.5,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }, events);

const worldStyle = () =>
  page.evaluate(() => document.querySelector('[class*="world"]').getAttribute("style"));
const scaleOf = (style) => Number(/scale\(([-\d.]+)\)/.exec(style)?.[1] ?? NaN);
const cardBox = () =>
  page.evaluate(() => {
    const n = document.querySelector("[data-node-id]");
    if (!n) return null;
    return { left: parseFloat(n.style.left), top: parseFloat(n.style.top) };
  });

// A finger drag of the given width, in `steps` increments.
const fingerDrag = async (id, from, to, width, steps = 10) => {
  const evs = [{ type: "pointerdown", id, x: from.x, y: from.y, w: width }];
  for (let i = 1; i <= steps; i++) {
    evs.push({
      type: "pointermove", id, w: width,
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
    });
  }
  evs.push({ type: "pointerup", id, x: to.x, y: to.y, w: width });
  await send(evs);
  await page.waitForTimeout(220);
};

// ── canvas navigation ──────────────────────────────────────────────────────

const startStyle = await worldStyle();
await fingerDrag(1, { x: 300, y: 600 }, { x: 400, y: 650 }, 1);
check("a narrow finger pans the canvas", (await worldStyle()) !== startStyle, true);

// The case that failed on real hardware: iOS-sized fingertip contact.
const beforeWide = await worldStyle();
await fingerDrag(2, { x: 300, y: 600 }, { x: 380, y: 600 }, 50);
check("a 50px-wide fingertip also pans", (await worldStyle()) !== beforeWide, true);

const beforePinch = scaleOf(await worldStyle());
const pinch = [
  { type: "pointerdown", id: 3, x: 500, y: 400 },
  { type: "pointerdown", id: 4, x: 600, y: 400 },
];
for (let i = 1; i <= 10; i++) {
  pinch.push({ type: "pointermove", id: 3, x: 500 - i * 8, y: 400 });
  pinch.push({ type: "pointermove", id: 4, x: 600 + i * 8, y: 400 });
}
pinch.push({ type: "pointerup", id: 3, x: 420, y: 400 }, { type: "pointerup", id: 4, x: 680, y: 400 });
await send(pinch);
await page.waitForTimeout(220);
check("two fingers pinch-zoom the canvas", scaleOf(await worldStyle()) > beforePinch, true);

// Reset the view so card coordinates are easy to reason about.
await page.getByRole("button", { name: "Fit" }).click();
await page.waitForTimeout(200);

// ── cards ──────────────────────────────────────────────────────────────────

// Draw one with the pen, then let the pen-priority window lapse.
const circle = Array.from({ length: 49 }, (_, i) => {
  const a = (i / 48) * Math.PI * 2;
  return { type: "pointermove", id: 9, kind: "pen", x: 400 + Math.cos(a) * 90, y: 400 + Math.sin(a) * 90 };
});
await send([
  { type: "pointerdown", id: 9, kind: "pen", x: 490, y: 400 },
  ...circle,
  { type: "pointerup", id: 9, kind: "pen", x: 490, y: 400 },
]);
await page.waitForTimeout(300);
await page.keyboard.press("Escape");
await page.waitForTimeout(600);

const placed = await cardBox();
check("a card exists to drag", placed !== null, true);

await fingerDrag(11, { x: 400, y: 400 }, { x: 620, y: 520 }, 50);
const moved = await cardBox();
check("a finger drags the card", [
  Math.round(moved.left - placed.left),
  Math.round(moved.top - placed.top),
], [220, 120]);

check("the card position is a whole number", [
  Number.isInteger(moved.left), Number.isInteger(moved.top),
], [true, true]);

// The whole drag should be a single undo entry.
await page.keyboard.press("Control+z");
await page.waitForTimeout(250);
const undone = await cardBox();
check("one undo returns the card to where it started", [
  Math.round(undone.left), Math.round(undone.top),
], [Math.round(placed.left), Math.round(placed.top)]);

// A finger that doesn't travel selects rather than moves.
await send([
  { type: "pointerdown", id: 12, x: 400, y: 400, w: 50 },
  { type: "pointerup", id: 12, x: 400, y: 400, w: 50 },
]);
await page.waitForTimeout(200);
check(
  "a finger tap selects the card",
  await page.evaluate(() => {
    const n = document.querySelector("[data-node-id]");
    return /nodeSelected/.test(n.className);
  }),
  true,
);

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
