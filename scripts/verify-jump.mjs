// ⌘K — jump to a map, or to a card in the map you are on.
//
// Matching is by subsequence, not substring: "pgest" should find "Pencil
// gestures", because a palette is for typing what you remember rather than
// what is written.
//
// The keystroke-routing check near the end is the one that earns its place.
// iPadOS refuses focus() for a moment after a metaKey combination, so a palette
// opened with ⌘K can be one you cannot type into — a failure that looks like
// the feature simply not working.

import { BASE_URL, launchBrowser, makeChecker } from "./_harness.mjs";

const { check, finish } = makeChecker();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

const openPalette = () => page.locator('[class*="jumpInput"]').count();
const rows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-jump-kind]")].map((el) => ({
      kind: el.dataset.jumpKind,
      label: el.querySelector('[class*="jumpLabel"]').textContent,
      active: /jumpRowActive/.test(el.className),
    })),
  );
const mapName = () => page.locator('input[aria-label="Canvas name"]').inputValue();

async function loadMap(name, doc) {
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await page.waitForTimeout(200);
  await page.locator('textarea[aria-label="Canvas JSON"]').fill(JSON.stringify(doc));
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Open as new map" }).click();
  await page.waitForTimeout(700);
  await page.locator('input[aria-label="Canvas name"]').fill(name);
  await page.waitForTimeout(600); // let autosave settle
}

const card = (id, text, x, y) => ({ id, type: "text", text, x, y, width: 220, height: 80 });

await loadMap("Pencil gestures", {
  nodes: [card("a", "Recognizer thresholds", 0, 0), card("b", "Palm rejection", 0, 200)],
  edges: [],
});
await loadMap("Cloud library", {
  nodes: [card("c", "Supabase schema", 0, 0), card("d", "Agent proposals", 0, 200)],
  edges: [],
});
await loadMap("Quarterly planning", {
  nodes: [card("e", "Hiring", 0, 0), card("f", "Budget review", 0, 200)],
  edges: [],
});
check("three maps to jump between", await mapName(), "Quarterly planning");

// ── opening and closing ────────────────────────────────────────────────────

await page.keyboard.press("Control+k");
await page.waitForTimeout(300);
check("Control-K opens the palette", await openPalette(), 1);
check("it lists maps before anything is typed", (await rows()).length > 0, true);

await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check("Escape closes it", await openPalette(), 0);

await page.keyboard.press("Control+k");
await page.waitForTimeout(250);
await page.keyboard.press("Control+k");
await page.waitForTimeout(250);
check("Control-K again closes it", await openPalette(), 0);

// ── finding a map ──────────────────────────────────────────────────────────

await page.keyboard.press("Control+k");
await page.waitForTimeout(250);
await page.keyboard.type("cloud");
await page.waitForTimeout(300);
const cloudRows = await rows();
check("typing a map's name finds it", cloudRows[0].label, "Cloud library");
check("and it is a map result", cloudRows[0].kind, "map");
check("the first result starts selected", cloudRows[0].active, true);

await page.keyboard.press("Enter");
await page.waitForTimeout(900);
check("Enter jumps to that map", await mapName(), "Cloud library");
check("and the palette closes", await openPalette(), 0);

// ── subsequence matching, not substring ────────────────────────────────────

await page.keyboard.press("Control+k");
await page.waitForTimeout(250);
await page.keyboard.type("pgest");
await page.waitForTimeout(300);
const fuzzy = await rows();
check("a subsequence query still finds the map", fuzzy[0]?.label, "Pencil gestures");

await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ── finding a card in the map you are on ───────────────────────────────────

await page.keyboard.press("Control+k");
await page.waitForTimeout(250);
await page.keyboard.type("agent");
await page.waitForTimeout(300);
const cardRows = await rows();
check("typing a card's text finds the card", cardRows[0].label, "Agent proposals");
check("and it is a card result", cardRows[0].kind, "card");

await page.keyboard.press("Enter");
await page.waitForTimeout(700);
check("jumping to a card stays in the same map", await mapName(), "Cloud library");
check(
  "and selects it",
  await page.evaluate(() => {
    const el = document.querySelector('[class*="nodeSelected"]');
    return el ? el.innerText.trim() : "";
  }),
  "Agent proposals",
);

