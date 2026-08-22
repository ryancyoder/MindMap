// Double-tap to zoom.
//
// Double-tap is a finger gesture only. The pen already uses a second tap to
// open a card for text, and taking that over would cost handwriting to buy
// navigation. The checks below therefore drive touch, and the ones that matter
// most are the pairings that must NOT happen: taps too slow, too far apart, on
// different targets, or after the finger travelled.

import { BASE_URL, launchBrowser, makeChecker } from "./_harness.mjs";

const { check, finish } = makeChecker();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

const send = (events, selector = '[class*="surface"]') =>
  page.evaluate(({ evs, sel }) => {
    const target = document.querySelector(sel);
    for (const e of evs) {
      target.dispatchEvent(
        new PointerEvent(e.type, {
          pointerId: e.id, pointerType: e.kind ?? "touch", isPrimary: true,
          clientX: e.x, clientY: e.y, width: e.w ?? 1, height: e.w ?? 1,
          pressure: e.type === "pointerup" ? 0 : 0.5, bubbles: true, cancelable: true,
        }),
      );
    }
  }, { evs: events, sel: selector });

const view = () =>
  page.evaluate(() => {
    const style = document.querySelector('[class*="world"]').getAttribute("style");
    const t = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(style);
    return t ? { x: +t[1], y: +t[2], k: +t[3] } : null;
  });

let pid = 100;
/** One stationary finger tap. */
const tap = async (x, y, w = 50) => {
  const id = ++pid;
  await send([
    { type: "pointerdown", id, x, y, w },
    { type: "pointerup", id, x, y, w },
  ]);
  await page.waitForTimeout(60);
};
const doubleTap = async (x, y) => {
  await tap(x, y);
  await tap(x, y);
  await page.waitForTimeout(450); // let the zoom animation land
};

async function drawCard(cx, cy, r, text) {
  const evs = [{ type: "pointerdown", id: 9, kind: "pen", x: cx + r, y: cy }];
  for (let i = 1; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    evs.push({ type: "pointermove", id: 9, kind: "pen", x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  evs.push({ type: "pointerup", id: 9, kind: "pen", x: cx + r, y: cy });
  await send(evs);
  await page.waitForTimeout(280);
  await page.keyboard.type(text);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500); // clear the pen-priority window
}

await drawCard(320, 300, 60, "Card A");
await drawCard(820, 620, 60, "Card B");
await page.getByRole("button", { name: "Fit" }).click();
await page.waitForTimeout(300);

const overview = await view();

// ── zoom in ────────────────────────────────────────────────────────────────

const cardA = await page.locator("[data-node-id]").first().boundingBox();
await doubleTap(cardA.x + cardA.width / 2, cardA.y + cardA.height / 2);
const zoomed = await view();
check("double-tapping a card zooms in", zoomed.k > overview.k, true);

check(
  "and centres that card",
  await page.evaluate(() => {
    const n = document.querySelector("[data-node-id]").getBoundingClientRect();
    const cx = n.x + n.width / 2;
    const cy = n.y + n.height / 2;
    return Math.abs(cx - window.innerWidth / 2) < 40 && Math.abs(cy - window.innerHeight / 2) < 40;
  }),
  true,
);

// ── zoom back ──────────────────────────────────────────────────────────────

await doubleTap(120, 780);
const back = await view();
check("double-tapping away restores the previous view", [
  Math.round(back.k * 100), Math.round(back.x), Math.round(back.y),
], [Math.round(overview.k * 100), Math.round(overview.x), Math.round(overview.y)]);

// Hopping between cards should still return to the original overview.
await doubleTap(cardA.x + cardA.width / 2, cardA.y + cardA.height / 2);
const boxB = await page.locator("[data-node-id]").nth(1).boundingBox();
await doubleTap(boxB.x + boxB.width / 2, boxB.y + boxB.height / 2);
check("hopping to a second card stays zoomed in", (await view()).k > overview.k, true);
await doubleTap(120, 780);
check(
  "and zooming back still returns to the original overview",
  Math.round((await view()).k * 100),
  Math.round(overview.k * 100),
);

// ── pairings that must not fire ────────────────────────────────────────────

const steady = await view();
await tap(cardA.x + cardA.width / 2, cardA.y + cardA.height / 2);
await page.waitForTimeout(500);
check("a single tap does not zoom", (await view()).k, steady.k);

await tap(600, 200);
await page.waitForTimeout(600); // longer than the pairing window
await tap(600, 200);
await page.waitForTimeout(400);
check("two slow taps do not pair", (await view()).k, steady.k);

await tap(400, 200);
await tap(700, 500); // same speed, far apart
await page.waitForTimeout(400);
check("two taps far apart do not pair", (await view()).k, steady.k);

// A tap on a card followed by one on empty canvas is not a double-tap either.
await tap(cardA.x + cardA.width / 2, cardA.y + cardA.height / 2);
await tap(cardA.x + cardA.width / 2 + 10, cardA.y + cardA.height / 2 + 300);
await page.waitForTimeout(400);
check("taps on different targets do not pair", (await view()).k, steady.k);

// A finger that travelled is a pan, not a tap, so it cannot start a pair.
const before = await view();
const id = ++pid;
await send([
  { type: "pointerdown", id, x: 500, y: 700, w: 50 },
  ...Array.from({ length: 6 }, (_, i) => ({ type: "pointermove", id, x: 500 + (i + 1) * 12, y: 700, w: 50 })),
  { type: "pointerup", id, x: 572, y: 700, w: 50 },
]);
await page.waitForTimeout(80);
await tap(572, 700);
await page.waitForTimeout(400);
check("a pan then a tap does not zoom", (await view()).k, before.k);

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
