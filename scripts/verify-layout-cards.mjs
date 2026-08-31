// Where a card lands when the app puts it there.
//
// Two halves. slideClear is checked against the module directly — it has no
// imports for exactly that reason, and a sliding algorithm is worth proving
// terminates rather than hoping. The rest drives the app: a stroke has to
// produce a card that is on the grid and clear of its neighbours, and the one
// deliberate overlap in the pen model — a loop drawn inside a card, which is
// how you nest an idea — has to survive.

import { BASE_URL, launchBrowser, makeChecker } from "./_harness.mjs";
import { boxContains, boxesClash, slideClear } from "../src/lib/layout.ts";

const { check, finish } = makeChecker();

const box = (x, y, width = 100, height = 100) => ({ x, y, width, height });

// ── the sliding itself ────────────────────────────────────────────────────

check("a box with room to itself does not move", slideClear(box(0, 0), [box(300, 300)], 20), box(0, 0));
check(
  "touching counts as clashing once padding is asked for",
  boxesClash(box(0, 0), box(110, 0), 20),
  true,
);
check("and stops counting past it", boxesClash(box(0, 0), box(130, 0), 20), false);

check(
  "a box on top of another is pushed clear by the padding",
  slideClear(box(10, 0), [box(0, 0)], 20, { toward: "right" }),
  box(120, 0),
);
check(
  "and can be sent the other way instead",
  slideClear(box(10, 0), [box(0, 0)], 20, { toward: "left" }),
  box(-120, 0),
);
check(
  "left alone it takes the cheapest way out",
  slideClear(box(90, 10), [box(0, 0)], 10).x,
  110,
);

// A row of neighbours: it has to clear all of them, not just the first.
const row = [box(0, 0, 50, 50), box(80, 0, 50, 50), box(160, 0, 50, 50)];
const past = slideClear(box(0, 0, 50, 50), row, 10, { toward: "right" });
check("it slides past a whole row rather than into the next one", past.x, 220);
check(
  "and ends clear of every one of them",
  row.every((r) => !boxesClash(past, r, 10)),
  true,
);

// Boxed in on three sides: moving one way only is what stops it oscillating.
const pen = [box(0, 0, 50, 50), box(0, 60, 50, 50), box(0, 120, 50, 50)];
const escaped = slideClear(box(0, 60, 50, 50), pen, 8, { toward: "right" });
check("hemmed in, it still gets out", pen.every((r) => !boxesClash(escaped, r, 8)), true);

check(
  "a grid keeps the box on it, and never eats the gap",
  slideClear(box(10, 0, 50, 50), [box(0, 0, 45, 50)], 10, { toward: "right", grid: 28 }),
  box(56, 0, 50, 50),
);
check(
  "containment is what tells a nested card from a collision",
  [boxContains(box(0, 0, 200, 200), box(20, 20, 50, 50)), boxContains(box(0, 0, 40, 40), box(20, 20, 50, 50))],
  [true, false],
);

// ── and in the app ────────────────────────────────────────────────────────

const GRID = 28;
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

const stroke = async (points) => {
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(p.x, p.y);
  await page.mouse.up();
  await page.waitForTimeout(200);
};
const circle = (cx, cy, r, n = 40) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });
const line = (x1, y1, x2, y2, n = 24) =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: x1 + ((x2 - x1) * i) / n, y: y1 + ((y2 - y1) * i) / n }));
const esc = async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(250); };
const boxes = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-node-id]")].map((n) => ({
      x: parseFloat(n.style.left), y: parseFloat(n.style.top),
      width: parseFloat(n.style.width), height: parseFloat(n.style.height),
    })),
  );
const anyOverlap = (all) =>
  all.some((a, i) =>
    all.some(
      (b, j) =>
        i !== j &&
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height,
    ),
  );

// Snap is off — a card the app draws lands on the grid regardless.
await stroke(circle(300, 300, 70));
await esc();
const first = (await boxes())[0];
check("a drawn card lands on the grid with Snap off", [first.x % GRID, first.y % GRID], [0, 0]);

// A second loop drawn right on top of the first must not stay there.
await stroke(circle(320, 320, 70));
await esc();
let all = await boxes();
check("a second loop over the first makes a card", all.length, 2);
check("and does not land on top of it", anyOverlap(all), false);
check("still on the grid after being moved clear", [all[1].x % GRID, all[1].y % GRID], [0, 0]);

// A branch flicked barely clear of its parent, downward into open space.
const parent = (await boxes())[0];
await stroke(
  line(parent.x + 30, parent.y + parent.height - 20, parent.x + 30, parent.y + parent.height + 50),
);
await esc();
all = await boxes();
check("a branch adds a card", all.length, 3);
check("and nothing overlaps", anyOverlap(all), false);
check("the branched card is on the grid too", [all[2].x % GRID, all[2].y % GRID], [0, 0]);

// The one deliberate overlap in the pen model: a loop drawn inside a card is
// how an idea is nested, and the recognizer lets it through on purpose.
await stroke(circle(820, 300, 120));
await esc();
const host = (await boxes()).at(-1);
await stroke(circle(host.x + host.width / 2, host.y + host.height / 2, 42));
await esc();
all = await boxes();
check("a loop drawn inside a card still nests", all.length, 5);
const nested = all.at(-1);
check(
  "and is left over the card it was drawn in, not pushed off it",
  nested.x < host.x + host.width &&
    host.x < nested.x + nested.width &&
    nested.y < host.y + host.height &&
    host.y < nested.y + nested.height,
  true,
);

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
