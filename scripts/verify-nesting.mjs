// Folding part of a map into a map of its own, and unfolding it again.
//
// The two things worth being strict about:
//
//  - Nothing is orphaned. Edges that crossed the boundary have to end up on the
//    doorway, or the parent silently loses connections it used to show.
//  - Folding is reversible. Unfold has to restore the original wiring, not
//    guess at it — which is why folding records which card each crossing edge
//    came from, rather than reattaching everything to whatever is first.
//
// The doorway is a spec `file` node, so a round trip through .canvas is checked
// too: Obsidian must see an ordinary file card, not something invented.

import { BASE_URL, launchBrowser, makeChecker } from "./_harness.mjs";

const { check, finish } = makeChecker();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

const counts = async () => ({
  nodes: await page.locator("[data-node-id]").count(),
  edges: await page.locator("[data-edge-id]").count(),
});
const doorways = () => page.locator('[class*="doorwayNode"]').count();

async function load(doc) {
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await page.waitForTimeout(200);
  await page.locator('textarea[aria-label="Canvas JSON"]').fill(JSON.stringify(doc));
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Open as new map" }).click();
  await page.waitForTimeout(800);
}

/** What Save .canvas would write for the map currently open. */
const savedDoc = () =>
  page.evaluate(async () => {
    const req = indexedDB.open("MindMapDB");
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const all = await new Promise((res, rej) => {
      const r = db.transaction("canvases").objectStore("canvases").getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    all.sort((a, b) => b.updated.localeCompare(a.updated));
    const open = localStorage.getItem("mindmap_last_opened");
    return (all.find((c) => c.id === open) ?? all[0]).doc;
  });

const selectByText = async (text) => {
  await page.locator("[data-node-id]", { hasText: text }).first().click();
  await page.waitForTimeout(200);
};

// A trunk with a three-card branch hanging off it.
await load({
  nodes: [
    { id: "root", type: "text", text: "Trunk", x: -600, y: 0, width: 200, height: 80 },
    { id: "other", type: "text", text: "Sibling", x: -600, y: 200, width: 200, height: 80 },
    { id: "b1", type: "text", text: "Branch top", x: 100, y: -160, width: 200, height: 80 },
    { id: "b2", type: "text", text: "Branch middle", x: 100, y: 0, width: 200, height: 80 },
    { id: "b3", type: "text", text: "Branch leaf", x: 100, y: 160, width: 200, height: 80 },
  ],
  edges: [
    { id: "e_in", fromNode: "root", fromSide: "right", toNode: "b1", toSide: "left", label: "into the branch" },
    { id: "e_b12", fromNode: "b1", toNode: "b2" },
    { id: "e_b23", fromNode: "b2", toNode: "b3" },
    { id: "e_back", fromNode: "b3", toNode: "other" },
  ],
});
check("the map starts flat", await counts(), { nodes: 5, edges: 4 });

// ── fold ───────────────────────────────────────────────────────────────────

await selectByText("Branch top");
await page.keyboard.down("Shift");
await selectByText("Branch middle");
await selectByText("Branch leaf");
await page.keyboard.up("Shift");
await page.waitForTimeout(200);
check("three cards selected", await page.locator('[class*="nodeSelected"]').count(), 3);

await page.getByRole("button", { name: "Fold", exact: true }).click();
await page.waitForTimeout(900);

check("the branch is replaced by one card", (await counts()).nodes, 3);
check("and that card is a doorway", await doorways(), 1);
check(
  "both crossing edges survive, rewired to it",
  (await counts()).edges,
  2,
);

const folded = await savedDoc();
const door = folded.nodes.find((n) => n.type === "file");
check("the doorway is a spec file node", [door?.type, /\.canvas$/.test(door?.file ?? "")], ["file", true]);
check("named after what was folded", door.file, "Branch top.canvas");
check("carrying a stable library id", typeof door["x-mindmap-canvas"], "string");
check(
  "every edge still points at a card that exists",
  folded.edges.every((e) =>
    folded.nodes.some((n) => n.id === e.fromNode) && folded.nodes.some((n) => n.id === e.toNode),
  ),
  true,
);
check(
  "the edge label survived the rewiring",
  folded.edges.find((e) => e.id === "e_in")?.label,
  "into the branch",
);

check("the doorway shows what is inside", await page.locator('[class*="doorwayMeta"]').innerText(), "3 cards");

// ── walking in and out ─────────────────────────────────────────────────────

await page.locator('[class*="doorwayOpen"]').click();
await page.waitForTimeout(900);
const insideTexts = () => page.locator("[data-node-id]").allInnerTexts();
check(
  "opening it shows the folded cards, not the parent's",
  (await insideTexts()).join(" | "),
  "Branch top | Branch middle | Branch leaf",
);
check("with the edges that were internal to them", (await counts()).edges, 2);
check("and a trail back", await page.locator('[class*="trailStep"]').count(), 1);

// An edit inside must survive coming back out.
await page.locator("[data-node-id]", { hasText: "Branch leaf" }).first().click();
await page.waitForTimeout(200);
await page.getByRole("button", { name: "Edit", exact: true }).click();
await page.waitForTimeout(300);
await page.keyboard.press("Control+a");
await page.keyboard.type("Edited inside");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

await page.locator('[class*="trailStep"]').first().click();
await page.waitForTimeout(900);
check(
  "the trail takes you back to the parent",
  (await page.locator("[data-node-id]").allInnerTexts()).join(" ").includes("Trunk"),
  true,
);
check("which still has its doorway", await doorways(), 1);

await page.locator('[class*="doorwayOpen"]').click();
await page.waitForTimeout(900);
check(
  "and the edit made inside was kept",
  (await page.locator("[data-node-id]").allInnerTexts()).join(" ").includes("Edited inside"),
  true,
);
await page.locator('[class*="trailStep"]').first().click();
await page.waitForTimeout(900);

// ── unfold ─────────────────────────────────────────────────────────────────

await page.locator('[class*="doorwayNode"]').first().click();
await page.waitForTimeout(250);
await page.getByRole("button", { name: "Unfold" }).click();
await page.waitForTimeout(900);

check("unfolding brings the cards back", (await counts()).nodes, 5);
check("with every edge restored", (await counts()).edges, 4);
check("and no doorway left", await doorways(), 0);

const unfolded = await savedDoc();
const texts = unfolded.nodes.map((n) => n.text).filter(Boolean);
check("the edit made inside came back out too", texts.includes("Edited inside"), true);
check(
  "no edge dangles after unfolding",
  unfolded.edges.every((e) =>
    unfolded.nodes.some((n) => n.id === e.fromNode) && unfolded.nodes.some((n) => n.id === e.toNode),
  ),
  true,
);

// The wiring must be restored, not guessed: the trunk reattaches to the card it
// originally pointed at, not merely to whichever came first.
const trunk = unfolded.nodes.find((n) => n.text === "Trunk");
const intoBranch = unfolded.edges.find((e) => e.fromNode === trunk.id);
const reattached = unfolded.nodes.find((n) => n.id === intoBranch?.toNode);
check("the original wiring is restored, not guessed", reattached?.text, "Branch top");

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
