// Loads a .canvas file exercising every part of the spec — all four node types,
// both color forms, edge labels and ends, and unknown keys at node and top
// level — then asserts every one of them survived the trip through the app.
//
// This is the guarantee that lets a file move between MindMap, Obsidian, and an
// AI without quietly losing data.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { BASE_URL, launchBrowser, makeChecker, readPersistedCanvas } from "./_harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "sample.canvas");

const { check, finish } = makeChecker();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

// Named by what it accepts: there is a second file input for pictures, and
// "the file input" stopped being unambiguous the day it arrived.
await page.locator('input[type="file"][accept*=".canvas"]').setInputFiles(fixture);
await page.waitForTimeout(900);

check("all five nodes rendered", await page.locator("[data-node-id]").count(), 5);
check("both edges rendered", await page.locator("[data-edge-id]").count(), 2);
check(
  "canvas name taken from filename",
  await page.locator('input[aria-label="Canvas name"]').inputValue(),
  "sample",
);

const saved = await readPersistedCanvas(page);
const original = JSON.parse(readFileSync(fixture, "utf8"));
const byId = Object.fromEntries(saved.nodes.map((n) => [n.id, n]));

check("group node preserved with its label", [byId.a4?.type, byId.a4?.label], ["group", "Later"]);
check("group backgroundStyle preserved", byId.a4?.backgroundStyle, "cover");
check("file node keeps file and subpath", [byId.a5?.file, byId.a5?.subpath], [
  "notes/Ideas.md",
  "#Open questions",
]);
check("link node keeps url", byId.a3?.url, "https://jsoncanvas.org");
check("hex color preserved verbatim", byId.a3?.color, "#8b5cf6");
check("preset color preserved as a number string", byId.a1?.color, "4");
check("another app's unknown node key survives", byId.a5?.obsidianOnlyKey, { nested: true });

const e1 = saved.edges.find((e) => e.id === "e1");
const e2 = saved.edges.find((e) => e.id === "e2");
check("edge label preserved", e1?.label, "how");
check("edge sides preserved", [e1?.fromSide, e1?.toSide], ["right", "left"]);
check("edge toEnd:none preserved", e2?.toEnd, "none");
check("edge color preserved", e2?.color, "3");

check(
  "node geometry unchanged",
  [byId.a1.x, byId.a1.y, byId.a1.width, byId.a1.height],
  [original.nodes[0].x, original.nodes[0].y, original.nodes[0].width, original.nodes[0].height],
);
check("unknown top-level key survives", saved.someFutureTopLevelKey, 42);
check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
