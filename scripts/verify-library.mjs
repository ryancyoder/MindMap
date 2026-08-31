// Card sizing and the map library.
//
// The library exists to stop work disappearing, so the checks that matter most
// here are the losing ones: that "New" does not strand the map you were on,
// that switching maps keeps an edit made a moment earlier (autosave is
// debounced, so this is a real race), and that deleting the open map leaves
// something open rather than a blank void.

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
          pointerId: e.id, pointerType: e.kind ?? "pen", isPrimary: true,
          clientX: e.x, clientY: e.y, width: e.w ?? 1, height: e.w ?? 1,
          pressure: e.type === "pointerup" ? 0 : 0.5, bubbles: true, cancelable: true,
        }),
      );
    }
  }, { evs: events, sel: selector });

async function drawCard(cx, cy, r = 90) {
  const evs = [{ type: "pointerdown", id: 9, x: cx + r, y: cy }];
  for (let i = 1; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    evs.push({ type: "pointermove", id: 9, x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  evs.push({ type: "pointerup", id: 9, x: cx + r, y: cy });
  await send(evs);
  await page.waitForTimeout(280);
}

const cardBox = () =>
  page.evaluate(() => {
    const n = document.querySelector("[data-node-id]");
    return n ? { w: parseFloat(n.style.width), h: parseFloat(n.style.height) } : null;
  });
const nodeCount = () => page.locator("[data-node-id]").count();
/** Just the map names, not the whole row's concatenated text. */
const mapNames = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-map-id]")].map((el) => {
      const name = el.querySelector('[class*="mapName"]');
      const badge = name?.querySelector('[class*="mapBadge"]');
      const text = name ? name.textContent : "";
      return badge ? text.replace(badge.textContent, "").trim() : text.trim();
    }),
  );

// ── auto-fit ───────────────────────────────────────────────────────────────

await drawCard(400, 420, 42);

// A card says one thing, so it says it in the middle — and the box you type
// into has to sit exactly where the words will sit, or opening a card jogs
// them upward and closing it drops them back. A textarea cannot centre its own
// contents, so it is sized to them and the card's own centring places it.
await page.keyboard.type("Centred");
await page.waitForTimeout(250);
check(
  "the text and the box you type it into are both centred on the card",
  await page.evaluate(() => {
    const card = document.querySelector("[data-node-id]").getBoundingClientRect();
    const box = document.querySelector("textarea").getBoundingClientRect();
    return {
      vertical: Math.abs(box.top + box.height / 2 - (card.top + card.height / 2)) < 2,
      shorterThanTheCard: box.height < card.height - 20,
      centred: getComputedStyle(document.querySelector("textarea")).textAlign,
    };
  }),
  { vertical: true, shorterThanTheCard: true, centred: "center" },
);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check(
  "and the words do not move when the box goes away",
  await page.evaluate(() => {
    const card = document.querySelector("[data-node-id]").getBoundingClientRect();
    const text = document.querySelector('[class*="nodeText"]').getBoundingClientRect();
    return Math.abs(text.top + text.height / 2 - (card.top + card.height / 2)) < 2;
  }),
  true,
);

await page.locator("[data-node-id]").first().click();
await page.waitForTimeout(200);
await page.getByRole("button", { name: "Edit", exact: true }).click();
await page.waitForTimeout(250);
await page.keyboard.press("Control+a");
const before = await cardBox();
await page.keyboard.type(
  "A deliberately long thought that will not fit on one line inside a card this size, and must not be clipped away where it cannot be read.",
);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
const after = await cardBox();
check("a long note grows the card", after.h > before.h, true);

check(
  "the grown card is tall enough for its text",
  await page.evaluate(() => {
    const n = document.querySelector("[data-node-id]");
    const t = n.querySelector('[class*="nodeText"]');
    // Compare the text box against itself: measuring against the card's
    // clientHeight ignores the card's padding and hid real clipping.
    return t.scrollHeight <= t.clientHeight + 2;
  }),
  true,
);

