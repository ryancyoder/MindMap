// Multi-select, and the commands it unlocks.
//
// Two ways in, because the two input modes are separate: shift-click for a
// keyboard, and long-press for a finger — the only single-finger gesture that
// was still free once tap, drag and double-tap were spoken for.
//
// Alignment works on centres, not edges: cards differ in width, and a column
// with matching centres reads as straight where matching left edges does not.

import { BASE_URL, launchBrowser, makeChecker } from "./_harness.mjs";

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
          shiftKey: !!e.shift,
          pressure: e.type === "pointerup" ? 0 : 0.5, bubbles: true, cancelable: true,
        }),
      );
    }
  }, events);

const selectedCount = () => page.locator('[class*="nodeSelected"]').count();
const boxes = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-node-id]")].map((n) => ({
      id: n.dataset.nodeId,
      x: parseFloat(n.style.left), y: parseFloat(n.style.top),
      w: parseFloat(n.style.width), h: parseFloat(n.style.height),
    })),
  );

let pid = 300;
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

/** A stationary finger held for `ms`. */
async function press(x, y, ms) {
  const id = ++pid;
  await send([{ type: "pointerdown", id, x, y, w: 50 }]);
  await page.waitForTimeout(ms);
  await send([{ type: "pointerup", id, x, y, w: 50 }]);
  await page.waitForTimeout(120);
}

// Three cards, deliberately ragged so alignment has something to fix.
await drawCard(280, 250, 52);
await drawCard(560, 340, 52);
await drawCard(840, 220, 52);
check("three cards drawn", (await boxes()).length, 3);

const centreOf = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const screenCentre = async (i) => {
  const el = await page.locator("[data-node-id]").nth(i).boundingBox();
  return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
};

// ── long-press: the finger's way in ────────────────────────────────────────

await page.keyboard.press("Escape");
await page.waitForTimeout(150);
const c0 = await screenCentre(0);
await press(c0.x, c0.y, 100);
check("a brief press just selects one", await selectedCount(), 1);

const c1 = await screenCentre(1);
await press(c1.x, c1.y, 650);
check("a long press adds a second card", await selectedCount(), 2);

const c2 = await screenCentre(2);
await press(c2.x, c2.y, 650);
check("and a third", await selectedCount(), 3);

await press(c2.x, c2.y, 650);
check("long-pressing again removes it", await selectedCount(), 2);

// ── shift-click: the keyboard's way in ─────────────────────────────────────

await page.keyboard.press("Escape");
await page.waitForTimeout(150);
const shiftClick = async (pt, shift) => {
  const id = ++pid;
  await send([
    { type: "pointerdown", id, kind: "mouse", x: pt.x, y: pt.y, shift },
    { type: "pointerup", id, kind: "mouse", x: pt.x, y: pt.y, shift },
  ]);
  await page.waitForTimeout(180);
};
await shiftClick(await screenCentre(0), false);
check("a plain click selects one", await selectedCount(), 1);
await shiftClick(await screenCentre(1), true);
check("shift-click adds to the selection", await selectedCount(), 2);
await shiftClick(await screenCentre(1), true);
check("shift-clicking again removes it", await selectedCount(), 1);

// ── commands the selection unlocks ─────────────────────────────────────────

await page.keyboard.press("Control+a");
await page.waitForTimeout(250);
check("select-all takes everything", await selectedCount(), 3);
check("the bar reports the count", await page.locator('[class*="selectionCount"]').innerText(), "3 selected");

const ragged = await boxes();
check(
  "the cards start out unaligned",
  new Set(ragged.map((b) => Math.round(centreOf(b).y))).size > 1,
  true,
);

await page.getByRole("button", { name: "Row" }).click();
await page.waitForTimeout(350);
const rowed = await boxes();
check(
  "Row gives every card the same vertical centre",
  new Set(rowed.map((b) => Math.round(centreOf(b).y))).size,
  1,
);
check("and leaves their horizontal spread alone", rowed.map((b) => b.x).join(), ragged.map((b) => b.x).join());

await page.keyboard.press("Control+z");
await page.waitForTimeout(300);
check("one undo reverses the whole alignment", (await boxes()).map((b) => b.y).join(), ragged.map((b) => b.y).join());

await page.keyboard.press("Control+a");
await page.waitForTimeout(200);
await page.getByRole("button", { name: "Column" }).click();
await page.waitForTimeout(350);
const columned = await boxes();
check(
  "Column gives every card the same horizontal centre",
  new Set(columned.map((b) => Math.round(centreOf(b).x))).size,
  1,
);

// Spacing evens the gaps along whichever axis is more spread out.
await page.getByRole("button", { name: "Space" }).click();
await page.waitForTimeout(350);
const spaced = (await boxes()).sort((a, b) => a.y - b.y);
const gaps = spaced.slice(1).map((b, i) => Math.round(b.y - (spaced[i].y + spaced[i].h)));
check("Space evens the gaps", new Set(gaps).size, 1);

// ── moving several at once ─────────────────────────────────────────────────

const beforeDrag = await boxes();
const dragFrom = await screenCentre(0);
const id = ++pid;
await send([
  { type: "pointerdown", id, x: dragFrom.x, y: dragFrom.y, w: 50 },
  ...Array.from({ length: 8 }, (_, i) => ({
    type: "pointermove", id, w: 50, x: dragFrom.x + (i + 1) * 15, y: dragFrom.y + (i + 1) * 5,
  })),
  { type: "pointerup", id, x: dragFrom.x + 120, y: dragFrom.y + 40, w: 50 },
]);

await page.waitForTimeout(350);
const afterDrag = await boxes();
check(
  "dragging one selected card moves them all together",
  afterDrag.map((b, i) => [Math.round(b.x - beforeDrag[i].x), Math.round(b.y - beforeDrag[i].y)].join()).join(" "),
  afterDrag.map(() => [120, 40].join()).join(" "),
);

await page.keyboard.press("Control+z");
await page.waitForTimeout(300);
check("and one undo brings them all back", (await boxes()).map((b) => b.x).join(), beforeDrag.map((b) => b.x).join());

// Deleting acts on the whole selection.
await page.keyboard.press("Control+a");
await page.waitForTimeout(200);
await page.keyboard.press("Backspace");
await page.waitForTimeout(300);
check("delete removes everything selected", (await boxes()).length, 0);

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
