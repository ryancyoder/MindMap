// Pictures on cards.
//
// Three things could break here and look fine in a smaller check:
//
//  1. The photo. A camera on an iPad produces a 12-megapixel JPEG several
//     megabytes long. A 1x1 test pixel would pass every assertion below while
//     proving nothing about the size cap that keeps a map's rows sane, so the
//     picture fed in here is generated at real camera dimensions and the check
//     asserts the original really was that big before asserting what became
//     of it.
//  2. The storage decision. The bytes live beside the document, never in it —
//     that is the whole reason the card holds an id. A check that only looked
//     at the screen would not notice a regression that inlined the photo and
//     made every .canvas file unreadable, so the persisted document is asserted
//     to contain no image data at all.
//  3. The id. Folding renames nothing, unfolding renames every incoming id, and
//     both have to leave the picture attached to the same card.
//
// It runs at an iPad's portrait shape rather than a wide desktop one, because
// that is the device this app is for.

import { BASE_URL, launchBrowser, makeChecker } from "./_harness.mjs";

const { check, finish } = makeChecker();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 834, height: 1194 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

// ── helpers ────────────────────────────────────────────────────────────────

/** A JPEG of the size and busyness a camera actually produces. */
const makePhoto = (w, h) =>
  page.evaluate(
    ([width, height]) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, "#2a6f4b");
      gradient.addColorStop(1, "#c8a24d");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      // Noise, so the encoder cannot cheat its way to a tiny file the way it
      // would on a flat colour — a real photograph does not compress like that.
      for (let i = 0; i < 4000; i++) {
        ctx.fillStyle = `hsl(${(i * 37) % 360} 60% ${30 + (i % 50)}%)`;
        ctx.fillRect((i * 97) % width, (i * 211) % height, 40, 40);
      }
      return canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
    },
    [w, h],
  );

const bufferOf = (base64) => Buffer.from(base64, "base64");

/** Drive the real control: the button opens a chooser, the chooser takes a file. */
const pickPhoto = async (base64, name = "photo.jpg") => {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Photo", exact: true }).click(),
  ]);
  await chooser.setFiles({ name, mimeType: "image/jpeg", buffer: bufferOf(base64) });
  // A 12-megapixel decode and re-encode is real work, and autosave is debounced
  // on top of it — this is the wait for both, not for the render.
  await page.waitForTimeout(2000);
};

/** Drop a picture on the canvas at a point, the way a file from Files arrives. */
const dropPhoto = (base64, x, y) =>
  page
    .evaluate(
      ([b64, dropX, dropY]) => {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const file = new File([bytes], "dropped.jpg", { type: "image/jpeg" });
        const data = new DataTransfer();
        data.items.add(file);

        const surface = document.querySelector('[class*="surface"]');
        const box = surface.getBoundingClientRect();
        const init = {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
          clientX: box.left + dropX,
          clientY: box.top + dropY,
        };
        surface.dispatchEvent(new DragEvent("dragover", init));
        surface.dispatchEvent(new DragEvent("drop", init));
      },
      [base64, x, y],
    )
    .then(() => page.waitForTimeout(1500));

/** Paste a picture, the way ⌘V delivers a screenshot. */
const pastePhoto = (base64) =>
  page
    .evaluate((b64) => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], "pasted.jpg", { type: "image/jpeg" });
      const data = new DataTransfer();
      data.items.add(file);
      document.body.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
      );
    }, base64)
    .then(() => page.waitForTimeout(1500));

/**
 * What is actually on disk for the open map.
 *
 * Autosave is debounced, so reading straight after an edit reads the state
 * before it — which looks exactly like the edit not happening. The wait is part
 * of the read for that reason, not an arbitrary pause.
 */
