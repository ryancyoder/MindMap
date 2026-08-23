// Two-finger double-tap undoes; three-finger double-tap redoes.
//
// The risk with these is false positives, not misses: a pinch that barely
// moves, or a slow two-finger rest, must never quietly undo your work. So most
// of what follows checks that the gesture declines — and the movement test
// measures each finger against where it landed, not against the previous
// frame, because slow drift hides under a per-frame delta.

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
          pointerId: e.id, pointerType: e.kind ?? "touch", isPrimary: e.id === 1,
          clientX: e.x, clientY: e.y, width: e.w ?? 1, height: e.w ?? 1,
          pressure: e.type === "pointerup" ? 0 : 0.5, bubbles: true, cancelable: true,
        }),
      );
    }
  }, events);

const nodeCount = () => page.locator("[data-node-id]").count();
let pid = 200;

/** N fingers down and up together, optionally drifting `drift` px each. */
async function multiTap(fingers, { drift = 0, holdMs = 0, y = 700 } = {}) {
  const ids = Array.from({ length: fingers }, () => ++pid);
  const xs = ids.map((_, i) => 400 + i * 90);
  await send(ids.map((id, i) => ({ type: "pointerdown", id, x: xs[i], y })));
  if (drift) {
    await send(ids.map((id, i) => ({ type: "pointermove", id, x: xs[i] + drift, y })));
  }
  if (holdMs) await page.waitForTimeout(holdMs);
  await send(ids.map((id, i) => ({ type: "pointerup", id, x: xs[i] + drift, y })));
  await page.waitForTimeout(70);
}
const multiDoubleTap = async (fingers, opts) => {
  await multiTap(fingers, opts);
  await multiTap(fingers, opts);
  await page.waitForTimeout(250);
};

// No text is typed: committing text is its own history entry, so a card with
// text costs two undos and the counts below would not line up with the
// gesture being tested.
async function drawCard(cx, cy, r) {
  const evs = [{ type: "pointerdown", id: 9, kind: "pen", x: cx + r, y: cy }];
  for (let i = 1; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    evs.push({ type: "pointermove", id: 9, kind: "pen", x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  evs.push({ type: "pointerup", id: 9, kind: "pen", x: cx + r, y: cy });
  await send(evs);
  await page.waitForTimeout(280);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}

await drawCard(300, 260, 55);
await drawCard(700, 260, 55);
check("two cards to work with", await nodeCount(), 2);

// ── undo and redo ──────────────────────────────────────────────────────────

await multiDoubleTap(2);
check("two-finger double-tap undoes", await nodeCount(), 1);

await multiDoubleTap(2);
check("again, undoing further", await nodeCount(), 0);

await multiDoubleTap(3);
check("three-finger double-tap redoes", await nodeCount(), 1);

await multiDoubleTap(3);
check("again, redoing further", await nodeCount(), 2);

// Past the end it should say so rather than do something surprising.
await multiDoubleTap(3);
check("redoing past the end changes nothing", await nodeCount(), 2);
check(
  "and says so",
  (await page.locator('[class*="toasts"] > div').last().innerText())
    .toLowerCase()
    .includes("nothing to redo"),
  true,
);

// ── gestures that must NOT fire ────────────────────────────────────────────

const steady = await nodeCount();

await multiTap(2);
await page.waitForTimeout(500);
check("a single two-finger tap does nothing", await nodeCount(), steady);

await multiTap(2);
await page.waitForTimeout(600); // beyond the pairing window
await multiTap(2);
await page.waitForTimeout(300);
check("two slow two-finger taps do not pair", await nodeCount(), steady);

// A pinch that barely moves is the dangerous false positive.
await multiDoubleTap(2, { drift: 20 });
check("a two-finger gesture that drifted does not undo", await nodeCount(), steady);

// Resting two fingers and lifting later is not a tap either.
await multiDoubleTap(2, { holdMs: 420 });
check("a slow two-finger rest does not undo", await nodeCount(), steady);

// Mixed finger counts must not pair with each other.
await multiTap(2);
await multiTap(3);
await page.waitForTimeout(300);
check("a two-finger tap then a three-finger tap does not pair", await nodeCount(), steady);

// And one finger still belongs to selection and zoom, not undo.
const id = ++pid;
await send([{ type: "pointerdown", id, x: 500, y: 700, w: 50 }, { type: "pointerup", id, x: 500, y: 700, w: 50 }]);
await send([{ type: "pointerdown", id: id + 1, x: 500, y: 700, w: 50 }, { type: "pointerup", id: id + 1, x: 500, y: 700, w: 50 }]);
await page.waitForTimeout(400);
check("a one-finger double-tap does not undo", await nodeCount(), steady);

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