// ── arrow keys ─────────────────────────────────────────────────────────────

await page.keyboard.press("Control+k");
await page.waitForTimeout(250);
await page.keyboard.type("a");
await page.waitForTimeout(300);
const before = await rows();
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(200);
const after = await rows();
check("arrow down moves the selection", [before[0].active, after[0].active, after[1].active], [true, false, true]);
await page.keyboard.press("ArrowUp");
await page.waitForTimeout(200);
check("and arrow up moves it back", (await rows())[0].active, true);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ── the iPadOS focus quirk ─────────────────────────────────────────────────
// If the input never took focus, typed characters must still reach the query
// rather than being swallowed. Simulated by blurring after opening.

await page.keyboard.press("Control+k");
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('[class*="jumpInput"]').blur());
await page.waitForTimeout(100);
check(
  "the input can lose focus, as iPadOS sometimes forces",
  await page.evaluate(() => document.activeElement?.className?.includes?.("jumpInput") ?? false),
  false,
);
await page.keyboard.press("q");
await page.keyboard.press("u");
await page.keyboard.press("a");
await page.waitForTimeout(300);
check(
  "keystrokes that miss the input still reach the query",
  await page.locator('[class*="jumpInput"]').inputValue(),
  "qua",
);
check("and still find the map", (await rows())[0]?.label, "Quarterly planning");

await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ── searching every map ────────────────────────────────────────────────────
// Off, cards come only from the map you are on. On, from all of them — and
// jumping to one has to land you in the right map with the card selected.

await page.keyboard.press("Control+k");
await page.waitForTimeout(300);
check("the scope toggle starts off", await page.getByRole("switch").getAttribute("aria-checked"), "false");

await page.keyboard.type("palm");
await page.waitForTimeout(300);
check(
  "a card in another map is not found while scoped to this one",
  (await rows()).some((r) => r.kind === "card" && r.label === "Palm rejection"),
  false,
);

await page.getByRole("switch").click();
await page.waitForTimeout(350);
check("the toggle turns on", await page.getByRole("switch").getAttribute("aria-checked"), "true");

const everywhere = await rows();
const foreign = everywhere.find((r) => r.kind === "card" && r.label === "Palm rejection");
check("now the card in another map is found", Boolean(foreign), true);

check(
  "and the result says which map it is in",
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-jump-kind]")].find(
      (n) => n.querySelector('[class*="jumpLabel"]').textContent === "Palm rejection",
    );
    return el.querySelector('[class*="jumpMeta"]').textContent;
  }),
  "in Pencil gestures",
);

// Jump to it: the map has to change and the card has to be selected.
await page.evaluate(() => {
  const el = [...document.querySelectorAll("[data-jump-kind]")].find(
    (n) => n.querySelector('[class*="jumpLabel"]').textContent === "Palm rejection",
  );
  el.click();
});
await page.waitForTimeout(1100);
check("jumping across maps opens the other map", await mapName(), "Pencil gestures");
check(
  "with the card selected",
  await page.evaluate(() => {
    const el = document.querySelector('[class*="nodeSelected"]');
    return el ? el.innerText.trim() : "";
  }),
  "Palm rejection",
);
check("and the palette closed", await openPalette(), 0);

// Cards in the map you are on still say so, not the map's name.
await page.keyboard.press("Control+k");
await page.waitForTimeout(300);
await page.keyboard.type("recognizer");
await page.waitForTimeout(300);
check(
  "a card in the open map is still labelled as here",
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-jump-kind]")].find(
      (n) => n.querySelector('[class*="jumpLabel"]').textContent === "Recognizer thresholds",
    );
    return el.querySelector('[class*="jumpMeta"]').textContent;
  }),
  "in this map",
);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// The choice is remembered.
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.keyboard.press("Control+k");
await page.waitForTimeout(350);
check(
  "the scope choice survives a reload",
  await page.getByRole("switch").getAttribute("aria-checked"),
  "true",
);
await page.getByRole("switch").click();
await page.waitForTimeout(250);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ── the touch way in ───────────────────────────────────────────────────────

await page.getByRole("button", { name: "Maps" }).click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: "Search" }).click();
await page.waitForTimeout(400);
check("the Maps sheet offers the same palette, for touch", await openPalette(), 1);
await page.keyboard.press("Escape");

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
