// Snap-to-grid, edge-matching alignment, and the pen's select mode.
//
// Select mode is a deliberate exception to the no-tool-palette rule: the pen
// stops drawing and starts pointing. Draw remains the default, so the checks
// below also confirm that turning it on does not leak into drawing, and that
// turning it off restores the recognizer intact.

import { BASE_URL, launchBrowser, makeChecker } from "./_harness.mjs";

const { check, finish } = makeChecker();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

const GRID = 28;

const send = (events) =>
  page.evaluate((evs) => {
    const surface = document.querySelector('[class*="surface"]');
    for (const e of evs) {
      surface.dispatchEvent(
        new PointerEvent(e.type, {
          pointerId: e.id, pointerType: e.kind ?? "pen", isPrimary: true,
          clientX: e.x, clientY: e.y, width: e.w ?? 1, height: e.w ?? 1,
          shiftKey: !!e.shift,
          pressure: e.type === "pointerup" ? 0 : 0.5, bubbles: true, cancelable: true,
        }),
      );
    }
  }, events);

const boxes = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-node-id]")].map((n) => ({
      id: n.dataset.nodeId,
      x: parseFloat(n.style.left), y: parseFloat(n.style.top),
      w: parseFloat(n.style.width), h: parseFloat(n.style.height),
      selected: /nodeSelected/.test(n.className),
    })),
  );
const selectedCount = async () => (await boxes()).filter((b) => b.selected).length;

async function drawCard(cx, cy, r) {
  const evs = [{ type: "pointerdown", id: 9, x: cx + r, y: cy }];
  for (let i = 1; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    evs.push({ type: "pointermove", id: 9, x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  evs.push({ type: "pointerup", id: 9, x: cx + r, y: cy });
  await send(evs);
  await page.waitForTimeout(260);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(480);
}

let pid = 400;
async function penDrag(from, to, { shift = false, steps = 10 } = {}) {
  const id = ++pid;
  const evs = [{ type: "pointerdown", id, x: from.x, y: from.y, shift }];
  for (let i = 1; i <= steps; i++) {
    evs.push({
      type: "pointermove", id, shift,
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
    });
  }
  evs.push({ type: "pointerup", id, x: to.x, y: to.y, shift });
  await send(evs);
  await page.waitForTimeout(280);
}
const centreOn = async (i) => {
  const el = await page.locator("[data-node-id]").nth(i).boundingBox();
  return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
};

await drawCard(300, 250, 45);
await drawCard(620, 380, 70);
await drawCard(880, 240, 55);
check("three cards of differing sizes", (await boxes()).length, 3);

// ── alignment matches edges ────────────────────────────────────────────────

await page.keyboard.press("Control+a");
await page.waitForTimeout(200);
const before = await boxes();
check("they start out different widths", new Set(before.map((b) => b.w)).size > 1, true);

await page.getByRole("button", { name: "Column" }).click();
await page.waitForTimeout(350);
const columned = await boxes();
check("Column gives every card the same width", new Set(columned.map((b) => b.w)).size, 1);
check("so their left edges line up", new Set(columned.map((b) => b.x)).size, 1);
check("and their right edges too", new Set(columned.map((b) => b.x + b.w)).size, 1);
check(
  "the shared width is the widest, so nothing is narrowed into clipping",
  columned[0].w,
  Math.max(...before.map((b) => b.w)),
);

await page.keyboard.press("Control+z");
await page.waitForTimeout(300);
check("one undo restores the original widths", (await boxes()).map((b) => b.w).join(), before.map((b) => b.w).join());

// ── snap to grid ───────────────────────────────────────────────────────────

await page.keyboard.press("Escape");
await page.waitForTimeout(150);
const unsnapped = await boxes();
check(
  "positions are off-grid to begin with",
  unsnapped.some((b) => b.x % GRID !== 0 || b.y % GRID !== 0),
  true,
);

await page.getByRole("button", { name: "Snap" }).click();
await page.waitForTimeout(200);

// Drag one card with a finger; it should land on the grid.
const target = await centreOn(0);
const id = ++pid;
await send([
  { type: "pointerdown", id, kind: "touch", w: 50, x: target.x, y: target.y },
  ...Array.from({ length: 8 }, (_, i) => ({
    type: "pointermove", id, kind: "touch", w: 50,
    x: target.x + (i + 1) * 11, y: target.y + (i + 1) * 7,
  })),
  { type: "pointerup", id, kind: "touch", w: 50, x: target.x + 88, y: target.y + 56 },
]);
await page.waitForTimeout(320);
const snapped = (await boxes())[0];
check("a snapped drag lands on the grid", [snapped.x % GRID, snapped.y % GRID], [0, 0]);

await page.getByRole("button", { name: "Snap" }).click();
await page.waitForTimeout(200);
const t2 = await centreOn(0);
const id2 = ++pid;
await send([
  { type: "pointerdown", id: id2, kind: "touch", w: 50, x: t2.x, y: t2.y },
  ...Array.from({ length: 8 }, (_, i) => ({
    type: "pointermove", id: id2, kind: "touch", w: 50, x: t2.x + (i + 1) * 2, y: t2.y,
  })),
  { type: "pointerup", id: id2, kind: "touch", w: 50, x: t2.x + 16, y: t2.y },
]);
await page.waitForTimeout(320);
check("with snap off a 16px nudge moves 16px", (await boxes())[0].x - snapped.x, 16);

// ── the pen's select mode ──────────────────────────────────────────────────

const countBefore = (await boxes()).length;
await page.getByRole("button", { name: /Draw/ }).click();
await page.waitForTimeout(200);
check("the toggle now reads Select", await page.getByRole("button", { name: /Select/ }).count(), 1);

// A circle in select mode must lasso, not create a card.
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
await penDrag({ x: 120, y: 120 }, { x: 1050, y: 700 });
check("a pen drag in select mode creates nothing", (await boxes()).length, countBefore);
check("and lassoes what it covered", await selectedCount(), countBefore);

// Lasso a smaller region: only what it touches.
await penDrag({ x: 120, y: 120 }, { x: 300, y: 300 });
const partial = await selectedCount();
check("a smaller lasso selects fewer", partial < countBefore, true);

// The pen drags cards in select mode too.
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
const beforePenDrag = await boxes();
const onCard = await centreOn(1);
await penDrag(onCard, { x: onCard.x + 140, y: onCard.y + 84 });
const afterPenDrag = await boxes();
check("the pen moves a card in select mode", [
  Math.round(afterPenDrag[1].x - beforePenDrag[1].x),
  Math.round(afterPenDrag[1].y - beforePenDrag[1].y),
], [140, 84]);

// Back to Draw, and the recognizer must be exactly as it was.
await page.getByRole("button", { name: /Select/ }).click();
await page.waitForTimeout(200);
await drawCard(400, 640, 55);
check("switching back to Draw makes circles into cards again", (await boxes()).length, countBefore + 1);

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
