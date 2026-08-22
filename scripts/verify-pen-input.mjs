// Regression guard for the pen input path.
//
// The mouse-driven checks in verify-gestures.mjs dispatch *trusted* events,
// where Chromium populates getCoalescedEvents(). Safari and synthetic events
// hand back an empty array instead. Trusting that array without a fallback
// captured zero points from every stroke, so the recognizer saw a single-point
// tap and the app appeared completely dead on an iPad.
//
// These strokes are dispatched as pointerType:"pen" with an empty coalesced
// list — the exact shape that failed — so the regression cannot come back.

import { BASE_URL, launchBrowser, makeChecker } from "./_harness.mjs";

const { check, finish } = makeChecker();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

/** Dispatch a stroke as an Apple Pencil would: pointerType "pen". */
async function penStroke(points) {
  await page.evaluate((pts) => {
    const surface = document.querySelector('[class*="surface"]');
    const send = (type, x, y) =>
      surface.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          pointerType: "pen",
          isPrimary: true,
          clientX: x,
          clientY: y,
          pressure: type === "pointerup" ? 0 : 0.5,
          bubbles: true,
          cancelable: true,
        }),
      );
    send("pointerdown", pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) send("pointermove", p.x, p.y);
    send("pointerup", pts[pts.length - 1].x, pts[pts.length - 1].y);
  }, points);
  await page.waitForTimeout(250);
}

const circle = (cx, cy, r, n = 48) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });

const line = (x1, y1, x2, y2, n = 24) =>
  Array.from({ length: n + 1 }, (_, i) => ({
    x: x1 + ((x2 - x1) * i) / n,
    y: y1 + ((y2 - y1) * i) / n,
  }));

// Confirm the environment really is the failing one, so a passing run below
// proves the fallback works rather than proving the list happened to be full.
const coalescedLength = await page.evaluate(() => {
  const ev = new PointerEvent("pointermove", { pointerType: "pen", bubbles: true });
  return typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents().length : -1;
});
check("test dispatches events with an empty coalesced list", coalescedLength, 0);

await penStroke(circle(500, 430, 90));
check("a pen circle creates a node", await page.locator("[data-node-id]").count(), 1);
check("the new node opened for text", await page.locator("textarea").count(), 1);

await page.keyboard.press("Escape");
await page.waitForTimeout(150);

await penStroke(line(500, 430, 850, 620));
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
check("a pen branch stroke adds a node and an edge", [
  await page.locator("[data-node-id]").count(),
  await page.locator("[data-edge-id]").count(),
], [2, 1]);

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