const openDoc = async () => {
  await page.waitForTimeout(900);
  return page.evaluate(async () => {
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
};

/** The picture actually held on this device, by key. */
const storedImage = (key) =>
  page.evaluate(async (imageKey) => {
    const req = indexedDB.open("MindMapDB");
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    if (!db.objectStoreNames.contains("images")) return null;
    const row = await new Promise((res, rej) => {
      const r = db.transaction("images").objectStore("images").get(imageKey);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!row) return null;
    const size = await new Promise((res) => {
      const img = new Image();
      img.onload = () => res({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => res(null);
      img.src = row.dataUrl;
    });
    return { length: row.dataUrl.length, prefix: row.dataUrl.slice(0, 15), ...size };
  }, key);

const imgCount = () => page.locator("[data-node-id] img").count();
const nodeCount = () => page.locator("[data-node-id]").count();
const keyed = (doc) => doc.nodes.filter((n) => n["x-mindmap-image"]);

// ── a card made from a photo ───────────────────────────────────────────────

const PORTRAIT = await makePhoto(3024, 4032);
check(
  "the picture fed in is the size a camera makes",
  bufferOf(PORTRAIT).byteLength > 400_000,
  true,
);

await pickPhoto(PORTRAIT);

check("a card appears", await nodeCount(), 1);
check("with the picture drawn on it", await imgCount(), 1);

let doc = await openDoc();
check("and the card carries an image id", keyed(doc).length, 1);

const portraitNode = keyed(doc)[0];
check(
  "a tall photo makes a tall card",
  portraitNode.height > portraitNode.width,
  true,
);

const stored = await storedImage(portraitNode["x-mindmap-image"]);
check("the picture is on the device", stored !== null, true);
check("stored as an image data URL", stored?.prefix, "data:image/jpeg");
check(
  "resized to the cap on its long edge",
  Math.max(stored?.width ?? 0, stored?.height ?? 0) <= 1600,
  true,
);
check(
  "and it kept the photo's proportions",
  Math.abs(stored.width / stored.height - 3024 / 4032) < 0.01,
  true,
);
check(
  "the stored picture is a fraction of the original",
  stored.length < bufferOf(PORTRAIT).byteLength,
  true,
);

// The point of holding an id rather than the bytes: the document stays text a
// person can read and an agent can rewrite.
check(
  "no image data reaches the document",
  JSON.stringify(doc).includes("data:image"),
  false,
);

// ── a picture on a card that already says something ────────────────────────

await page.keyboard.press("Escape");
await page.getByRole("button", { name: "New", exact: true }).click();
await page.waitForTimeout(600);

// Draw a card and write in it, so this is a card with words on it rather than
// a bare rectangle.
const drawCard = async (cx, cy) => {
  const r = 60;
  await page.mouse.move(cx + r, cy);
  await page.mouse.down();
  for (let a = 0; a <= 360; a += 12) {
    const rad = (a * Math.PI) / 180;
    await page.mouse.move(cx + r * Math.cos(rad), cy + r * Math.sin(rad));
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
};

await drawCard(400, 420);
await page.keyboard.type("Front bed, south side");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

doc = await openDoc();
const before = doc.nodes[0];
check("the card is there with its words", before.text, "Front bed, south side");

await page.locator("[data-node-id]").first().click();
await page.waitForTimeout(250);

const LANDSCAPE = await makePhoto(1600, 1200);
await pickPhoto(LANDSCAPE);

doc = await openDoc();
check("still one card", doc.nodes.length, 1);
check("the words survived", doc.nodes[0].text, "Front bed, south side");
check("the picture went onto it", Boolean(doc.nodes[0]["x-mindmap-image"]), true);
check("and the card grew to make room", doc.nodes[0].height > before.height, true);
check("the card draws both", await imgCount(), 1);

// One undo, not one per step.
await page.keyboard.press("Meta+z");
await page.waitForTimeout(400);
doc = await openDoc();
check("attaching a picture is a single undo", Boolean(doc.nodes[0]["x-mindmap-image"]), false);
check("and the words are untouched by it", doc.nodes[0].text, "Front bed, south side");

await page.keyboard.press("Meta+Shift+z");
await page.waitForTimeout(400);
doc = await openDoc();
check("redo puts it back", Boolean(doc.nodes[0]["x-mindmap-image"]), true);

// ── taking a picture off ───────────────────────────────────────────────────

await page.locator("[data-node-id]").first().click();
await page.waitForTimeout(250);
await page.getByRole("button", { name: "No photo", exact: true }).click();
await page.waitForTimeout(400);

doc = await openDoc();
check("the picture comes off", Boolean(doc.nodes[0]["x-mindmap-image"]), false);
check("the card stays", doc.nodes.length, 1);
check("and so do its words", doc.nodes[0].text, "Front bed, south side");
check("nothing is drawn on it now", await imgCount(), 0);

await page.keyboard.press("Meta+z");
await page.waitForTimeout(500);
doc = await openDoc();
const restoredKey = doc.nodes[0]["x-mindmap-image"];
check("undo brings the picture back, not just the reference", await imgCount(), 1);
check("from the same key", Boolean(restoredKey), true);

// ── dropped and pasted ─────────────────────────────────────────────────────

await page.getByRole("button", { name: "New", exact: true }).click();
await page.waitForTimeout(600);

const SMALL = await makePhoto(1200, 900);
// Away from the middle of the view, so the card pasted in a moment does not
// land on top of this one.
await dropPhoto(SMALL, 170, 260);

doc = await openDoc();
check("a dropped picture becomes a card", doc.nodes.length, 1);
check("drawn on the canvas", await imgCount(), 1);
const droppedAt = doc.nodes[0];

// Dropped onto that card rather than beside it, it attaches instead.
const cardBox = await page.locator("[data-node-id]").first().boundingBox();
const surfaceBox = await page.locator('[class*="surface"]').first().boundingBox();
await dropPhoto(
  SMALL,
  cardBox.x - surfaceBox.x + cardBox.width / 2,
  cardBox.y - surfaceBox.y + cardBox.height / 2,
);

doc = await openDoc();
check("a picture dropped on a card does not make a second one", doc.nodes.length, 1);
check(
  "it replaces the one that was there",
  doc.nodes[0]["x-mindmap-image"] !== droppedAt["x-mindmap-image"],
  true,
);

await page.keyboard.press("Escape");
await page.waitForTimeout(200);
await pastePhoto(SMALL);

doc = await openDoc();
check("a pasted picture makes a card of its own", doc.nodes.length, 2);
check("both are drawn", await imgCount(), 2);

// ── folding and unfolding keep the picture attached ────────────────────────

// The pasted card, which is the one drawn last and therefore on top.
await page.locator("[data-node-id]").last().click();
await page.waitForTimeout(200);
await page.getByRole("button", { name: "Fold", exact: true }).click();
await page.waitForTimeout(800);

doc = await openDoc();
check("folding leaves a doorway", doc.nodes.some((n) => n.type === "file"), true);

await page.locator('[data-card-action="open"]').first().click();
await page.waitForTimeout(900);
check("the folded card still has its picture", await imgCount(), 1);

// Back out and unfold: every incoming id is renamed, and the key has to follow.
doc = await openDoc();
const insideKey = keyed(doc)[0]?.["x-mindmap-image"];
await page.locator('[class*="trailStep"]').first().click();
await page.waitForTimeout(900);
await page.locator("[data-node-id]").filter({ hasText: "Open ↗" }).first().click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: "Unfold", exact: true }).click();
await page.waitForTimeout(900);

doc = await openDoc();
check("unfolding brings the card back", doc.nodes.length, 2);
check(
  "with the same picture, through renamed ids",
  keyed(doc).some((n) => n["x-mindmap-image"] === insideKey),
  true,
);

// ── it is still there after a reload ───────────────────────────────────────

await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(900);
check("pictures come back with the map", await imgCount(), 2);

check("no page errors", errors, []);

await browser.close();
process.exit(finish() === 0 ? 0 : 1);
