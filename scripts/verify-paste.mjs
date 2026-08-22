// Pasting and copying map JSON.
//
// Text is how a map actually travels between the app and a conversation, so
// this path has to be as trustworthy as the file picker — and it shares the
// same parser, which is what makes that true. The checks that matter are the
// unhappy ones: malformed JSON must say so instead of destroying the open map,
// and replacing a map must stay undoable.

import { BASE_URL, launchBrowser, makeChecker } from "./_harness.mjs";

const { check, finish } = makeChecker();
const browser = await launchBrowser();
const page = await browser.newPage({
  viewport: { width: 1180, height: 860 },
  permissions: ["clipboard-read", "clipboard-write"],
});

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

const nodeCount = () => page.locator("[data-node-id]").count();
const edgeCount = () => page.locator("[data-edge-id]").count();
const openSheet = async () => {
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await page.waitForTimeout(300);
};
const typeJson = async (text) => {
  await page.locator('textarea[aria-label="Canvas JSON"]').fill(text);
  await page.waitForTimeout(250);
};
const status = () => page.locator('[class*="pasteStatus"]').innerText();

const SAMPLE = JSON.stringify({
  nodes: [
    { id: "p1", type: "text", text: "Pasted root", x: 0, y: 0, width: 200, height: 80, color: "4" },
    { id: "p2", type: "text", text: "Pasted child", x: 320, y: -60, width: 200, height: 80 },
    { id: "p3", type: "text", text: "Another", x: 320, y: 80, width: 200, height: 80 },
  ],
  edges: [
    { id: "pe1", fromNode: "p1", fromSide: "right", toNode: "p2", toSide: "left" },
    { id: "pe2", fromNode: "p1", fromSide: "right", toNode: "p3", toSide: "left" },
  ],
});

// ── validation before anything is applied ──────────────────────────────────

await openSheet();
check("the sheet opens with no verdict yet", (await status()).includes("Paste a JSON Canvas"), true);

await typeJson("{ this is not json");
check("malformed JSON is reported", (await status()).toLowerCase().includes("json"), true);
check(
  "and applying it is blocked",
  await page.getByRole("button", { name: "Open as new map" }).isDisabled(),
  true,
);

await typeJson(SAMPLE);
check("a valid map is counted before applying", await status(), "3 cards · 2 links");

// A file with one bad node should still open, and say what it dropped.
await typeJson(JSON.stringify({
  nodes: [
    { id: "ok", type: "text", text: "Fine", x: 0, y: 0, width: 200, height: 80 },
    { id: "bad", type: "sculpture", x: 0, y: 0, width: 10, height: 10 },
  ],
  edges: [],
}));
const partial = await status();
check("a partly-broken file still counts what survived", partial.includes("1 card"), true);
check("and says something was skipped", partial.toLowerCase().includes("skipped"), true);

// ── open as a new map ──────────────────────────────────────────────────────

await typeJson(SAMPLE);
await page.getByRole("button", { name: "Open as new map" }).click();
await page.waitForTimeout(800);
check("pasting as a new map loads the cards", await nodeCount(), 3);
check("and its links", await edgeCount(), 2);

await page.getByRole("button", { name: "Maps" }).click();
await page.waitForTimeout(400);
const names = await page.evaluate(() =>
  [...document.querySelectorAll("[data-map-id]")].map((el) =>
    el.querySelector('[class*="mapName"]').textContent.replace(/open$/i, "").trim(),
  ),
);
check("the pasted map is its own entry", names.some((n) => n.includes("Pasted map")), true);
check("the map it was opened from still exists", names.length >= 2, true);
await page.getByRole("button", { name: "Done" }).click();
await page.waitForTimeout(300);

// ── replace, and undo the replace ──────────────────────────────────────────

await openSheet();
await typeJson(JSON.stringify({
  nodes: [{ id: "solo", type: "text", text: "Only one", x: 0, y: 0, width: 200, height: 80 }],
  edges: [],
}));
await page.getByRole("button", { name: "Replace this map" }).click();
await page.waitForTimeout(600);
check("replacing swaps the map's contents", await nodeCount(), 1);

await page.keyboard.press("Control+z");
await page.waitForTimeout(400);
check("one undo restores what was replaced", await nodeCount(), 3);

// ── copy back out ──────────────────────────────────────────────────────────

await openSheet();
await page.getByRole("button", { name: "Copy this map" }).click();
await page.waitForTimeout(400);
const clipboard = await page.evaluate(() => navigator.clipboard.readText());
let parsed = null;
try { parsed = JSON.parse(clipboard); } catch { /* left null */ }
check("copying produces valid JSON", parsed !== null, true);
check("that round-trips the current map", parsed && parsed.nodes.length, 3);
check(
  "and its geometry is integers, as the spec requires",
  parsed ? parsed.nodes.every((n) => Number.isInteger(n.x) && Number.isInteger(n.width)) : false,
  true,
);

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