// ── manual resize ──────────────────────────────────────────────────────────
// The card is still selected from being drawn, so the grip should be showing.

const grip = await page.locator("[data-resize-handle]").count();
check("the selected card shows a resize grip", grip, 1);

const beforeResize = await cardBox();
const box = await page.locator("[data-resize-handle]").boundingBox();
const gx = box.x + box.width / 2;
const gy = box.y + box.height / 2;
await send(
  [
    { type: "pointerdown", id: 21, kind: "touch", w: 50, x: gx, y: gy },
    ...Array.from({ length: 8 }, (_, i) => ({
      type: "pointermove", id: 21, kind: "touch", w: 50, x: gx + (i + 1) * 10, y: gy + (i + 1) * 5,
    })),
    { type: "pointerup", id: 21, kind: "touch", w: 50, x: gx + 80, y: gy + 40 },
  ],
  "[data-resize-handle]",
);
await page.waitForTimeout(280);
const afterResize = await cardBox();
check("dragging the grip resizes the card", [
  Math.round(afterResize.w - beforeResize.w), Math.round(afterResize.h - beforeResize.h),
], [80, 40]);
check("resized dimensions are whole numbers", [
  Number.isInteger(afterResize.w), Number.isInteger(afterResize.h),
], [true, true]);

await page.keyboard.press("Control+z");
await page.waitForTimeout(250);
check("one undo reverses the whole resize", (await cardBox()).w, beforeResize.w);

// ── the library ────────────────────────────────────────────────────────────

await page.getByRole("button", { name: "Maps" }).click();
await page.waitForTimeout(400);
check("the library lists the current map", (await mapNames()).length, 1);
check("the open map is marked", await page.locator("text=open").count() >= 1, true);

// Rename it, so it is identifiable after switching.
await page.getByRole("button", { name: "Rename" }).first().click();
await page.locator('input[aria-label="Map name"]').fill("First map");
await page.getByRole("button", { name: "Save", exact: true }).click();
await page.waitForTimeout(400);
check("renaming a map sticks", (await mapNames())[0], "First map");

// A new map must not strand the first one.
await page.getByRole("button", { name: "New map" }).click();
await page.waitForTimeout(500);
check("a new map starts empty", await nodeCount(), 0);

await page.getByRole("button", { name: "Maps" }).click();
await page.waitForTimeout(400);
const names = await mapNames();
check("both maps are listed", names.length, 2);
check("the first map survived New", names.includes("First map"), true);

// The debounced-autosave race: switch immediately after an edit.
await page.getByRole("button", { name: "Done" }).click();
await page.waitForTimeout(200);
await drawCard(500, 500, 70);
await page.keyboard.type("Written just before switching");
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "Maps" }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: /First map/ }).click();
await page.waitForTimeout(600);
check("switching maps loads the other map", await nodeCount(), 1);

await page.getByRole("button", { name: "Maps" }).click();
await page.waitForTimeout(400);
await page.locator("[data-map-id]").filter({ hasText: "Untitled" }).first()
  .locator('button[class*="mapOpen"]').click();
await page.waitForTimeout(700);
check("the edit made moments before switching survived", await nodeCount(), 1);
check(
  "its text survived too",
  (await page.locator("[data-node-id]").first().innerText()).includes("Written just before switching"),
  true,
);

// Deleting the open map must leave something open.
await page.getByRole("button", { name: "Maps" }).click();
await page.waitForTimeout(400);
const openRow = page.locator("[data-map-id]").filter({ hasText: "open" }).first();
await openRow.getByRole("button", { name: "Delete" }).click();
await openRow.getByRole("button", { name: "Really delete" }).click();
await page.waitForTimeout(700);
check("deleting the open map leaves one behind", (await mapNames()).length, 1);
check("and something is still open", await page.locator('[class*="mapBadge"]').count(), 1);

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
